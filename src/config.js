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

// Frete grátis a partir deste subtotal. É a alavanca de conversão mais forte
// que existe aqui: transforma "quanto custa a entrega?" em "faltam R$ 8 pra
// entrega sair de graça". Regra de negócio, então mora no código e é aplicada
// no cálculo — a LLM só é informada do resultado, nunca decide.
//
// Aplica sobre o SUBTOTAL (antes de desconto de cupom): é o número que o
// cliente enxerga como "meu pedido", e explicar qualquer outra coisa no
// WhatsApp gera discussão.
const FRETE_GRATIS_ACIMA_DE = Number(process.env.FRETE_GRATIS_ACIMA_DE || 40);

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

// Profundidade de raciocínio do agente.
//
// 'none' NÃO é uma escolha de economia: no /v1/chat/completions o gpt-5.6-terra
// recusa function tools junto com raciocínio —
//   "Function tools with reasoning_effort are not supported ... set
//    reasoning_effort to 'none'"
// e o agente vive de tools. Omitir o parâmetro não resolve: sem ele o modelo
// usa o raciocínio padrão e recusa as tools do mesmo jeito. Tem que ser 'none'
// explícito.
//
// Isso custa pouco aqui porque a parte que exige exatidão — preço, taxa, total,
// troco — é código determinístico, não raciocínio do modelo. E ainda deixa a
// resposta mais rápida no WhatsApp.
const EFFORT_AGENTE = process.env.OPENAI_EFFORT || 'none';

// O follow-up não usa tools, então pode raciocinar à vontade.
const EFFORT_FOLLOWUP = process.env.OPENAI_EFFORT_FOLLOWUP || 'low';

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

// ─── PRAZO DA OFERTA ──────────────────────────────────────────────────────────
// "Vale até domingo" só funciona como urgência se for verdade e se a data for
// calculada de fato. Dizer "até domingo" num domingo à noite queima a
// credibilidade e o cliente aprende a ignorar o prazo.
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function diaDaSemanaLocal() {
  // en-US + weekday numérico via Intl para respeitar o fuso do restaurante.
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nome);
}

// ─── HORÁRIO DE FUNCIONAMENTO ─────────────────────────────────────────────────
// Segunda a sábado, 11h às 14h. Fora disso o agente não monta pedido: avisa o
// horário e encerra com educação.
//
// Isto é uma trava de CÓDIGO, não uma instrução de prompt. Instrução de prompt
// a LLM contorna quando o cliente insiste ("mas só hoje, por favor"), e aí a
// cozinha recebe pedido de madrugada.
const ABRE_HORA = Number(process.env.ABRE_HORA || 11);
const FECHA_HORA = Number(process.env.FECHA_HORA || 14);
// 0=domingo … 6=sábado. Padrão: segunda a sábado.
const DIAS_ABERTOS = (process.env.DIAS_ABERTOS || '1,2,3,4,5,6')
  .split(',').map(d => Number(d.trim())).filter(Number.isInteger);

const TEXTO_HORARIO = process.env.TEXTO_HORARIO
  || `de segunda a sábado, das ${String(ABRE_HORA).padStart(2, '0')}h às ${String(FECHA_HORA).padStart(2, '0')}h`;

// Hora e minuto no fuso do restaurante — nunca no fuso do servidor, que roda
// em UTC e acharia que 11h de Umuarama é 14h.
function horaLocal() {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const pega = (t) => Number(partes.find(p => p.type === t)?.value || 0);
  return { hora: pega('hour'), minuto: pega('minute') };
}

// Aberto = dia da semana permitido E dentro da janela. O fechamento é no
// minuto exato: às 14h00 já está fechado.
function dentroDoHorario() {
  const dia = diaDaSemanaLocal();
  if (!DIAS_ABERTOS.includes(dia)) return false;
  const { hora } = horaLocal();
  return hora >= ABRE_HORA && hora < FECHA_HORA;
}

// Frase de quando volta a atender, pra mensagem não terminar em beco sem saída.
function quandoAbreTexto() {
  const dia = diaDaSemanaLocal();
  const { hora } = horaLocal();
  const abreHoje = DIAS_ABERTOS.includes(dia) && hora < ABRE_HORA;
  if (abreHoje) return `hoje às ${ABRE_HORA}h`;

  // Procura o próximo dia aberto a partir de amanhã.
  for (let i = 1; i <= 7; i++) {
    const proximo = (dia + i) % 7;
    if (!DIAS_ABERTOS.includes(proximo)) continue;
    const quando = i === 1 ? 'amanhã' : DIAS_SEMANA[proximo];
    return `${quando} às ${ABRE_HORA}h`;
  }
  return `às ${ABRE_HORA}h`;
}

// ─── DECISÃO DE ABRIR/FECHAR A LOJA ───────────────────────────────────────────
// Função PURA (não toca banco nem relógio) porque um erro de borda aqui custa
// um dia inteiro de vendas: reabrir uma loja que a cozinha fechou porque acabou
// a comida, ou fechar na cara de quem está testando às 9h.
//
// Regras:
//   - Abre uma vez por dia, ao entrar na janela, se ainda não abriu hoje.
//   - Fecha uma vez por dia, DEPOIS do horário de encerrar, se ainda não
//     fechou hoje. Antes de abrir, não mexe: a manhã fica livre pra testes.
//   - "Uma vez por dia" é o que impede a automação de desfazer um clique
//     manual feito no meio do expediente.
//
// Devolve: { acao: 'abrir' | 'fechar' | null, marcador: chave|null }
function decidirLoja({ hora, diaUtil, hoje, marcadorAbertura, marcadorFechamento, lojaAberta }) {
  const dentroDaJanela = diaUtil && hora >= ABRE_HORA && hora < FECHA_HORA;

  if (dentroDaJanela) {
    if (marcadorAbertura !== hoje) {
      return { acao: 'abrir', marcador: 'loja_auto_abertura' };
    }
    return { acao: null, marcador: null };
  }

  // Fora da janela: só fecha DEPOIS do expediente (ou em dia não útil).
  // Antes de ABRE_HORA num dia útil, não faz nada.
  const depoisDoExpediente = !diaUtil || hora >= FECHA_HORA;
  if (depoisDoExpediente && marcadorFechamento !== hoje) {
    return { acao: lojaAberta ? 'fechar' : 'so-marcar', marcador: 'loja_auto_fechamento' };
  }

  return { acao: null, marcador: null };
}

// Texto do prazo pronto pro agente usar. Domingo é o corte da semana.
function prazoOfertaTexto() {
  const hoje = diaDaSemanaLocal();
  if (hoje === 0) return 'só até hoje (domingo)';
  if (hoje === 6) return 'até amanhã (domingo)';
  const faltam = 7 - hoje; // dias até o próximo domingo
  return faltam <= 2 ? 'até domingo (falta pouco)' : 'até domingo';
}

module.exports = {
  TAXA_ENTREGA, FRETE_GRATIS_ACIMA_DE, prazoOfertaTexto, diaDaSemanaLocal,
  ABRE_HORA, FECHA_HORA, DIAS_ABERTOS, TEXTO_HORARIO,
  dentroDoHorario, quandoAbreTexto, horaLocal, decidirLoja,
  MODEL_AGENTE, MODEL_VISAO, EFFORT_AGENTE, MAX_TOKENS_AGENTE,
  PAUSA_ATENDENTE_MS, MAX_FALHAS_AUDIO,
  fmtBRL, money, hojeLocal, TZ,
};
