'use strict';

// Teste de regressão do bug que originou esta versão: o resumo mostrava taxa
// de R$ 5,00 e o pedido confirmado gravava R$ 10,00. Roda sem banco e sem API.
//
//   npm run test:precos

process.env.TAXA_ENTREGA = process.env.TAXA_ENTREGA || '11';

const assert = require('assert');
const { TAXA_ENTREGA, fmtBRL } = require('../src/config');
const { calcularTotais, montarResumoFinal } = require('../src/utils/pedido');

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

const ITENS = [
  { nome: 'Marmitex Média', quantidade: 2, preco_unitario: 26.5 },
  { nome: 'Coca-Cola 350ml', quantidade: 1, preco_unitario: 6 },
];

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
  assert.strictEqual(t.subtotal, 59);
  assert.strictEqual(t.total, 70);
});

teste('cupom percentual desconta do subtotal, não da taxa', () => {
  const t = calcularTotais({
    itens: ITENS, tipoEntrega: 'delivery',
    cupom: { tipo: 'desconto', desconto_percentual: 10 },
  });
  assert.strictEqual(t.desconto, 5.9);
  assert.strictEqual(t.total, 64.1); // 59 + 11 - 5.90
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
  assert.strictEqual(totais.subtotal, 59);
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

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
