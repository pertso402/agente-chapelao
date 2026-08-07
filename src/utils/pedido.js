'use strict';

// ─── LÓGICA DE DOMÍNIO PURA DO PEDIDO ─────────────────────────────────────────
// Sem acesso a banco. Funções determinísticas usadas para decidir o estado
// do pedido E para calcular/renderizar o dinheiro. O CÓDIGO (não a LLM) é a
// fonte da verdade sobre o que falta e sobre quanto custa.

const { TAXA_ENTREGA, fmtBRL, money } = require('../config');

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // remove acentos
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItens(itens) {
  if (Array.isArray(itens)) return itens;
  if (typeof itens === 'string') {
    try { const v = JSON.parse(itens); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  return [];
}

// Avalia o rascunho e decide a etapa DETERMINISTICAMENTE.
// etapa "aguardando_confirmacao" SÓ é atingida quando TUDO está presente.
function avaliarRascunho(r = {}) {
  const itens = parseItens(r.itens);
  const faltando = [];

  if (!itens.length)                                    faltando.push('itens');
  if (!r.nome_cliente)                                  faltando.push('nome');
  if (!r.tipo_entrega)                                  faltando.push('tipo_entrega');
  if (r.tipo_entrega === 'delivery' && !r.endereco)     faltando.push('endereco');
  if (!r.forma_pagamento)                               faltando.push('forma_pagamento');
  // Dinheiro sem troco definido é pedido incompleto: o entregador sai sem
  // saber quanto levar e a conta acontece na porta do cliente. Zero é uma
  // resposta válida ("tenho o valor certo") — por isso o teste é != null.
  if (r.forma_pagamento === 'dinheiro' && r.troco_para == null) faltando.push('troco');

  const completo = faltando.length === 0;

  let etapa;
  if (completo)            etapa = 'aguardando_confirmacao';
  else if (itens.length)   etapa = 'coletando_dados';
  else                     etapa = 'coletando_itens';

  return { completo, faltando, etapa, itens };
}

const LABEL_FALTANDO = {
  itens:           'os itens do pedido',
  nome:            'o nome completo do cliente',
  tipo_entrega:    'se é entrega (delivery) ou retirada',
  endereco:        'o endereço de entrega',
  forma_pagamento: 'a forma de pagamento (pix, dinheiro ou cartão)',
  troco:           'se precisa de troco e pra quanto (pagamento em dinheiro)',
};

function descreverFaltando(faltando) {
  return faltando.map(f => LABEL_FALTANDO[f] || f).join(', ');
}

function calcularSubtotal(itens) {
  return money(parseItens(itens).reduce(
    (s, i) => s + Number(i.preco_unitario || 0) * Number(i.quantidade || 0),
    0
  ));
}

// ─── DINHEIRO: UM ÚNICO CAMINHO DE CÁLCULO ────────────────────────────────────
// Chamada tanto na hora de MOSTRAR o resumo quanto na hora de CRIAR o pedido.
// Enquanto as duas telas passarem por aqui, é impossível divergirem.

function calcularTotais({ itens, tipoEntrega, cupom }) {
  const subtotal = calcularSubtotal(itens);
  const taxaEntrega = tipoEntrega === 'delivery' ? money(TAXA_ENTREGA) : 0;

  // Cupom de brinde não abate percentual — o benefício são os itens grátis.
  const ehBrinde = cupom?.tipo === 'brinde';
  const desconto = cupom && !ehBrinde
    ? money(subtotal * (Number(cupom.desconto_percentual) / 100))
    : 0;

  const total = money(subtotal + taxaEntrega - desconto);
  return { subtotal, taxaEntrega, desconto, total };
}

// ─── RESUMO FINAL (texto pronto pro WhatsApp) ─────────────────────────────────
// A LLM NÃO monta mais esse texto: ela recebe esta string pronta e repassa
// caractere por caractere. Foi montar o resumo "de cabeça" que produziu a
// taxa de R$ 5,00 no resumo e R$ 10,00 no pedido confirmado.

function linhaItem(i) {
  const qtd = Number(i.quantidade) || 1;
  const totalItem = money(Number(i.preco_unitario || 0) * qtd);
  const obs = i.observacao ? `\n   _${i.observacao}_` : '';
  return `🍱 ${qtd}x ${i.nome} — ${fmtBRL(totalItem)}${obs}`;
}

// Linha do troco: mostra a nota que o cliente vai dar E o troco que o
// entregador precisa levar — já calculado, pra ninguém fazer conta na porta.
function linhaTroco(formaPagamento, trocoPara, total) {
  if (formaPagamento !== 'dinheiro' || trocoPara == null) return null;
  if (Number(trocoPara) === 0) return '💵 Sem troco (valor certo)';
  const troco = money(Number(trocoPara) - Number(total));
  return `💵 Troco para ${fmtBRL(trocoPara)} — levo ${fmtBRL(troco)}`;
}

function montarResumoFinal({ itens, brindes, tipoEntrega, endereco, formaPagamento, trocoPara, totais, cupomCodigo }) {
  const linhas = [];
  linhas.push('🎩 *Confira seu pedido:*');
  linhas.push('');

  for (const i of parseItens(itens)) linhas.push(linhaItem(i));
  for (const b of parseItens(brindes)) {
    linhas.push(`🎁 ${Number(b.quantidade) || 1}x ${b.nome} — *cortesia*`);
  }

  linhas.push('');
  linhas.push(tipoEntrega === 'delivery'
    ? `📍 Entrega: ${endereco}`
    : '📍 Retirada no local');
  linhas.push(`💳 Pagamento: ${rotuloPagamento(formaPagamento)}`);
  linhas.push('');
  linhas.push(`🛍️ Subtotal: ${fmtBRL(totais.subtotal)}`);
  if (totais.taxaEntrega > 0) linhas.push(`🚴 Taxa de entrega: ${fmtBRL(totais.taxaEntrega)}`);
  if (totais.desconto > 0)    linhas.push(`🏷️ Desconto${cupomCodigo ? ` (${cupomCodigo})` : ''}: -${fmtBRL(totais.desconto)}`);
  linhas.push(`💰 *Total: ${fmtBRL(totais.total)}*`);

  const troco = linhaTroco(formaPagamento, trocoPara, totais.total);
  if (troco) linhas.push(troco);

  linhas.push('');
  linhas.push('_Responde *SIM* pra eu fechar o pedido, ou me diz se quer mudar algo._');

  return linhas.join('\n');
}

const ROTULO_PAGAMENTO = { pix: 'PIX', dinheiro: 'Dinheiro', cartao: 'Cartão' };
function rotuloPagamento(f) {
  return ROTULO_PAGAMENTO[String(f || '').toLowerCase()] || f || '—';
}

module.exports = {
  normalizar, parseItens, avaliarRascunho, descreverFaltando, calcularSubtotal,
  calcularTotais, montarResumoFinal, linhaTroco, rotuloPagamento, LABEL_FALTANDO,
};
