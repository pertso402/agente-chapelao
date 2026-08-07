'use strict';

// ─── FONTE ÚNICA DA VERDADE ───────────────────────────────────────────────────
// Tudo que é número de negócio mora aqui. Antes a taxa de entrega vinha de dois
// lugares (info_restaurante no banco = 10, e um fallback 5 no código) e a LLM
// ainda escrevia o resumo à mão — foi exatamente assim que o cliente viu
// R$ 5,00 no "confira seu pedido" e R$ 10,00 no pedido confirmado.

// Taxa FIXA de entrega. Um único número, num único lugar, não tem como divergir.
// O EasyPanel define TAXA_ENTREGA=11; o banco também foi atualizado para 11
// (o painel lê de lá) e o agente confere os dois no boot — ver conferirTaxa().
const TAXA_ENTREGA = Number(process.env.TAXA_ENTREGA || 11);

// ─── MODELO (OpenAI) ──────────────────────────────────────────────────────────
// gpt-5.6-terra: o ponto de equilíbrio da família 5.6 — qualidade próxima do
// topo (Sol) por uma fração do custo e bem mais rápido, que é o que um
// atendimento por WhatsApp precisa. Suporta function calling, structured
// outputs e entrada de imagem (usado na leitura do comprovante PIX).
//
// Se algum dia precisar de mais precisão bruta: ANTHROPIC-free, é só trocar
// para 'gpt-5.6-sol'. Para cortar custo em volume alto: 'gpt-5.6-luna'.
const MODEL_AGENTE = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const MODEL_VISAO  = process.env.OPENAI_MODEL_VISAO || 'gpt-5.6-terra';

// Profundidade de raciocínio. 'low' mantém a resposta rápida no WhatsApp —
// e o trabalho pesado de exatidão (preço, total, taxa) não depende mais do
// modelo: é código. Suba para 'medium' se notar erro de interpretação.
const EFFORT_AGENTE = process.env.OPENAI_EFFORT || 'low';

const MAX_TOKENS_AGENTE = Number(process.env.OPENAI_MAX_TOKENS || 3000);

// ─── ESCALONAMENTO PARA ATENDENTE HUMANO ──────────────────────────────────────
// Qualquer dúvida real, erro técnico ou situação que a IA não resolve sozinha:
// alerta no painel + atendimento pausado por 10 minutos.
const PAUSA_ATENDENTE_MS = Number(process.env.PAUSA_ATENDENTE_MIN || 10) * 60_000;

// Quantas falhas seguidas de áudio antes de chamar gente. Na 1ª o agente pede
// pra escrever; na 2ª entrega pra um humano.
const MAX_FALHAS_AUDIO = Number(process.env.MAX_FALHAS_AUDIO || 2);

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
  PAUSA_ATENDENTE_MS, MAX_FALHAS_AUDIO,
  fmtBRL, money, hojeLocal, TZ,
};
