'use strict';

// No WhatsApp as pessoas escrevem em rajada. Numa conversa real o cliente
// mandou "Olá! Posso ter mais informações sobre isso?" · "Só pra salvar o
// número" · "Blz" em segundos, e o agente respondeu TRÊS vezes, perguntando
// nas três "prefere Pequena, Média ou Grande?". Ficou com cara de robô.
//
// Este teste trava o comportamento: rajada de texto = UMA resposta.
//
//   npm run test:agrupamento

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';
process.env.AGRUPAR_MSG_SEG = '0.05'; // 50ms, pro teste não demorar

const assert = require('assert');

// Banco falso — nada sai da máquina.
const caminhoDb = require.resolve('../src/services/supabase.js');
require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: new Proxy({}, {
    get(_a, nome) {
      if (nome === 'then') return undefined;
      return async () => {
        if (nome === 'carregarHistorico') return [];
        if (nome === 'buscarLojaAberta') return true;   // loja aberta, senão o portão responde antes
        if (nome === 'verificarPausa') return false;
        return null;
      };
    },
  }),
};

// Espião no lugar da LLM. Tem que ser instalado ANTES de carregar o index:
// ele desestrutura rodarAgente no require, então trocar o export depois não
// mudaria mais nada.
const rodadas = [];
const caminhoAgente = require.resolve('../src/agent.js');
require.cache[caminhoAgente] = {
  id: caminhoAgente, filename: caminhoAgente, loaded: true,
  exports: {
    rodarAgente: async (texto) => {
      rodadas.push(texto);
      return { texto: 'ok', atendenteChamado: false, mostrouCardapio: false };
    },
    confirmarPedido: async () => ({}),
    gerarFollowup: async () => null,
    modeloEmUso: () => ({}),
  },
};

// Evolution falsa: o teste é sobre agrupamento, não sobre envio.
const caminhoEvo = require.resolve('../src/services/evolution.js');
const evoReal = require('../src/services/evolution.js');
require.cache[caminhoEvo].exports = {
  ...evoReal,
  enviarTexto: async () => {},
  enviarMidia: async () => {},
  manterDigitando: () => () => {},
  downloadMidia: async () => ({ base64: '', mimetype: 'audio/ogg' }),
};

const app = require('../src/index.js');
const { agruparMensagem } = app._testes;

const texto = (t, id) => ({
  telefone: '5544999', pushName: 'Silvia', tipo: 'text', texto: t,
  key: { id }, msgId: id,
});
const audio = (id) => ({
  telefone: '5544999', pushName: 'Silvia', tipo: 'audioMessage', texto: '',
  key: { id }, msgId: id,
});

const espera = (ms) => new Promise(r => setTimeout(r, ms));

let passou = 0;
async function teste(nome, fn) {
  rodadas.length = 0;
  try {
    await fn();
    passou++;
    console.log(`  ✅ ${nome}`);
  } catch (err) {
    console.error(`  ❌ ${nome}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\n🎩 Rajada de mensagens vira UMA resposta\n');

  await teste('ESTE É O CASO REAL: 3 mensagens em segundos = 1 rodada só', async () => {
    agruparMensagem(texto('Olá! Posso ter mais informações sobre isso?', 'a1'), 'req');
    agruparMensagem(texto('So pra salva o número', 'a2'), 'req');
    agruparMensagem(texto('Blz', 'a3'), 'req');
    await espera(200);
    assert.strictEqual(rodadas.length, 1,
      `o agente respondeu ${rodadas.length} vezes — era isso que deixava a conversa robótica`);
  });

  await teste('o texto das três chega junto, na ordem, sem perder nada', async () => {
    agruparMensagem(texto('Boa tarde', 'b1'), 'req');
    agruparMensagem(texto('quero uma marmita média', 'b2'), 'req');
    await espera(200);
    // O texto vai prefixado com [Cliente: ...] pelo index — o que importa é que
    // as duas frases chegaram juntas, na ordem, numa rodada só.
    assert.strictEqual(rodadas.length, 1);
    assert.ok(rodadas[0].includes('Boa tarde\nquero uma marmita média'), rodadas[0]);
  });

  await teste('mensagem sozinha continua respondendo normalmente', async () => {
    agruparMensagem(texto('oi', 'c1'), 'req');
    await espera(200);
    assert.strictEqual(rodadas.length, 1);
    assert.ok(rodadas[0].endsWith('oi'), rodadas[0]);
  });

  await teste('quem escreve sem parar não fica sem resposta (teto de espera)', async () => {
    for (let i = 0; i < 12; i++) {
      agruparMensagem(texto(`msg ${i}`, `d${i}`), 'req');
      await espera(30); // sempre reiniciaria o relógio, se não houvesse teto
    }
    await espera(300);
    assert.ok(rodadas.length >= 1, 'ficou esperando pra sempre e nunca respondeu');
  });

  await teste('áudio não espera nem se mistura com texto', async () => {
    agruparMensagem(texto('escuta isso', 'e1'), 'req');
    agruparMensagem(audio('e2'), 'req');
    await espera(300);
    // O texto vira uma rodada e o áudio outra: juntar mudaria o significado
    // (áudio precisa ser transcrito antes de virar conversa).
    assert.ok(rodadas.some(r => String(r).includes('escuta isso')),
      'o texto acumulado foi engolido pelo áudio');
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
