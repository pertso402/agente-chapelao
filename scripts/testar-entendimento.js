'use strict';

// O cliente responde do jeito dele, não do jeito que o roteiro espera. Três
// casos reais que o sistema deixou passar:
//
//   1. Cliente respondeu o resumo com 👍 — pedido nunca foi criado.
//   2. Cliente digitou "sim[" (tecla errada) — recebeu o resumo de novo.
//   3. Cliente pediu salada — o código descartava em silêncio, porque salada
//      não estava marcada no cardápio do dia. O agente dizia "incluí" e a
//      cozinha nunca via.
//
//   npm run test:entendimento

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

// Banco falso — nada sai da máquina.
const caminhoDb = require.resolve('../src/services/supabase.js');
require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: new Proxy({}, {
    get(_a, nome) {
      if (nome === 'then') return undefined;
      return async () => (nome === 'carregarHistorico' ? [] : null);
    },
  }),
};

const { _testes } = require('../src/index.js');
const { ehConfirmacao } = _testes;
const { extrairMensagem } = require('../src/services/evolution.js');

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

console.log('\n🎩 "Sim" do jeito que o cliente escreve\n');

teste('ESTE É O CASO REAL: 👍 confirma o pedido', () => {
  assert.ok(ehConfirmacao('👍'), 'joinha não foi entendido como sim');
});

teste('joinha com tom de pele também', () => {
  for (const j of ['👍🏻', '👍🏽', '👍🏿']) assert.ok(ehConfirmacao(j), j);
});

teste('outros emojis de acordo', () => {
  for (const e of ['👌', '✅', '🙏', '🤝']) assert.ok(ehConfirmacao(e), e);
});

teste('ESTE É O OUTRO CASO REAL: "sim[" (tecla errada) confirma', () => {
  assert.ok(ehConfirmacao('sim['), 'a pontuação solta derrubou a confirmação');
});

teste('pontuação sobrando não atrapalha', () => {
  for (const t of ['sim!!', 'SIM.', '.sim', 'ok!', 'blz...', 'isso!']) {
    assert.ok(ehConfirmacao(t), t);
  }
});

teste('frase natural continua valendo', () => {
  for (const t of ['sim, pode fechar', 'isso mesmo, obrigado', 'pode confirmar']) {
    assert.ok(ehConfirmacao(t), t);
  }
});

teste('ressalva NÃO é confirmação (não pode fechar pedido errado)', () => {
  for (const t of ['sim, mas troca o refrigerante', 'isso, só que sem cebola', 'espera']) {
    assert.ok(!ehConfirmacao(t), `"${t}" não podia fechar o pedido`);
  }
});

teste('emoji que não é acordo não confirma', () => {
  for (const e of ['👎', '😡', '❓', '🤔']) assert.ok(!ehConfirmacao(e), e);
});

console.log('\n🎩 Reação do WhatsApp chega até o agente\n');

const webhook = (message, messageType) => ({
  data: {
    key: { remoteJid: '5544999@s.whatsapp.net', fromMe: false, id: 'abc' },
    pushName: 'Ana', messageType, message,
  },
});

teste('reagir com 👍 vira uma mensagem de texto "👍"', () => {
  const msg = extrairMensagem(webhook(
    { reactionMessage: { text: '👍', key: { id: 'msg-do-bot' } } },
    'reactionMessage',
  ));
  assert.ok(msg, 'a reação foi descartada como tipo não suportado');
  assert.strictEqual(msg.texto, '👍');
  assert.ok(ehConfirmacao(msg.texto), 'chegou, mas não contou como sim');
});

teste('tirar a reação (texto vazio) é ignorado', () => {
  const msg = extrairMensagem(webhook(
    { reactionMessage: { text: '', key: { id: 'msg-do-bot' } } },
    'reactionMessage',
  ));
  assert.strictEqual(msg, null, 'remover a reação não pode virar mensagem');
});

console.log('\n🎩 Salada tem todo dia\n');

// A regra vive no validador do pedido: reproduzimos aqui o teste do nome,
// que é o que decidia entre incluir e descartar em silêncio.
const { normalizar } = require('../src/utils/pedido');
const ehSalada = (nome) => /salad/.test(normalizar(nome));

teste('as formas que o cliente escreve são reconhecidas', () => {
  for (const s of ['Salada', 'salada', 'SALADA', 'salada verde', 'saladinha', 'Salada de alface']) {
    assert.ok(ehSalada(s), s);
  }
});

teste('não confunde com outro acompanhamento', () => {
  for (const s of ['Arroz', 'Feijão', 'Batata frita', 'Farofa']) {
    assert.ok(!ehSalada(s), s);
  }
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
