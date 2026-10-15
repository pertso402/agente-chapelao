"use strict";
const { assert, digest, sanitize } = require("./domain");
const EVENTS = new Set([
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
]);
function normalizeEvents(body) {
  assert(
    body && typeof body === "object" && !Array.isArray(body),
    400,
    "Envelope inválido.",
  );
  const event = String(body.event || "")
    .replace(/[.\-]/g, "_")
    .toUpperCase();
  if (!EVENTS.has(event)) return [];
  const payload = sanitize(body);
  const items = Array.isArray(payload.data) ? payload.data : [payload.data];
  assert(items.length <= 100, 400, "Lote grande demais.");
  return items.map((data) => ({
    event,
    data,
    dedup: digest({ event, data, instance: payload.instance }),
  }));
}
function parseMessage(data, { fullAgent = false } = {}) {
  assert(data && typeof data === "object", 422, "Mensagem sem dados.");
  if (data.isHistory === true || data.type === "append") return null;
  const key = data.key;
  assert(
    key &&
      typeof key.id === "string" &&
      typeof key.remoteJid === "string" &&
      typeof key.fromMe === "boolean",
    422,
    "Chave incompleta.",
  );
  const jid = key.remoteJid;
  if (!/^[0-9]+@(s\.whatsapp\.net|c\.us|lid)$/.test(jid)) return null;
  let m = data.message;
  assert(m && typeof m === "object", 422, "Mensagem sem conteúdo.");
  m =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m;
  if ((!fullAgent && m.reactionMessage) || m.protocolMessage || m.senderKeyDistributionMessage)
    return null;
  let kind = "text",
    text = m.conversation ?? m.extendedTextMessage?.text;
  if (fullAgent && m.reactionMessage) { text = m.reactionMessage.text; if (!text) return null; }
  if (fullAgent && (m.locationMessage || m.liveLocationMessage)) {
    const location = m.locationMessage || m.liveLocationMessage;
    if (!Number.isFinite(location.degreesLatitude) || !Number.isFinite(location.degreesLongitude)) return null;
    text = "📍 " + (location.address || location.name || "Localização compartilhada") + " https://www.google.com/maps?q=" + location.degreesLatitude + "," + location.degreesLongitude;
  }
  if (typeof text !== "string") {
    const media = [
      "imageMessage",
      "audioMessage",
      "documentMessage",
      "videoMessage",
      "stickerMessage",
    ].find((k) => m[k]);
    if (!media) return null;
    kind = media.replace("Message", "");
    text = m[media].caption || "[" + kind + "]";
  }
  const seconds = Number(data.messageTimestamp?.low ?? data.messageTimestamp);
  const date =
    Number.isFinite(seconds) && seconds > 0 && seconds < 1e11
      ? new Date(seconds * 1000).toISOString()
      : null;
  return {
    jid,
    providerId: key.id,
    fromMe: key.fromMe,
    kind,
    text: text.slice(0, 16000),
    name:
      typeof data.pushName === "string"
        ? data.pushName.slice(0, 160)
        : "Cliente",
    providerAt: date,
    phone: /@(s\.whatsapp\.net|c\.us)$/.test(jid) ? jid.split("@")[0] : /^[0-9]{10,15}@(s\.whatsapp\.net|c\.us)$/.test(key.remoteJidAlt || "") ? key.remoteJidAlt.split("@")[0] : null,
    mediaKey:
      kind === "text"
        ? null
        : { id: key.id, remoteJid: jid, fromMe: key.fromMe },
  };
}
function createEvolution(config, transport = fetch) {
  async function request(id, route, body) {
    const instance = config.instances.find((i) => i.id === id);
    assert(instance?.key, 503, "Credencial da instância ausente.");
    const response = await transport(
      config.evolutionUrl.replace(/\/$/, "") +
        "/" +
        route +
        "/" +
        encodeURIComponent(instance.name),
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: { apikey: instance.key, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      const error = new Error("Evolution HTTP " + response.status);
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.body?.getReader) return response.json();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) {
        await reader.cancel();
        assert(false, 413, "Resposta do provedor excede o limite.");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return {
    state: (id) => request(id, "instance/connectionState"),
    send: (id, jid, text) =>
      request(id, "message/sendText", { number: jid, text }),
    media: (id, key) =>
      request(id, "chat/getBase64FromMediaMessage", {
        message: { key },
        convertToMp4: false,
      }),
    webhook: (id) => request(id, "webhook/find"),
  };
}
module.exports = { normalizeEvents, parseMessage, createEvolution };
