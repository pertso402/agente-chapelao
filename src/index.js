'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const { extrairMensagem, downloadMidia, enviarTexto, enviarDigitando } = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const { carregarHistorico, salvarMensagem, carregarRascunho, salvarRascunho, limparRascunho } = require('./services/supabase');
const { rodarAgente, confirmarPedido } = require('./agent');
const { comRetry } = require('./utils/retry');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── DEDUPLICAÇÃO DE MENSAGENS ────────────────────────────────────────────────
// Evolution API pode enviar o mesmo evento mais de uma vez.
// Usamos um Map com TTL para evitar processamento duplicado.

const msgProcessadas = new Map();

function jaProcessada(msgId) {
  if (!msgId) return false;
  const agora = Date.now();
  // Limpar entradas antigas (> 2min)
  for (const [id, ts] of msgProcessadas) {
    if (agora - ts > 120_000) msgProcessadas.delete(id);
  }
  if (msgProcessadas.has(msgId)) return true;
  msgProcessadas.set(msgId, agora);
  return false;
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
  res.status(200).json({ ok: true }); // responde imediatamente

  const requestId = uuid().slice(0, 8);
  const body = req.body;

  // ── 1. Extrair mensagem ────────────────────────────────────────────────────
  let msg;
  try {
    msg = extrairMensagem(body);
    if (!msg) return;
  } catch (err) {
    logger.error('webhook/extrair', err.message, { requestId, err });
    return;
  }

  // ── 2. Deduplicação ───────────────────────────────────────────────────────
  const msgId = body?.data?.key?.id;
  if (jaProcessada(msgId)) {
    logger.info('webhook/dedup', 'Mensagem duplicada ignorada', { requestId, msgId });
    return;
  }

  const { telefone, pushName, tipo, mensagemRaw } = msg;
  let conteudo = msg.texto;

  logger.step(requestId, telefone, 'webhook/recebido', { tipo, pushName, preview: conteudo.slice(0, 60) });

  try {
    // ── 3. Processar mídia ─────────────────────────────────────────────────
    if (tipo === 'audioMessage') {
      logger.step(requestId, telefone, 'midia/audio');
      const midia = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadAudio' });
      const transcricao = await comRetry(() => transcreverAudio(midia.base64, midia.mimetype), { tentativas: 2, requestId, etapa: 'whisper' });
      conteudo = `🎙️ [Áudio]: ${transcricao}`;
      logger.info('midia/audio/ok', 'Transcrito', { requestId, telefone, chars: transcricao.length });
    }

    if (tipo === 'imageMessage') {
      logger.step(requestId, telefone, 'midia/imagem');
      const midia = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadImagem' });
      const { analise, isComprovante } = await comRetry(() => analisarImagem(midia.base64, midia.mimetype), { tentativas: 2, requestId, etapa: 'gptVision' });
      conteudo = isComprovante
        ? `📎 COMPROVANTE PIX CONFIRMADO: ${analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`
        : `📎 [Imagem]: ${analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`;
      logger.info('midia/imagem/ok', 'Analisada', { requestId, telefone, isComprovante });
    }

    if (!conteudo?.trim()) return;

    // ── 4. Carregar estado ─────────────────────────────────────────────────
    const [historico, rascunho] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunho(telefone),
    ]);

    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone,
      historico_msgs: historico.length,
      etapa_rascunho: rascunho?.etapa_atual || 'sem rascunho',
    });

    // ── 5. Fluxo especial: confirmação via SIM ─────────────────────────────
    const msgNorm = conteudo.trim().toUpperCase();
    if ((msgNorm === 'SIM' || msgNorm === '1' || msgNorm === 'CONFIRMAR') &&
        rascunho?.etapa_atual === 'aguardando_confirmacao' &&
        rascunho?.itens && rascunho?.nome_cliente && rascunho?.tipo_entrega && rascunho?.forma_pagamento) {

      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      await enviarDigitando(telefone, 1500);

      const resultado = await confirmarPedido(rascunho, telefone, requestId);

      let respostaConfirmacao;
      if (resultado.formaPagamento === 'pix') {
        const info = await require('./services/supabase').buscarInfo();
        const chave = info.chave_pix || 'não cadastrada';
        respostaConfirmacao =
          `✅ Pedido *#${resultado.numeroPedido}* registrado!\n\n` +
          `💰 Total: R$ ${Number(resultado.total).toFixed(2).replace('.', ',')}\n` +
          (resultado.taxaEntrega > 0 ? `🚴 Taxa de entrega: R$ ${Number(resultado.taxaEntrega).toFixed(2).replace('.', ',')}\n` : '') +
          `\n📱 *Chave PIX:* \`${chave}\`\n\n` +
          `Faz o pix e me manda o comprovante aqui, tá? 😊`;
      } else {
        respostaConfirmacao =
          `✅ Pedido *#${resultado.numeroPedido}* confirmado!\n\n` +
          `💰 Total: R$ ${Number(resultado.total).toFixed(2).replace('.', ',')}\n` +
          (resultado.taxaEntrega > 0 ? `🚴 Taxa de entrega: R$ ${Number(resultado.taxaEntrega).toFixed(2).replace('.', ',')}\n\n` : '\n') +
          `Já tá indo pra cozinha! ⏱️ Previsão: ${rascunho.tipo_entrega === 'delivery' ? '~35 minutinhos' : '~20 minutinhos'}. Bom apetite! 🎩`;
      }

      await comRetry(() => enviarTexto(telefone, respostaConfirmacao), { tentativas: 3, requestId, etapa: 'enviarConfirmacao' });
      await Promise.all([
        salvarMensagem(telefone, 'user', conteudo),
        salvarMensagem(telefone, 'assistant', respostaConfirmacao),
      ]);
      return; // encerra aqui — não vai para o agente
    }

    // ── 6. Processar com agente ────────────────────────────────────────────
    await enviarDigitando(telefone, 2500);

    const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
    const resposta = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone);

    if (!resposta) {
      logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
      return;
    }

    // ── 7. Enviar resposta ─────────────────────────────────────────────────
    await comRetry(() => enviarTexto(telefone, resposta), { tentativas: 3, requestId, etapa: 'enviarResposta' });
    logger.info('whatsapp/ok', 'Resposta enviada', { requestId, telefone, chars: resposta.length });

    // ── 8. Salvar histórico ────────────────────────────────────────────────
    await Promise.all([
      salvarMensagem(telefone, 'user', conteudo),
      salvarMensagem(telefone, 'assistant', resposta),
    ]);

  } catch (err) {
    logger.error('webhook/erro-geral', err.message, { requestId, telefone, stack: err.stack });

    try {
      await enviarTexto(telefone, 'Opa, tive um problema técnico aqui 😅 Tenta de novo em instantes!');
    } catch { /* silencioso */ }
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info('servidor/start', `🎩 Agente Chapelão rodando na porta ${PORT}`, {
    port: PORT,
    supa_url:   process.env.SUPA_URL       ? '✓' : '✗ FALTANDO',
    openai:     process.env.OPENAI_API_KEY ? '✓' : '✗ FALTANDO',
    evolution:  process.env.EVOLUTION_URL  ? '✓' : '✗ FALTANDO',
  });
});
