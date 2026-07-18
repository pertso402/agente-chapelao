'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const { extrairMensagem, downloadMidia, enviarTexto, enviarDigitando } = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const {
  carregarHistorico, salvarMensagem,
  carregarRascunho, limparRascunho,
  buscarInfo, atualizarStatusPedido,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido } = require('./agent');
const { comRetry } = require('./utils/retry');
const { normalizar } = require('./utils/pedido');

const app = express();
app.use(express.json({ limit: '10mb' }));

const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ─── DEDUPLICAÇÃO DE MENSAGENS ────────────────────────────────────────────────
const msgProcessadas = new Map();
function jaProcessada(msgId) {
  if (!msgId) return false;
  const agora = Date.now();
  for (const [id, ts] of msgProcessadas) {
    if (agora - ts > 120_000) msgProcessadas.delete(id);
  }
  if (msgProcessadas.has(msgId)) return true;
  msgProcessadas.set(msgId, agora);
  return false;
}

// Confirmações que disparam a criação do pedido.
// Antes isto exigia IGUALDADE EXATA com a frase — "sim, pode confirmar" ou
// "isso mesmo, obrigado" (frases naturais e comuns) NUNCA batiam, deixando
// o pedido travado em aguardando_confirmacao pra sempre (o cliente achava
// que tinha confirmado, mas nada acontecia). Agora aceita a palavra
// afirmativa como INÍCIO da frase, e rejeita explicitamente frases com
// ressalva (deixando "sim, mas troca o refrigerante" cair pro agente).
const CONFIRMACOES_EXATAS = new Set([
  'sim', 'simm', 's', '1', 'confirmar', 'confirma', 'confirmo',
  'pode confirmar', 'pode fechar', 'fechar', 'fechou', 'isso', 'isso mesmo',
  'ta certo', 'certo', 'correto', 'ok', 'okay', 'beleza', 'blz', 'pode ser',
]);
const CONFIRMACOES_PREFIXO = [
  'sim', 'confirmo', 'confirma', 'pode confirmar', 'pode fechar', 'fechar',
  'fechou', 'isso mesmo', 'isso', 'ta certo', 'certo', 'correto', 'beleza', 'pode ser',
];
const RESSALVA = /\b(mas|so que|so quero|quero mudar|muda|troca|corrige|corrigir|errado|espera|pera|calma|antes|na verdade|ainda nao|primeiro)\b/;

function ehConfirmacao(texto) {
  const t = normalizar(String(texto || '')).replace(/[.!,]+$/, '');
  if (!t) return false;
  if (RESSALVA.test(t)) return false;
  if (CONFIRMACOES_EXATAS.has(t)) return true;
  return CONFIRMACOES_PREFIXO.some((p) => t.startsWith(`${p} `) || t.startsWith(`${p},`));
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    agente: 'Chapelão v2',
    vars: {
      supa: !!process.env.SUPA_URL,
      openai: !!process.env.OPENAI_API_KEY,
      evolution: !!process.env.EVOLUTION_URL,
    },
  });
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  const requestId = uuid().slice(0, 8);
  const body = req.body;

  let msg;
  try {
    msg = extrairMensagem(body);
    if (!msg) return;
  } catch (err) {
    logger.error('webhook/extrair', err.message, { requestId, err });
    return;
  }

  const msgId = body?.data?.key?.id;
  if (jaProcessada(msgId)) {
    logger.info('webhook/dedup', 'Mensagem duplicada ignorada', { requestId, msgId });
    return;
  }

  const { telefone, pushName, tipo, mensagemRaw, base64: base64Inline, mimetype: mimetypeInline } = msg;
  let conteudo = msg.texto;

  logger.step(requestId, telefone, 'webhook/recebido', { tipo, pushName, preview: (conteudo || '').slice(0, 60) });

  try {
    // ── Mídia: áudio ───────────────────────────────────────────────────────
    if (tipo === 'audioMessage') {
      logger.step(requestId, telefone, 'midia/audio');
      let b64 = base64Inline, mime = mimetypeInline || 'audio/ogg';
      if (!b64) {
        const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadAudio' });
        b64 = m.base64; mime = m.mimetype || 'audio/ogg';
      }
      const transcricao = await comRetry(() => transcreverAudio(b64, mime), { tentativas: 2, requestId, etapa: 'whisper' });
      conteudo = `🎙️ [Áudio]: ${transcricao}`;
      logger.info('midia/audio/ok', 'Transcrito', { requestId, telefone, chars: transcricao.length });
    }

    // ── Mídia: imagem ──────────────────────────────────────────────────────
    let isComprovante = false;
    if (tipo === 'imageMessage') {
      logger.step(requestId, telefone, 'midia/imagem');
      let b64 = base64Inline, mime = mimetypeInline || 'image/jpeg';
      if (!b64) {
        const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadImagem' });
        b64 = m.base64; mime = m.mimetype || 'image/jpeg';
      }
      const r = await comRetry(() => analisarImagem(b64, mime), { tentativas: 2, requestId, etapa: 'gptVision' });
      isComprovante = r.isComprovante;
      conteudo = isComprovante
        ? `📎 COMPROVANTE PIX CONFIRMADO: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`
        : `📎 [Imagem]: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`;
      logger.info('midia/imagem/ok', 'Analisada', { requestId, telefone, isComprovante });
    }

    if (!conteudo?.trim()) return;

    // ── Estado ──────────────────────────────────────────────────────────────
    const [historico, rascunho] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunho(telefone),
    ]);
    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone, historico_msgs: historico.length, etapa: rascunho?.etapa_atual || 'sem rascunho',
    });

    // ── FLUXO 1: comprovante PIX (código atualiza status, não depende da LLM) ─
    if (isComprovante && rascunho?.etapa_atual === 'aguardando_pix') {
      logger.step(requestId, telefone, 'pix/comprovante-recebido');
      await enviarDigitando(telefone, 1200);
      try {
        const pedido = await comRetry(() => atualizarStatusPedido(telefone, 'aguardando_preparo'),
          { tentativas: 3, requestId, etapa: 'statusPreparo' });
        await limparRascunho(telefone);
        const txt = `✅ Comprovante recebido, pagamento confirmado! Pedido *#${pedido.numero_pedido}* já tá indo pra cozinha 🍲\n\n⏱️ Logo logo fica pronto. Valeu, ${pushName}! 🎩`;
        await comRetry(() => enviarTexto(telefone, txt), { tentativas: 3, requestId, etapa: 'enviarPixOk' });
        await Promise.all([salvarMensagem(telefone, 'user', conteudo), salvarMensagem(telefone, 'assistant', txt)]);
        return;
      } catch (err) {
        logger.error('pix/comprovante/erro', err.message, { requestId, telefone, stack: err.stack });
        // cai para o agente lidar
      }
    }

    // ── FLUXO 2: confirmação SIM (código cria o pedido) ──────────────────────
    if (ehConfirmacao(conteudo) && rascunho?.etapa_atual === 'aguardando_confirmacao') {
      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      await enviarDigitando(telefone, 1500);
      try {
        const r = await confirmarPedido(rascunho, telefone, requestId);

        let txt;
        const linhaTaxa = r.taxaEntrega > 0 ? `🚴 Taxa de entrega: ${fmt(r.taxaEntrega)}\n` : '';
        const corpo =
          `🛍️ Subtotal: ${fmt(r.subtotal)}\n` + linhaTaxa + `💰 *Total: ${fmt(r.total)}*\n\n`;

        if (r.formaPagamento === 'pix') {
          const info = await buscarInfo();
          const chave = info.chave_pix || 'não cadastrada';
          txt = `✅ Pedido *#${r.numeroPedido}* registrado!\n\n` + corpo +
            `📱 *Chave PIX:* \`${chave}\`\n\n` +
            `Faz o PIX e me manda o comprovante aqui que eu já libero pra cozinha 😊`;
        } else {
          const prazo = rascunho.tipo_entrega === 'delivery' ? '~35 minutinhos' : '~20 minutinhos';
          txt = `✅ Pedido *#${r.numeroPedido}* confirmado!\n\n` + corpo +
            `Já tá indo pra cozinha! ⏱️ Previsão: ${prazo}. Bom apetite, ${pushName}! 🎩`;
        }

        await comRetry(() => enviarTexto(telefone, txt), { tentativas: 3, requestId, etapa: 'enviarConfirmacao' });
        await Promise.all([salvarMensagem(telefone, 'user', conteudo), salvarMensagem(telefone, 'assistant', txt)]);
        return;
      } catch (err) {
        if (err.jaProcessando) {
          // Outra mensagem quase simultânea (double-tap, retry do WhatsApp)
          // já está fechando este pedido — essa aqui só desiste em silêncio,
          // a outra já vai mandar a confirmação real pro cliente.
          logger.info('pedido/confirmar/concorrente', 'Confirmação duplicada ignorada', { requestId, telefone });
          return;
        }
        logger.error('pedido/confirmar/erro', err.message, { requestId, telefone, faltando: err.faltando, stack: err.stack });
        const falta = err.faltando?.length
          ? `Ainda preciso de: ${err.faltando.join(', ')}. Vamos completar?`
          : 'Tive um probleminha pra fechar o pedido. Pode me confirmar os dados de novo?';
        await enviarTexto(telefone, `Opa! ${falta}`);
        await Promise.all([salvarMensagem(telefone, 'user', conteudo), salvarMensagem(telefone, 'assistant', falta)]);
        return;
      }
    }

    // ── FLUXO 3: agente conversacional ───────────────────────────────────────
    await enviarDigitando(telefone, 2500);
    const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
    const resposta = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone);

    if (!resposta) {
      logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
      await enviarTexto(telefone, 'Desculpa, não entendi bem 😅 Pode repetir?');
      return;
    }

    await comRetry(() => enviarTexto(telefone, resposta), { tentativas: 3, requestId, etapa: 'enviarResposta' });
    logger.info('whatsapp/ok', 'Resposta enviada', { requestId, telefone, chars: resposta.length });

    await Promise.all([salvarMensagem(telefone, 'user', conteudo), salvarMensagem(telefone, 'assistant', resposta)]);

  } catch (err) {
    logger.error('webhook/erro-geral', err.message, { requestId, telefone, stack: err.stack });
    try { await enviarTexto(telefone, 'Opa, tive um problema técnico aqui 😅 Tenta de novo em instantes!'); } catch {}
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info('servidor/start', `🎩 Agente Chapelão rodando na porta ${PORT}`, {
    port: PORT,
    supa_url:  process.env.SUPA_URL       ? '✓' : '✗ FALTANDO',
    openai:    process.env.OPENAI_API_KEY ? '✓' : '✗ FALTANDO',
    evolution: process.env.EVOLUTION_URL  ? '✓' : '✗ FALTANDO',
  });
});
