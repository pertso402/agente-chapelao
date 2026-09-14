'use strict';

// Quantas perguntas o atendimento exige até poder fechar o pedido.
//
// Duas conversas reais motivaram este arquivo:
//
//  • Kétilin (14/09): o agente perguntou "precisa de troco pra quanto?" CINCO
//    vezes, antes de a entrega ter sido calculada. Ela não tinha como
//    responder — nem ela nem o agente sabiam o total. Ela perguntou "quanto
//    deu?" duas vezes e recebeu a pergunta do troco de volta.
//
//  • Dona Fátima (14/09): "Por que tantas repetições de perguntas?" e desistiu
//    depois de 40 minutos.
//
//   npm run test:fluxo

const assert = require('assert');
const { avaliarRascunho, montarResumoFinal, calcularTotais } = require('../src/utils/pedido');

let passou = 0;
function teste(nome, fn) {
  try { fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

const ITENS = JSON.stringify([{ nome: 'Marmitex Média', quantidade: 1, preco_unitario: 21 }]);

console.log('\n🎩 Troco só é cobrado quando já existe total\n');

teste('ESTE É O CASO REAL: dinheiro sem a entrega calculada NÃO pede troco', () => {
  const av = avaliarRascunho({
    itens: ITENS, nome_cliente: 'Kétilin', tipo_entrega: 'delivery',
    endereco: 'Av. Paraná', forma_pagamento: 'dinheiro', taxa_entrega: null,
  });
  assert.ok(!av.faltando.includes('troco'),
    'pediu troco antes de saber o total — foi o que se repetiu 5 vezes');
  assert.ok(av.faltando.includes('taxa_entrega'), 'o que falta é a entrega, não o troco');
});

teste('com a entrega calculada, aí sim pede o troco', () => {
  const av = avaliarRascunho({
    itens: ITENS, nome_cliente: 'Kétilin', tipo_entrega: 'delivery',
    endereco: 'Av. Paraná', forma_pagamento: 'dinheiro', taxa_entrega: 11,
  });
  assert.ok(av.faltando.includes('troco'));
  assert.ok(!av.completo);
});

teste('troco é a ÚLTIMA pendência, nunca a primeira', () => {
  const av = avaliarRascunho({
    itens: ITENS, tipo_entrega: 'delivery', endereco: 'Rua X',
    forma_pagamento: 'dinheiro', taxa_entrega: 11,
  });
  assert.strictEqual(av.faltando[av.faltando.length - 1], 'troco');
  assert.strictEqual(av.faltando[0], 'nome', 'a primeira pendência devia ser o nome');
});

teste('retirada em dinheiro nem chega a pedir troco', () => {
  const av = avaliarRascunho({
    itens: ITENS, nome_cliente: 'Ana', tipo_entrega: 'retirada', forma_pagamento: 'dinheiro',
  });
  assert.ok(!av.faltando.includes('troco'), 'na retirada o troco acontece no balcão');
  assert.ok(av.completo, `devia estar completo, falta: ${av.faltando.join(', ')}`);
});

console.log('\n🎩 Retirada não pergunta forma de pagamento\n');

teste('retirada fecha SEM forma de pagamento', () => {
  const av = avaliarRascunho({ itens: ITENS, nome_cliente: 'Ana', tipo_entrega: 'retirada' });
  assert.ok(!av.faltando.includes('forma_pagamento'), 'ainda exige pagamento na retirada');
  assert.ok(av.completo, `devia estar completo, falta: ${av.faltando.join(', ')}`);
});

teste('mas se o cliente informar, o pagamento é registrado', () => {
  const av = avaliarRascunho({
    itens: ITENS, nome_cliente: 'Ana', tipo_entrega: 'retirada', forma_pagamento: 'pix',
  });
  assert.ok(av.completo);
});

teste('ENTREGA continua exigindo forma de pagamento', () => {
  const av = avaliarRascunho({
    itens: ITENS, nome_cliente: 'Ana', tipo_entrega: 'delivery', endereco: 'Rua X', taxa_entrega: 11,
  });
  assert.ok(av.faltando.includes('forma_pagamento'),
    'no delivery a forma decide a plataforma da corrida — não dá pra pular');
});

teste('o resumo da retirada diz onde se paga, em vez de mostrar "—"', () => {
  const totais = calcularTotais({ itens: [{ nome: 'Marmitex Média', quantidade: 1, preco_unitario: 21 }], tipoEntrega: 'retirada' });
  const texto = montarResumoFinal({
    itens: [{ nome: 'Marmitex Média', quantidade: 1, preco_unitario: 21 }],
    brindes: [], tipoEntrega: 'retirada', formaPagamento: null, totais,
  });
  assert.ok(texto.includes('na retirada, no balcão'), `resumo ficou estranho:\n${texto}`);
  assert.ok(!texto.includes('Pagamento: —'));
});

console.log('\n🎩 Quantas perguntas o pedido exige (menos é melhor)\n');

// Cada item de "faltando" é uma pergunta que o agente precisa fazer.
function perguntasAteFechar(rascunhoInicial, respostas) {
  let r = { ...rascunhoInicial };
  let perguntas = 0;
  for (let i = 0; i < 12; i++) {
    const av = avaliarRascunho(r);
    if (av.completo) break;
    const alvo = av.faltando[0];
    if (alvo === 'taxa_entrega') { r.taxa_entrega = 11; continue; }  // não é pergunta: é a equipe
    if (!(alvo in respostas)) throw new Error(`sem resposta pra "${alvo}"`);
    Object.assign(r, respostas[alvo]);
    perguntas++;
  }
  return perguntas;
}

teste('RETIRADA fecha em no máximo 2 perguntas depois dos itens', () => {
  const n = perguntasAteFechar(
    { itens: ITENS },
    { nome: { nome_cliente: 'Ana' }, tipo_entrega: { tipo_entrega: 'retirada' } },
  );
  assert.ok(n <= 2, `precisou de ${n} perguntas`);
});

teste('ENTREGA no cartão fecha em no máximo 4 perguntas depois dos itens', () => {
  const n = perguntasAteFechar(
    { itens: ITENS },
    {
      nome: { nome_cliente: 'Ana' },
      tipo_entrega: { tipo_entrega: 'delivery' },
      endereco: { endereco: 'Rua X, 100' },
      forma_pagamento: { forma_pagamento: 'cartao' },
    },
  );
  assert.ok(n <= 4, `precisou de ${n} perguntas`);
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
