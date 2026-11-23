"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function assert(ok, status, message) {
  if (!ok) throw new HttpError(status, message);
}
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
function digest(v) {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
function sanitize(v, depth = 0) {
  if (depth > 20) throw new HttpError(400, "Evento profundo demais.");
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(
        ([k]) =>
          !/apikey|authorization|secret|token|base64|password|mediaurl|directpath|mediakey|^url$|^server_url$/i.test(
            k,
          ),
      )
      .map(([k, x]) => [k, sanitize(x, depth + 1)]),
  );
}
function secretEqual(actual, expected) {
  if (!expected || expected.length < 32 || typeof actual !== "string")
    return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function uuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  );
}
function isCurrent(c, i, s) {
  return (
    c.state === "ai" &&
    i.ai_enabled &&
    ["control_epoch", "inbound_seq"].every(
      (k) => String(c[k]) === String(s[k]),
    ) &&
    String(i.config_epoch) === String(s.config_epoch)
  );
}
// Igual a isCurrent, mas sem exigir que o cliente esteja calado. Serve para a
// resposta do agente original: quando ela fica pronta, o pedido já foi gravado
// (rascunho, confirmação, PIX). Descartar o texto porque o cliente mandou outra
// mensagem no meio deixava o cliente sem "Pedido #294 confirmado" e fazia o
// agente perguntar de novo o que já tinha anotado. Só a tomada humana (epoch)
// ou a IA desligada invalidam a resposta.
function isControlCurrent(c, i, s) {
  return (
    c.state === "ai" &&
    i.ai_enabled &&
    String(c.control_epoch) === String(s.control_epoch) &&
    String(i.config_epoch) === String(s.config_epoch)
  );
}
function deliveryStatus(current, incoming) {
  const rank = {
    pending: 0,
    sending: 1,
    unknown: 1,
    accepted: 2,
    delivered: 3,
    read: 4,
  };
  if (["cancelled", "received"].includes(current)) return current;
  if (incoming === "failed")
    return ["delivered", "read"].includes(current) ? current : "failed";
  return (rank[incoming] ?? -1) > (rank[current] ?? -1) ? incoming : current;
}
function validateDecision(v) {
  assert(
    v && ["reply", "handoff", "no_action"].includes(v.action),
    422,
    "Decisão da IA inválida.",
  );
  if (v.action === "reply")
    assert(
      typeof v.text === "string" &&
        v.text.trim().length > 0 &&
        v.text.length <= 4000 &&
        typeof v.clarification === "boolean",
      422,
      "Resposta inválida.",
    );
  if (v.action === "handoff") {
    assert(
      [
        "customer_request",
        "order_change",
        "payment_issue",
        "complaint",
        "unsupported_media",
        "missing_knowledge",
        "ai_error",
        "clarification_limit",
      ].includes(v.reason_code),
      422,
      "Motivo inválido.",
    );
    assert(
      typeof v.reason_detail === "string" &&
        v.reason_detail.length <= 500 &&
        typeof v.summary === "string" &&
        v.summary.length <= 1500,
      422,
      "Resumo inválido.",
    );
  }
  return v;
}
module.exports = {
  HttpError,
  assert,
  canonical,
  digest,
  sanitize,
  secretEqual,
  uuid,
  isCurrent,
  isControlCurrent,
  deliveryStatus,
  validateDecision,
};
