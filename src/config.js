'use strict';

// ─── FONTE ÚNICA DA VERDADE ───────────────────────────────────────────────────
// Tudo que é número de negócio mora aqui. Antes a taxa de entrega vinha de dois
// lugares (info_restaurante no banco, com fallback 5 hardcoded) e a LLM ainda
// escrevia o resumo à mão — foi exatamente assim que o cliente viu R$ 5,00 no
// "confira seu pedido" e R$ 10,00 no pedido confirmado.

// Taxa FIXA de entrega. O valor do banco (info_restaurante.taxa_entrega) é
// ignorado de propósito: um único número, num único lugar, não tem como
// divergir. Para mudar, altere aqui (ou defina TAXA_ENTREGA no .env).
const TAXA_ENTREGA = Number(process.env.TAXA_ENTREGA || 11);

// ─── MODELO ───────────────────────────────────────────────────────────────────
// Claude Opus 5: o modelo mais capaz para trabalho agêntico de longo prazo e
// seguimento literal de instruções — que é exatamente o que este agente exige.
const MODEL_AGENTE = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const MODEL_VISAO  = process.env.ANTHROPIC_MODEL_VISAO || 'claude-opus-5';

// Effort controla profundidade de raciocínio x latência x custo.
// 'medium' é o ponto de equilíbrio para atendimento por WhatsApp: raciocínio
// suficiente para nunca errar item/preço, sem deixar o cliente esperando.
const EFFORT_AGENTE = process.env.ANTHROPIC_EFFORT || 'medium';

// max_tokens no Opus 5 limita raciocínio + resposta juntos. Folga generosa
// para a resposta nunca truncar no meio.
const MAX_TOKENS_AGENTE = Number(process.env.ANTHROPIC_MAX_TOKENS || 4096);

// ─── ESCALONAMENTO PARA ATENDENTE HUMANO ──────────────────────────────────────
// Qualquer dúvida real, erro técnico ou situação que a IA não resolve sozinha:
// alerta no painel + atendimento pausado por 10 minutos.
const PAUSA_ATENDENTE_MS = Number(process.env.PAUSA_ATENDENTE_MIN || 10) * 60_000;

// ─── FORMATAÇÃO ───────────────────────────────────────────────────────────────

function fmtBRL(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

// Arredondamento monetário explícito — evita 0.1+0.2=0.30000000000000004
// aparecer como centavo fantasma na diferença entre resumo e pedido.
function money(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

// Data de HOJE no fuso do restaurante. Usar toISOString() direto pegava a data
// UTC: das 21h à meia-noite (horário de Umuarama) o sistema já achava que era
// o dia seguinte e buscava os itens do dia errados.
const TZ = process.env.TZ_RESTAURANTE || 'America/Sao_Paulo';
function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

module.exports = {
  TAXA_ENTREGA,
  MODEL_AGENTE, MODEL_VISAO, EFFORT_AGENTE, MAX_TOKENS_AGENTE,
  PAUSA_ATENDENTE_MS,
  fmtBRL, money, hojeLocal, TZ,
};
