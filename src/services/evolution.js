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

// O nome da instância entra direto no CAMINHO da URL (/message/sendText/<nome>),
// então precisa ser escapado: a instância em uso chama-se "Chapela - atendimento"
// e um espaço cru no path quebra a requisição.
const INSTANCE = () => encodeURIComponent(process.env.EVOLUTION_INSTANCE || '');

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
    // Fica com tipo='documentMessage' (não vira 'text') porque comprovante de
    // PIX às vezes chega como PDF (ex: Nubank), não como foto — e nesse caso
    // não é um "documento qualquer": index.js precisa saber diferenciar pra
    // não deixar a LLM tentar adivinhar o que fazer com isso.
    texto = '[Documento recebido]';
  } else if (messageType === 'locationMessage' || messageType === 'liveLocationMessage') {
    // Localização (fixa ou em tempo real): converte pra um link de mapa e trata
    // como texto normal — o agente entende isso como o endereço do cliente,
    // igual trataria um endereço digitado.
    const loc = message[messageType] || {};
    const lat = loc.degreesLatitude;
    const lng = loc.degreesLongitude;
    if (lat == null || lng == null) return null;
    const link = `https://www.google.com/maps?q=${lat},${lng}`;
    const nomeLocal = loc.name ? `${loc.name} — ` : '';
    const enderecoLocal = loc.address ? `${loc.address} — ` : '';
    texto = `📍 [Localização compartilhada]: ${nomeLocal}${enderecoLocal}${link}`;
    // Mantém tipo = messageType (locationMessage/liveLocationMessage) — index.js
    // usa isso pra filtrar pings repetidos de localização em tempo real.
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

  // `key` viaja junto porque é por ela que a mídia é baixada depois
  // (getBase64FromMediaMessage busca por key.id, não pelo conteúdo).
  return { telefone, pushName, tipo, texto, key, msgId: key.id || null, mensagemRaw: message, base64, mimetype, adInfo, contextInfoRaw };
}

// ─── DOWNLOAD DE MÍDIA ────────────────────────────────────────────────────────

// A rota é /chat/getBase64FromMediaMessage. A antiga (/message/downloadMediaMessage)
// não existe mais na Evolution v2 e respondia 404 — o que derrubava ÁUDIO e
// COMPROVANTE PIX pelo mesmo motivo, sem que a causa aparecesse: o cliente só
// via "não consegui entender seu áudio".
//
// A busca é pela CHAVE da mensagem (key.id), não pelo conteúdo dela.
async function downloadMidia(msg) {
  const key = msg?.key || msg;
  if (!key?.id) throw new Error('Mensagem sem key.id — impossível baixar a mídia.');

  const { data } = await cliente().post(
    `/chat/getBase64FromMediaMessage/${INSTANCE()}`,
    { message: { key }, convertToMp4: false }
  );

  if (!data?.base64) throw new Error('Evolution não retornou base64 da mídia.');
  return { base64: data.base64, mimetype: data.mimetype || data.mediaType || null };
}

// Qual instância este container está REALMENTE usando pra enviar, e de qual
// número ela fala. Existe por um problema concreto: o webhook de uma instância
// nova apontava pro agente, mas o agente ainda respondia pela instância antiga
// (variável de ambiente não atualizada), então o cliente mandava mensagem pra
// um número e recebia resposta de outro. Sem isso, a única forma de descobrir
// era mandar mensagem e olhar de onde vinha a resposta.
async function estadoInstancia() {
  const nome = process.env.EVOLUTION_INSTANCE || null;
  const base = { url: process.env.EVOLUTION_URL || null, instancia: nome };

  try {
    const { data } = await cliente().get('/instance/fetchInstances');
    const lista = Array.isArray(data) ? data : [];
    const eu = lista.find(i => (i.name || i.instanceName) === nome);
    if (!eu) {
      return { ...base, ok: false, erro: `A instância "${nome}" não existe nesta Evolution. Encontradas: ${lista.map(i => i.name || i.instanceName).join(', ') || '(nenhuma)'}` };
    }
    return {
      ...base,
      ok: eu.connectionStatus === 'open',
      conexao: eu.connectionStatus,
      numero: String(eu.ownerJid || '').split('@')[0] || null,
      perfil: eu.profileName || null,
    };
  } catch (err) {
    return { ...base, ok: false, erro: err.response?.status ? `HTTP ${err.response.status}` : err.message };
  }
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

// Envia mídia por URL pública (vídeo do buffet do dia, subido pelo painel).
// A Evolution baixa a URL do lado dela — não precisamos carregar o arquivo
// aqui, o que evita segurar dezenas de MB na memória do container.
async function enviarMidia(telefone, url, { tipo = 'video', legenda = '' } = {}) {
  marcarEnvioIminente(telefone); // mesmo tratamento de eco do enviarTexto
  const { data } = await cliente().post(`/message/sendMedia/${INSTANCE()}`, {
    number: telefone,
    mediatype: tipo,      // 'video' | 'image'
    media: url,
    caption: legenda,
    delay: 400,
  }, { timeout: 60000 }); // vídeo de buffet é pesado; 15s do padrão não basta
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
  extrairMensagem, downloadMidia, enviarTexto, enviarMidia, estadoInstancia,
  enviarDigitando, manterDigitando, ehEcoDoBot,
};
