'use strict';

// Conversa real que motivou este arquivo (12/09, cliente Eliane):
//
//   agente : "vai ser entrega ou retirada?"
//   cliente: "Entrega"                        ← respondeu
//   agente : "qual forma de pagamento?"       ← seguiu sem gravar
//   cliente: "Cartão"
//   agente : "seu pedido é pra entrega ou retirada?"   ← perguntou DE NOVO
//   cliente: "Entrega"
//   ...                                        (mais duas voltas)
//   cliente: "você faz as mesmas perguntas e não finaliza"
//
// No banco, tipo_entrega ficou NULL o tempo todo: a LLM leu a resposta e não
// chamou a tool pra gravar. Estes testes travam a correção — quem lê a
// resposta óbvia agora é o código.
//
//   npm run test:intencao

const assert = require('assert');
const {
  detectarTipoEntrega, detectarFormaPagamento,
  normalizarTipoEntrega, normalizarFormaPagamento, capturarRespostaObvia,
} = require('../src/utils/intencao');

let passou = 0;
function teste(nome, fn) {
  try { fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

console.log('\n🎩 "Entrega ou retirada?" — do jeito que o cliente responde\n');

teste('ESTE É O CASO REAL: "Entrega" vira delivery', () => {
  assert.strictEqual(detectarTipoEntrega('Entrega'), 'delivery');
});

teste('as formas que aparecem de verdade no WhatsApp', () => {
  const entrega = ['Entrega', 'entregar', 'Entregue por favor', 'pode mandar', 'quero delivery',
                   'manda aqui em casa', 'trazer'];
  for (const t of entrega) assert.strictEqual(detectarTipoEntrega(t), 'delivery', t);

  const retirada = ['Retirada', 'vou retirar', 'retiro ai', 'busco ai', 'vou buscar',
                    'pego no local', 'no balcao'];
  for (const t of retirada) assert.strictEqual(detectarTipoEntrega(t), 'retirada', t);
});

teste('NÃO decide quando a frase cita as duas (é a pergunta, não a resposta)', () => {
  for (const t of ['é entrega ou retirada?', 'entrega ou retirada', 'pode ser entrega ou retirada']) {
    assert.strictEqual(detectarTipoEntrega(t), null, t);
  }
});

teste('NÃO decide no que não é resposta — falso positivo mudaria o pedido sozinho', () => {
  for (const t of ['sim', 'ok', 'Eliane Cristina', 'quero 3 marmitas', 'bom dia', '']) {
    assert.strictEqual(detectarTipoEntrega(t), null, t);
  }
});

teste('pergunta do cliente NÃO é resposta ("vcs levam?" não fecha entrega sozinho)', () => {
  // De propósito: quem pergunta se entrega ainda não escolheu. Deixar a LLM
  // conduzir é melhor que gravar um tipo que o cliente não confirmou.
  assert.strictEqual(detectarTipoEntrega('vcs levam?'), null);
});

console.log('\n🎩 Forma de pagamento\n');

teste('pix, cartão e dinheiro nas formas usuais', () => {
  for (const t of ['PIX', 'vou pagar no pix', 'pix mesmo']) assert.strictEqual(detectarFormaPagamento(t), 'pix', t);
  for (const t of ['Cartão', 'cartao de credito', 'no debito', 'maquininha']) assert.strictEqual(detectarFormaPagamento(t), 'cartao', t);
  for (const t of ['dinheiro', 'em especie', 'vou pagar em dinheiro']) assert.strictEqual(detectarFormaPagamento(t), 'dinheiro', t);
});

teste('NÃO decide quando a frase cita duas formas', () => {
  assert.strictEqual(detectarFormaPagamento('pix ou cartão?'), null);
  assert.strictEqual(detectarFormaPagamento('aceita dinheiro e pix?'), null);
});

console.log('\n🎩 O que a LLM manda também é normalizado\n');

teste('português da LLM vira o valor canônico', () => {
  assert.strictEqual(normalizarTipoEntrega('entrega'), 'delivery');
  assert.strictEqual(normalizarTipoEntrega('Entrega'), 'delivery');
  assert.strictEqual(normalizarTipoEntrega('delivery'), 'delivery');
  assert.strictEqual(normalizarTipoEntrega('retirada'), 'retirada');
  assert.strictEqual(normalizarFormaPagamento('cartão'), 'cartao');
  assert.strictEqual(normalizarFormaPagamento('CARTAO'), 'cartao');
  assert.strictEqual(normalizarFormaPagamento('pix'), 'pix');
});

teste('valor sem sentido não entra no banco', () => {
  assert.strictEqual(normalizarTipoEntrega('qualquer coisa'), null);
  assert.strictEqual(normalizarFormaPagamento('boleto'), null);
});

console.log('\n🎩 Só grava o campo que está faltando\n');

teste('grava o tipo de entrega quando é ele que falta', () => {
  const c = capturarRespostaObvia(['tipo_entrega', 'forma_pagamento'], 'Entrega');
  assert.strictEqual(c.tipo_entrega, 'delivery');
  assert.strictEqual(c.forma_pagamento, undefined);
});

teste('NÃO mexe em campo que já está preenchido', () => {
  // tipo_entrega não está na lista de faltantes: já foi respondido antes e não
  // pode ser trocado só porque a palavra apareceu de novo na conversa.
  const c = capturarRespostaObvia(['forma_pagamento'], 'pode entregar, pago no pix');
  assert.strictEqual(c.tipo_entrega, undefined);
  assert.strictEqual(c.forma_pagamento, 'pix');
});

teste('a rajada da Eliane, na ordem em que aconteceu', () => {
  // 1) falta tudo; ela responde o tipo
  let c = capturarRespostaObvia(['nome', 'tipo_entrega', 'forma_pagamento'], 'Entrega');
  assert.strictEqual(c.tipo_entrega, 'delivery');
  // 2) agora falta pagamento; ela responde "Cartão"
  c = capturarRespostaObvia(['nome', 'forma_pagamento'], 'Cartão');
  assert.strictEqual(c.forma_pagamento, 'cartao');
  // 3) nada mais a capturar: o pedido não volta a perguntar o que já tem
  c = capturarRespostaObvia([], 'Entrega');
  assert.deepStrictEqual(Object.keys(c), []);
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
