'use strict';

const axios = require('axios');

function cliente() {
  return axios.create({
    baseURL: process.env.EVOLUTION_URL,
    headers: {
      apikey: process.env.EVOLUTION_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

const INSTANCE = () => process.env.EVOLUTION_INSTANCE;

// ─── DETECÇÃO DE ECO DO PRÓPRIO BOT ───────────────────────────────────────────
// Mensagens fromMe:true chegam tanto quando é o BOT ecoando a própria resposta
// quanto quando é um ATENDENTE HUMANO respondendo direto pelo WhatsApp — index.js
// precisa diferenciar pra saber quando pausar o atendimento automático.
//
// Duas camadas, porque confiar só no ID tem uma corrida real: o webhook do eco
// pode chegar ANTES da Promise do POST /sendText resolver e popular o Map por ID.
// Por isso marcamos por TELEFONE de forma síncrona, antes do await de rede —
// e por ID (mais preciso) depois, quando a resposta trouxer.

const JANELA_ECO_MS = 15_000;
const ultimoEnvioBot = new Map(); // telefone -> timestamp
const idsEnviados = new Map();    // messageId -> timestamp

function limparExpirados(map, ttlMs) {
  const agora = Date.now();
  for (const [k, ts] of map) if (agora - ts > ttlMs) map.delete(k);
}

function marcarEnvioIminente(telefone) {
  ultimoEnvioBot.set(telefone, Date.now());
}

function marcarIdEnviado(id) {
  if (id) idsEnviados.set(id, Date.now());
}

// Retorna true se a mensagem fromMe:true for eco do próprio bot (não de um
// atendente humano assumindo a conversa).
function ehEcoDoBot(telefone, msgId) {
  limparExpirados(idsEnviados, 120_000);
  limparExpirados(ultimoEnvioBot, JANELA_ECO_MS);

  if (msgId && idsEnviados.has(msgId)) return true;

  const ts = ultimoEnvioBot.get(telefone);
  return !!ts && (Date.now() - ts) <= JANELA_ECO_MS;
}

// ─── EXTRAIR CAMPOS DO PAYLOAD EVOLUTION API v2 ───────────────────────────────

function extrairMensagem(body) {
  const data = body.data || body;
  const key = data.key || {};
  const message = data.message || {};
  const messageType = data.messageType || Object.keys(message)[0] || 'conversation';

  const remoteJid = key.remoteJid || '';
  if (remoteJid.includes('@g.us')) return null;                 // grupo
  const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

  if (key.fromMe === true) {
    // Não descarta mais: pode ser eco do bot OU atendente humano — index.js decide.
    return { fromMe: true, telefone, msgId: key.id || null };
  }

  const pushName = data.pushName || 'Cliente';

  let texto = '';
  let tipo = messageType;

  if (messageType === 'conversation') {
    texto = message.conversation || '';
  } else if (messageType === 'extendedTextMessage') {
    texto = message.extendedTextMessage?.text || '';
    tipo = 'text';
  } else if (messageType === 'audioMessage') {
    texto = '';
  } else if (messageType === 'imageMessage') {
    texto = message.imageMessage?.caption || '';
  } else if (messageType === 'documentMessage') {
    texto = '[Documento recebido]';
    tipo = 'text';
  } else {
    return null; // tipo não suportado
  }

  // Quando webhookBase64=true, Evolution já inclui o base64 no payload
  const base64   = data.base64   || message.base64   || null;
  const mimetype = data.mimetype || message.mimetype ||
    message.audioMessage?.mimetype || message.imageMessage?.mimetype || null;

  // Contexto de anúncio (Click-to-WhatsApp): WhatsApp anexa isso em contextInfo
  // quando a conversa começou a partir de um anúncio. Path mais provável +
  // fallback, já que Evolution pode achatar campos do proto entre versões.
  const contextInfoRaw = message?.[messageType]?.contextInfo || data?.contextInfo || null;
  const adInfo = contextInfoRaw?.externalAdReplyInfo || null;

  return { telefone, pushName, tipo, texto, mensagemRaw: message, base64, mimetype, adInfo, contextInfoRaw };
}

// ─── DOWNLOAD DE MÍDIA ────────────────────────────────────────────────────────

async function downloadMidia(mensagemRaw) {
  const { data } = await cliente().post(
    `/message/downloadMediaMessage/${INSTANCE()}`,
    { message: mensagemRaw }
  );
  // Retorna { base64, mimetype }
  if (!data?.base64) throw new Error('Evolution não retornou base64 da mídia.');
  return data;
}

// ─── ENVIO DE MENSAGENS ───────────────────────────────────────────────────────

async function enviarTexto(telefone, texto) {
  marcarEnvioIminente(telefone); // síncrono, ANTES do I/O — fecha a corrida do eco
  const { data } = await cliente().post(`/message/sendText/${INSTANCE()}`, {
    number: telefone,
    text: texto,
    delay: 800,
  });
  marcarIdEnviado(data?.key?.id);
}

async function enviarDigitando(telefone, duracaoMs = 4000) {
  try {
    await cliente().post(`/message/sendPresence/${INSTANCE()}`, {
      number: telefone,
      presence: 'composing',
      delay: duracaoMs,
    });
  } catch {
    // não crítico
  }
}

// "Digitando..." que dura o tempo REAL do processamento, não um tempo fixo
// chutado. Um único envio com delay fixo apagava sozinho antes do GPT-4o +
// Whisper/Vision terminarem — o cliente via o "digitando" sumir e nada
// acontecer por vários segundos. Reenvia a presença a cada poucos segundos
// até o processamento terminar de verdade (chamador dispara o cleanup).
function manterDigitando(telefone) {
  enviarDigitando(telefone, 6000);
  const intervalo = setInterval(() => enviarDigitando(telefone, 6000), 4000);
  return () => clearInterval(intervalo);
}

module.exports = {
  extrairMensagem, downloadMidia, enviarTexto, enviarDigitando, manterDigitando, ehEcoDoBot,
};
