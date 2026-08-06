'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const { extrairMensagem, downloadMidia, enviarTexto, manterDigitando, ehEcoDoBot } = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, limparRascunho,
  buscarInfo, atualizarStatusPedido,
  buscarCupomAtivoPorTelefone,
  garantirCliente, verificarPausa, pausarAtendimento,
  reivindicarFollowups, reivindicarTravados,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido, gerarFollowup } = require('./agent');
const { comRetry } = require('./utils/retry');
const { normalizar } = require('./utils/pedido');

const app = express();
app.use(express.json({ limit: '10mb' }));

const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ─── RESPOSTA CENTRAL ──────────────────────────────────────────────────────────
// Todo texto que sai do bot passa por aqui: envia, salva no histórico e stampa
// o rastreio de silêncio (ultima_msg_em/role) usado pelo follow-up. Centralizado
// de propósito — evita ter que lembrar de stampar em cada um dos vários pontos
// que respondem ao cliente.
async function responder(telefone, texto, { requestId, etapa }) {
  await comRetry(() => enviarTexto(telefone, texto), { tentativas: 3, requestId, etapa });
  await salvarMensagem(telefone, 'assistant', texto);
  await salvarRascunho(telefone, {
    ultima_msg_em: new Date().toISOString(),
    ultima_msg_role: 'assistant',
  }).catch(err => logger.warn('rascunho/stamp-assistant-falhou', err.message, { requestId, telefone }));
}

// ─── FILA POR TELEFONE ─────────────────────────────────────────────────────────
// Evita que 2+ mensagens do MESMO cliente, chegando rápido uma atrás da outra
// (antes da primeira terminar seu round-trip com o GPT-4o, que leva alguns
// segundos), processem em paralelo e se atropelem escrevendo o rascunho —
// leitura+escrita do estado não é atômica fora do SIM (que já tem trava própria).
// Clientes DIFERENTES continuam 100% em paralelo; só o mesmo telefone é
// serializado, e um erro numa mensagem nunca trava as próximas dessa fila.
const filasPorTelefone = new Map();
function enfileirar(telefone, tarefa) {
  const anterior = filasPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  filasPorTelefone.set(telefone, atual.catch(() => {}));
  return atual;
}

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

  // ── Mensagem própria (fromMe): eco do bot ou atendente humano assumiu? ──────
  if (msg.fromMe) {
    if (ehEcoDoBot(msg.telefone, msg.msgId)) return; // eco da nossa própria resposta, ignora
    try {
      await pausarAtendimento(msg.telefone, 10 * 60_000, 'atendente humano respondeu');
      logger.info('pausa/atendente-humano', 'Atendente respondeu, pausando IA conversacional por 10min', {
        requestId, telefone: msg.telefone,
      });
    } catch (err) {
      logger.error('pausa/erro', err.message, { requestId, telefone: msg.telefone, stack: err.stack });
    }
    return;
  }

  // Serializa por telefone: mensagens do MESMO cliente chegando rápido uma
  // atrás da outra esperam a anterior terminar antes de ler/escrever o
  // rascunho — evita duas escritas concorrentes se atropelarem. Clientes
  // diferentes continuam processando 100% em paralelo.
  await enfileirar(msg.telefone, () => processarMensagem(msg, requestId));
});

async function processarMensagem(msg, requestId) {
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

    // ── Cliente existe desde a 1ª mensagem (não só na compra) + origem de anúncio ─
    garantirCliente(telefone, pushName, msg.adInfo).catch(err =>
      logger.warn('cliente/garantir-falhou', err.message, { requestId, telefone }));

    if (msg.adInfo) {
      logger.info('anuncio/detectado', 'Contexto de anúncio (CTWA) identificado', { requestId, telefone, adInfo: msg.adInfo });
    } else if (msg.contextInfoRaw) {
      // Ajuda a validar/corrigir os paths de detecção contra tráfego real
      logger.info('anuncio/contextinfo-sem-ad', 'contextInfo presente sem externalAdReplyInfo', {
        requestId, telefone, contextInfoRaw: msg.contextInfoRaw,
      });
    }

    // ── Salva a mensagem do cliente + marca rastreio de silêncio (p/ follow-up) ─
    await salvarMensagem(telefone, 'user', conteudo);
    await salvarRascunho(telefone, {
      ultima_msg_em: new Date().toISOString(),
      ultima_msg_role: 'user',
      followup_enviado: false,
    }).catch(err => logger.warn('rascunho/stamp-user-falhou', err.message, { requestId, telefone }));

    // ── Estado ──────────────────────────────────────────────────────────────
    const [historico, rascunho, ofertaAtiva] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunho(telefone),
      buscarCupomAtivoPorTelefone(telefone).catch((e) => {
        // Nunca deixa uma falha aqui derrubar o atendimento — sem oferta
        // ativa detectada, o fluxo normal (sem desconto) continua valendo.
        logger.warn('oferta/buscar-falhou', e.message, { requestId, telefone });
        return null;
      }),
    ]);
    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone, historico_msgs: historico.length, etapa: rascunho?.etapa_atual || 'sem rascunho',
      cupom_ativo: ofertaAtiva?.codigo || null,
    });

    // ── FLUXO 1: comprovante PIX (código atualiza status, não depende da LLM) ─
    // Determinístico — continua funcionando mesmo com o atendimento pausado.
    if (isComprovante && rascunho?.etapa_atual === 'aguardando_pix') {
      logger.step(requestId, telefone, 'pix/comprovante-recebido');
      const pararDigitando = manterDigitando(telefone);
      try {
        const pedido = await comRetry(() => atualizarStatusPedido(telefone, 'preparando'),
          { tentativas: 3, requestId, etapa: 'statusPreparo' });
        await limparRascunho(telefone);
        const txt = `✅ Comprovante recebido, pagamento confirmado! Pedido *#${pedido.numero_pedido}* já tá indo pra cozinha 🍲\n\n⏱️ Logo logo fica pronto. Valeu, ${pushName}! 🎩`;
        await responder(telefone, txt, { requestId, etapa: 'enviarPixOk' });
        return;
      } catch (err) {
        logger.error('pix/comprovante/erro', err.message, { requestId, telefone, stack: err.stack });
        const txt = 'Recebi seu comprovante, mas tive um problema técnico pra confirmar automaticamente 😅 Nossa equipe vai conferir e liberar seu pedido manualmente em instantes.';
        await responder(telefone, txt, { requestId, etapa: 'pixErroHonesto' }).catch(() => {});
        return;
      } finally {
        pararDigitando();
      }
    }

    // ── FLUXO 2: confirmação SIM (código cria o pedido) ──────────────────────
    // Determinístico — continua funcionando mesmo com o atendimento pausado.
    if (ehConfirmacao(conteudo) && rascunho?.etapa_atual === 'aguardando_confirmacao') {
      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      const pararDigitando = manterDigitando(telefone);
      try {
        const r = await confirmarPedido(rascunho, telefone, requestId, ofertaAtiva);

        let txt;
        const linhaTaxa = r.taxaEntrega > 0 ? `🚴 Taxa de entrega: ${fmt(r.taxaEntrega)}\n` : '';
        const linhaDesconto = r.desconto > 0 ? `🎁 Desconto (${r.cupomAplicado}): -${fmt(r.desconto)}\n` : '';
        const linhaBrinde = r.brindes?.length ? `🎁 Brinde: ${r.brindes.join(' + ')} (cortesia)\n` : '';
        const corpo =
          `🛍️ Subtotal: ${fmt(r.subtotal)}\n` + linhaTaxa + linhaDesconto + linhaBrinde + `💰 *Total: ${fmt(r.total)}*\n\n`;

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

        await responder(telefone, txt, { requestId, etapa: 'enviarConfirmacao' });
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
        await responder(telefone, `Opa! ${falta}`, { requestId, etapa: 'confirmarErro' }).catch(() => {});
        return;
      } finally {
        pararDigitando();
      }
    }

    // ── Atendimento pausado (atendente humano assumiu)? Só bloqueia a partir daqui ─
    if (await verificarPausa(telefone)) {
      logger.info('pausa/ativa', 'Atendimento pausado, IA não respondeu', { requestId, telefone });
      return;
    }

    // ── FLUXO 3: agente conversacional ───────────────────────────────────────
    const pararDigitandoAgente = manterDigitando(telefone);
    try {
      const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
      const resposta = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone, ofertaAtiva);

      if (!resposta) {
        logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
        await responder(telefone, 'Desculpa, não entendi bem 😅 Pode repetir?', { requestId, etapa: 'respostaVazia' });
        return;
      }

      await responder(telefone, resposta, { requestId, etapa: 'enviarResposta' });
      logger.info('whatsapp/ok', 'Resposta enviada', { requestId, telefone, chars: resposta.length });
    } finally {
      pararDigitandoAgente();
    }

  } catch (err) {
    logger.error('webhook/erro-geral', err.message, { requestId, telefone, stack: err.stack });
    try {
      await responder(telefone, 'Opa, tive um problema técnico aqui 😅 Tenta de novo em instantes!', { requestId, etapa: 'erroGeral' });
    } catch {}
  }
}

// ─── POLLER: FOLLOW-UP DE SILÊNCIO + WATCHDOG DE PEDIDO TRAVADO ───────────────
// Roda dentro do mesmo processo (container único, sem clustering) a cada 60s.
// Usa claim atômico (UPDATE...RETURNING) em supabase.js — não é "SELECT depois
// agir", então não tem corrida com uma mensagem nova chegando no meio.

const SILENCIO_FOLLOWUP_MS = 7 * 60_000;
const TRAVADO_WATCHDOG_MS = 2 * 60_000;

async function pollarFollowups() {
  const candidatos = await reivindicarFollowups(SILENCIO_FOLLOWUP_MS);
  for (const rascunho of candidatos) {
    const requestId = uuid().slice(0, 8);
    const { telefone } = rascunho;
    try {
      if (await verificarPausa(telefone)) {
        logger.info('followup/pausado', 'Atendimento pausado, follow-up não enviado', { requestId, telefone });
        continue;
      }
      const historico = await carregarHistorico(telefone);
      const texto = await gerarFollowup(historico, rascunho, requestId, telefone);
      if (!texto) continue;
      await responder(telefone, texto, { requestId, etapa: 'followup' });
      logger.info('followup/enviado', 'Follow-up enviado após silêncio', { requestId, telefone });
    } catch (err) {
      logger.error('followup/erro', err.message, { requestId, telefone, stack: err.stack });
    }
  }
}

async function pollarTravados() {
  const travados = await reivindicarTravados(TRAVADO_WATCHDOG_MS);
  for (const r of travados) {
    logger.error('watchdog/rascunho-travado',
      'Rascunho preso em "processando" — possível pedido não finalizado, verificar manualmente com o cliente',
      { telefone: r.telefone, nome_cliente: r.nome_cliente, itens: r.itens, updated_at: r.updated_at });
  }
}

let pollando = false;
async function pollar() {
  if (pollando) return;
  pollando = true;
  try {
    await pollarFollowups();
    await pollarTravados();
    logger.info('poller/heartbeat', 'Ciclo do poller concluído', {});
  } catch (err) {
    logger.error('poller/erro-geral', err.message, { stack: err.stack });
  } finally {
    pollando = false;
  }
}
setInterval(pollar, 60_000);

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
