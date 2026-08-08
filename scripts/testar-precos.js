'use strict';

// Teste de regressão do bug que originou esta versão: o resumo mostrava taxa
// de R$ 5,00 e o pedido confirmado gravava R$ 10,00. Roda sem banco e sem API.
//
//   npm run test:precos

process.env.TAXA_ENTREGA = process.env.TAXA_ENTREGA || '11';

const assert = require('assert');
const { TAXA_ENTREGA, fmtBRL } = require('../src/config');
const { calcularTotais, montarResumoFinal, avaliarRascunho } = require('../src/utils/pedido');

let passou = 0;
function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  ✅ ${nome}`);
  } catch (err) {
    console.error(`  ❌ ${nome}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

// Cesta de referência dos testes de taxa: PROPOSITALMENTE abaixo de R$ 40,
// senão ganha frete grátis e deixa de exercitar o cálculo da taxa.
// 26,50 + 6,00 = R$ 32,50
const ITENS = [
  { nome: 'Marmitex Média', quantidade: 1, preco_unitario: 26.5 },
  { nome: 'Coca-Cola 350ml', quantidade: 1, preco_unitario: 6 },
];
const SUBTOTAL = 32.5;
const TOTAL_COM_TAXA = 43.5; // 32,50 + 11,00

console.log('\n🎩 Precificação do pedido\n');

teste('taxa de entrega é o valor fixo configurado', () => {
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  assert.strictEqual(t.taxaEntrega, TAXA_ENTREGA);
  assert.strictEqual(t.taxaEntrega, 11);
});

teste('retirada não cobra taxa', () => {
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'retirada' });
  assert.strictEqual(t.taxaEntrega, 0);
  assert.strictEqual(t.total, t.subtotal);
});

teste('total = subtotal + taxa - desconto', () => {
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  assert.strictEqual(t.subtotal, SUBTOTAL);
  assert.strictEqual(t.total, TOTAL_COM_TAXA);
});

teste('cupom percentual desconta do subtotal, não da taxa', () => {
  const t = calcularTotais({
    itens: ITENS, tipoEntrega: 'delivery',
    cupom: { tipo: 'desconto', desconto_percentual: 10 },
  });
  assert.strictEqual(t.desconto, 3.25);            // 10% de 32,50
  assert.strictEqual(t.total, 40.25);              // 32,50 + 11,00 - 3,25
});

teste('cupom de brinde não gera desconto percentual', () => {
  const t = calcularTotais({
    itens: ITENS, tipoEntrega: 'delivery',
    cupom: { tipo: 'brinde', desconto_percentual: 50 },
  });
  assert.strictEqual(t.desconto, 0);
});

teste('centavos não vazam por ponto flutuante', () => {
  const t = calcularTotais({
    itens: [{ nome: 'X', quantidade: 3, preco_unitario: 0.1 }],
    tipoEntrega: 'retirada',
  });
  assert.strictEqual(t.subtotal, 0.3);
});

console.log('\n🎩 Resumo final (o texto que o cliente lê)\n');

teste('o resumo mostra EXATAMENTE a taxa que o pedido vai cobrar', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua X, 100', formaPagamento: 'pix', totais,
  });

  // Este é o bug original: qualquer divergência entre o número mostrado e o
  // número cobrado tem que quebrar o teste.
  assert.ok(texto.includes(`Taxa de entrega: ${fmtBRL(totais.taxaEntrega)}`),
    `resumo não traz a taxa calculada (${fmtBRL(totais.taxaEntrega)}):\n${texto}`);
  assert.ok(texto.includes('R$ 11,00'), 'taxa impressa diferente de R$ 11,00');
  assert.ok(texto.includes(`*Total: ${fmtBRL(totais.total)}*`), 'total do resumo diverge do calculado');
  assert.ok(!texto.includes('R$ 5,00'), 'resumo voltou a mostrar a taxa antiga de R$ 5,00');
});

teste('resumo de retirada não mostra linha de taxa', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'retirada' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'retirada',
    formaPagamento: 'dinheiro', totais,
  });
  assert.ok(!texto.includes('Taxa de entrega'), 'retirada não deve exibir taxa');
  assert.ok(texto.includes('Retirada no local'));
});

teste('brinde aparece como cortesia e não entra no subtotal', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'retirada' });
  const texto = montarResumoFinal({
    itens: ITENS,
    brindes: [{ nome: 'Mini Guaraná 200ml', quantidade: 1 }],
    tipoEntrega: 'retirada', formaPagamento: 'pix', totais,
  });
  assert.ok(texto.includes('Mini Guaraná 200ml — *cortesia*'));
  assert.strictEqual(totais.subtotal, SUBTOTAL);
});

teste('resumo não usa markdown que o WhatsApp não renderiza', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua X, 100', formaPagamento: 'cartao', totais,
  });
  assert.ok(!/^#{1,6}\s/m.test(texto), 'resumo contém título markdown (#)');
  assert.ok(!/^\d+\.\s/m.test(texto), 'resumo contém lista numerada markdown');
});

console.log('\n🎩 Frete grátis acima de R$ 40\n');

const UM_ITEM_35 = [{ nome: 'Marmitex Grande', quantidade: 1, preco_unitario: 35 }];
const DOIS_ITENS_53 = [{ nome: 'Marmitex Média', quantidade: 2, preco_unitario: 26.5 }];

teste('abaixo de R$ 40 cobra a taxa cheia', () => {
  const t = calcularTotais({ itens: UM_ITEM_35, tipoEntrega: 'delivery' });
  assert.strictEqual(t.subtotal, 35);
  assert.strictEqual(t.freteGratis, false);
  assert.strictEqual(t.taxaEntrega, 11);
  assert.strictEqual(t.total, 46);
});

teste('acima de R$ 40 zera a taxa', () => {
  const t = calcularTotais({ itens: DOIS_ITENS_53, tipoEntrega: 'delivery' });
  assert.strictEqual(t.subtotal, 53);
  assert.strictEqual(t.freteGratis, true);
  assert.strictEqual(t.taxaEntrega, 0);
  assert.strictEqual(t.total, 53); // sem taxa nenhuma somada
});

teste('exatamente R$ 40 já ganha frete grátis (o limite inclui)', () => {
  const t = calcularTotais({
    itens: [{ nome: 'X', quantidade: 1, preco_unitario: 40 }], tipoEntrega: 'delivery',
  });
  assert.strictEqual(t.freteGratis, true);
  assert.strictEqual(t.taxaEntrega, 0);
});

teste('"falta para frete grátis" é exato', () => {
  const t = calcularTotais({ itens: UM_ITEM_35, tipoEntrega: 'delivery' });
  assert.strictEqual(t.faltaParaFreteGratis, 5); // 40 - 35
});

teste('retirada não fala em frete grátis (não paga taxa nenhuma)', () => {
  const t = calcularTotais({ itens: UM_ITEM_35, tipoEntrega: 'retirada' });
  assert.strictEqual(t.taxaEntrega, 0);
  assert.strictEqual(t.freteGratis, false);
  assert.strictEqual(t.faltaParaFreteGratis, 0);
});

teste('resumo mostra GRÁTIS em vez de valor quando conquistado', () => {
  const totais = calcularTotais({ itens: DOIS_ITENS_53, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: DOIS_ITENS_53, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua X, 100', formaPagamento: 'pix', totais,
  });
  assert.ok(texto.includes('Entrega: *GRÁTIS*'), `faltou destacar o frete grátis:\n${texto}`);
  assert.ok(!texto.includes('R$ 11,00'), 'não pode cobrar taxa num pedido com frete grátis');
  assert.ok(texto.includes('*Total: R$ 53,00*'));
});

teste('frete grátis + troco: o troco considera o total SEM taxa', () => {
  const totais = calcularTotais({ itens: DOIS_ITENS_53, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: DOIS_ITENS_53, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X',
    formaPagamento: 'dinheiro', trocoPara: 100, totais,
  });
  assert.ok(texto.includes('levo R$ 47,00'), `troco errado (esperado 100-53):\n${texto}`);
});

console.log('\n🎩 Troco (pagamento em dinheiro)\n');

const RASCUNHO_BASE = {
  itens: JSON.stringify(ITENS),
  nome_cliente: 'Ana',
  tipo_entrega: 'delivery',
  endereco: 'Rua X, 100',
};

teste('dinheiro sem troco definido deixa o pedido INCOMPLETO', () => {
  const av = avaliarRascunho({ ...RASCUNHO_BASE, forma_pagamento: 'dinheiro' });
  assert.ok(!av.completo, 'não deveria estar completo sem a resposta do troco');
  assert.ok(av.faltando.includes('troco'));
});

teste('troco 0 ("tenho o valor certo") COMPLETA o pedido', () => {
  const av = avaliarRascunho({ ...RASCUNHO_BASE, forma_pagamento: 'dinheiro', troco_para: 0 });
  assert.ok(av.completo, 'zero é resposta válida e não pode travar o pedido');
});

teste('pix e cartão não exigem troco', () => {
  for (const forma of ['pix', 'cartao']) {
    const av = avaliarRascunho({ ...RASCUNHO_BASE, forma_pagamento: forma });
    assert.ok(av.completo, `${forma} não deveria pedir troco`);
  }
});

teste('resumo mostra a nota do cliente E o troco já calculado', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X, 100',
    formaPagamento: 'dinheiro', trocoPara: 100, totais,
  });
  // subtotal 32,50 + taxa 11,00 = 43,50 → troco de 56,50
  assert.ok(texto.includes('Troco para R$ 100,00'), `faltou a nota do cliente:\n${texto}`);
  assert.ok(texto.includes('levo R$ 56,50'), `troco calculado errado (esperado 100 − 43,50):\n${texto}`);
});

teste('resumo com troco 0 diz "sem troco" e não mostra conta', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'retirada' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'retirada',
    formaPagamento: 'dinheiro', trocoPara: 0, totais,
  });
  assert.ok(texto.includes('Sem troco (valor certo)'));
  assert.ok(!texto.includes('levo R$'));
});

teste('pix não mostra linha de troco', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X, 100',
    formaPagamento: 'pix', trocoPara: 100, totais,
  });
  assert.ok(!texto.includes('Troco'), 'troco não faz sentido em PIX');
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
