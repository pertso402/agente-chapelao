'use strict';

// Teste de regressão do bug que originou esta versão: o resumo mostrava taxa
// de R$ 5,00 e o pedido confirmado gravava R$ 10,00. Roda sem banco e sem API.
//
//   npm run test:precos

const assert = require('assert');
const { TAXA_ENTREGA_PADRAO, fmtBRL } = require('../src/config');
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

// Cesta de referência: 26,50 + 6,00 = R$ 32,50
const ITENS = [
  { nome: 'Marmitex Média', quantidade: 1, preco_unitario: 26.5 },
  { nome: 'Coca-Cola 350ml', quantidade: 1, preco_unitario: 6 },
];
const SUBTOTAL = 32.5;
const TAXA = 11;            // valor de exemplo, digitado no painel
const TOTAL_COM_TAXA = 43.5; // 32,50 + 11,00

console.log('\n🎩 Precificação do pedido\n');

teste('a taxa cobrada é exatamente a que veio de fora (calculada à mão)', () => {
  for (const valor of [7, 11, 18.5, 0]) {
    const t = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: valor });
    assert.strictEqual(t.taxaEntrega, valor, `taxa ${valor} não foi respeitada`);
  }
});

teste('não existe mais taxa fixa embutida no cálculo', () => {
  // Sem taxa informada, o cálculo NÃO pode inventar um valor padrão: o pedido
  // fica incompleto de propósito (ver avaliarRascunho) até alguém digitar.
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery' });
  assert.strictEqual(t.taxaEntrega, 0);
});

teste('retirada não cobra taxa nem que mandem uma', () => {
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'retirada', taxaEntrega: 15 });
  assert.strictEqual(t.taxaEntrega, 0);
  assert.strictEqual(t.total, t.subtotal);
});

teste('total = subtotal + taxa - desconto', () => {
  const t = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA });
  assert.strictEqual(t.subtotal, SUBTOTAL);
  assert.strictEqual(t.total, TOTAL_COM_TAXA);
});

teste('cupom percentual desconta do subtotal, não da taxa', () => {
  const t = calcularTotais({
    itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA,
    cupom: { tipo: 'desconto', desconto_percentual: 10 },
  });
  assert.strictEqual(t.desconto, 3.25);            // 10% de 32,50
  assert.strictEqual(t.total, 40.25);              // 32,50 + 11,00 - 3,25
});

teste('cupom de brinde não gera desconto percentual', () => {
  const t = calcularTotais({
    itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA,
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

console.log('\n🎩 Taxa calculada à mão (fluxo do painel)\n');

const RASCUNHO_DELIVERY = {
  itens: JSON.stringify(ITENS),
  nome_cliente: 'Ana',
  tipo_entrega: 'delivery',
  endereco: 'Rua X, 100',
  forma_pagamento: 'pix',
};

teste('delivery SEM taxa calculada fica incompleto', () => {
  const av = avaliarRascunho(RASCUNHO_DELIVERY);
  assert.ok(!av.completo, 'não pode fechar pedido sem saber a taxa — o total sairia errado');
  assert.ok(av.faltando.includes('taxa_entrega'));
});

teste('delivery COM taxa calculada completa o pedido', () => {
  const av = avaliarRascunho({ ...RASCUNHO_DELIVERY, taxa_entrega: 14 });
  assert.ok(av.completo, `ainda falta: ${av.faltando.join(', ')}`);
});

teste('taxa zero é resposta válida (entrega cortesia daquele endereço)', () => {
  const av = avaliarRascunho({ ...RASCUNHO_DELIVERY, taxa_entrega: 0 });
  assert.ok(av.completo, 'zero é um valor, não "sem resposta"');
});

teste('retirada não espera taxa nenhuma', () => {
  const av = avaliarRascunho({
    itens: JSON.stringify(ITENS), nome_cliente: 'Ana',
    tipo_entrega: 'retirada', forma_pagamento: 'pix',
  });
  assert.ok(av.completo);
  assert.ok(!av.faltando.includes('taxa_entrega'));
});

teste('o valor padrão do timeout existe e é um número usável', () => {
  // Rede de segurança dos 5 minutos: se ninguém digitar, é este valor que sai.
  assert.ok(Number.isFinite(TAXA_ENTREGA_PADRAO) && TAXA_ENTREGA_PADRAO >= 0);
});

console.log('\n🎩 Resumo final (o texto que o cliente lê)\n');

teste('o resumo mostra EXATAMENTE a taxa que o pedido vai cobrar', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua X, 100', formaPagamento: 'pix', totais,
  });

  // Este é o bug original: qualquer divergência entre o número mostrado e o
  // número cobrado tem que quebrar o teste.
  assert.ok(texto.includes(`Taxa de entrega: ${fmtBRL(totais.taxaEntrega)}`),
    `resumo não traz a taxa calculada (${fmtBRL(totais.taxaEntrega)}):\n${texto}`);
  assert.ok(texto.includes(`*Total: ${fmtBRL(totais.total)}*`), 'total do resumo diverge do calculado');
  assert.ok(!texto.includes('R$ 5,00'), 'resumo voltou a mostrar a taxa antiga de R$ 5,00');
});

teste('taxa diferente muda o texto E o total juntos', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: 18.5 });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua Longe, 900', formaPagamento: 'pix', totais,
  });
  assert.ok(texto.includes('Taxa de entrega: R$ 18,50'), `taxa não apareceu:\n${texto}`);
  assert.ok(texto.includes('*Total: R$ 51,00*'), `total errado (32,50 + 18,50):\n${texto}`);
});

teste('resumo nunca promete frete grátis', () => {
  const totais = calcularTotais({
    itens: [{ nome: 'Marmitex Média', quantidade: 3, preco_unitario: 26.5 }],
    tipoEntrega: 'delivery', taxaEntrega: 9,
  });
  const texto = montarResumoFinal({
    itens: [{ nome: 'Marmitex Média', quantidade: 3, preco_unitario: 26.5 }],
    brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X', formaPagamento: 'pix', totais,
  });
  assert.ok(!/gr[áa]tis/i.test(texto), `frete grátis foi removido do negócio:\n${texto}`);
  assert.ok(texto.includes('Taxa de entrega: R$ 9,00'), 'pedido grande também paga entrega');
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
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery',
    endereco: 'Rua X, 100', formaPagamento: 'cartao', totais,
  });
  assert.ok(!/^#{1,6}\s/m.test(texto), 'resumo contém título markdown (#)');
  assert.ok(!/^\d+\.\s/m.test(texto), 'resumo contém lista numerada markdown');
});

console.log('\n🎩 Troco (pagamento em dinheiro)\n');

const RASCUNHO_BASE = {
  itens: JSON.stringify(ITENS),
  nome_cliente: 'Ana',
  tipo_entrega: 'delivery',
  endereco: 'Rua X, 100',
  taxa_entrega: TAXA,
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
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X, 100',
    formaPagamento: 'dinheiro', trocoPara: 100, totais,
  });
  // subtotal 32,50 + taxa 11,00 = 43,50 → troco de 56,50
  assert.ok(texto.includes('Troco para R$ 100,00'), `faltou a nota do cliente:\n${texto}`);
  assert.ok(texto.includes('levo R$ 56,50'), `troco calculado errado (esperado 100 − 43,50):\n${texto}`);
});

teste('o troco acompanha a taxa: taxa maior, troco menor', () => {
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: 20 });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua Longe',
    formaPagamento: 'dinheiro', trocoPara: 100, totais,
  });
  // 32,50 + 20,00 = 52,50 → troco 47,50. Se o troco fosse calculado sobre um
  // total sem taxa, o entregador sairia com R$ 20 a mais na mão.
  assert.ok(texto.includes('levo R$ 47,50'), `troco não considerou a taxa nova:\n${texto}`);
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
  const totais = calcularTotais({ itens: ITENS, tipoEntrega: 'delivery', taxaEntrega: TAXA });
  const texto = montarResumoFinal({
    itens: ITENS, brindes: [], tipoEntrega: 'delivery', endereco: 'Rua X, 100',
    formaPagamento: 'pix', trocoPara: 100, totais,
  });
  assert.ok(!texto.includes('Troco'), 'troco não faz sentido em PIX');
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
