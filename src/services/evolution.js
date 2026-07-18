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

// ─── EXTRAIR CAMPOS DO PAYLOAD EVOLUTION API v2 ───────────────────────────────

function extrairMensagem(body) {
  const data = body.data || body;
  const key = data.key || {};
  const message = data.message || {};
  const messageType = data.messageType || Object.keys(message)[0] || 'conversation';

  if (key.fromMe === true) return null;                        // mensagem própria
  const remoteJid = key.remoteJid || '';
  if (remoteJid.includes('@g.us')) return null;                // grupo

  const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
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

  return { telefone, pushName, tipo, texto, mensagemRaw: message, base64, mimetype };
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
  await cliente().post(`/message/sendText/${INSTANCE()}`, {
    number: telefone,
    text: texto,
    delay: 800,
  });
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
// chutado. Antes, um único envio com delay=2500 apagava sozinho depois de
// 2,5s — como o GPT-4o + Whisper/Vision costumam levar mais que isso, o
// cliente via o "digitando" sumir e nada acontecer por vários segundos
// (parecia que não tinha indicador nenhum). Agora reenvia a presença a
// cada poucos segundos até o processamento terminar de verdade.
function manterDigitando(telefone) {
  enviarDigitando(telefone, 6000);
  const intervalo = setInterval(() => enviarDigitando(telefone, 6000), 4000);
  return () => clearInterval(intervalo);
}

module.exports = { extrairMensagem, downloadMidia, enviarTexto, enviarDigitando, manterDigitando };
