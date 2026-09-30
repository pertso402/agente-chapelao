'use strict';

// Conversa real (14/09, cliente Jessica):
//
//   12:04 agente : "Anotei: 1x Marmitex Pequena ✅ Quais carnes você quer?"
//   12:08 cliente: "Filé de frango e carne de panela"
//   12:08 agente : "Oi, Jessica! 😊 Quais carnes você prefere na sua marmita?"
//
// A segunda pergunta não foi o agente respondendo — foi o FOLLOW-UP, que tinha
// sido disparado pelo silêncio e saiu no mesmo minuto em que ela respondeu.
// Para quem lia a conversa, o agente perguntou duas vezes a mesma coisa.
//
// A corrida acontece porque entre reivindicar o follow-up e ter o texto pronto
// existe uma chamada ao modelo, que leva segundos. Estes testes travam as duas
// saídas: não mandar se o cliente está escrevendo, e não mandar se ele
// respondeu enquanto o texto era gerado.
//
//   npm run test:followup

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

const estado = {
  rascunho: null,        // o que carregarRascunho devolve AGORA
  reivindicados: [],     // o que o poller recebe do claim
  enviados: [],          // mensagens que chegaram ao cliente
  devolvidos: [],        // follow-ups devolvidos pra fila
};

const caminhoDb = require.resolve('../src/services/supabase.js');
require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: new Proxy({}, {
    get(_a, nome) {
      if (nome === 'then') return undefined;
      return async (...args) => {
        switch (nome) {
          case 'buscarLojaAberta': return true;
          case 'verificarPausa': return false;
          case 'reivindicarFollowups': return estado.reivindicados;
          case 'reivindicarTravados': return [];
          case 'buscarTaxasEstouradas': return [];
          case 'reivindicarAvisosDeTaxa': return [];
          case 'carregarHistorico': return [];
          case 'carregarRascunho': return estado.rascunho;
          case 'salvarRascunho':
            if (args[1] && args[1].followup_enviado === false) estado.devolvidos.push(args[0]);
            return null;
          default: return null;
        }
      };
    },
  }),
};

// Agente falso: o follow-up "demora" pra ficar pronto, como na vida real.
const caminhoAgente = require.resolve('../src/agent.js');
require.cache[caminhoAgente] = {
  id: caminhoAgente, filename: caminhoAgente, loaded: true,
  exports: {
    rodarAgente: async () => ({ texto: 'ok', atendenteChamado: false, mostrouCardapio: false }),
    confirmarPedido: async () => ({}),
    gerarFollowup: async () => {
      await new Promise(r => setTimeout(r, 30));   // a chamada ao modelo
      return 'Oi, Jessica! 😊 Quais carnes você prefere na sua marmita pequena?';
    },
    modeloEmUso: () => ({}),
    relatorioDeConsumo: () => ({}),
  },
};

const caminhoEvo = require.resolve('../src/services/evolution.js');
const evoReal = require('../src/services/evolution.js');
require.cache[caminhoEvo].exports = {
  ...evoReal,
  enviarTexto: async (tel, texto) => { estado.enviados.push({ tel, texto }); },
  enviarMidia: async () => {},
  manterDigitando: () => () => {},
};

const app = require('../src/index.js');
const { pollarFollowups } = app;
const { agruparMensagem } = app._testes;

const TEL = '5544999';
const rascunhoBase = (ultimaMsgEm, role) => ({
  telefone: TEL, etapa_atual: 'coletando_dados',
  itens: '[{"nome":"Marmitex Pequena","quantidade":1}]',
  ultima_msg_em: ultimaMsgEm, ultima_msg_role: role,
});

let passou = 0;
async function teste(nome, fn) {
  estado.enviados = []; estado.devolvidos = []; estado.reivindicados = [];
  try { await fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('\n🎩 Follow-up não fala por cima do cliente\n');

  const vinteMinAtras = new Date(Date.now() - 20 * 60_000).toISOString();

  await teste('silêncio de verdade: o follow-up sai', async () => {
    estado.reivindicados = [rascunhoBase(vinteMinAtras, 'assistant')];
    estado.rascunho = rascunhoBase(vinteMinAtras, 'assistant');
    await pollarFollowups();
    assert.strictEqual(estado.enviados.length, 1, 'não mandou follow-up depois de 20min de silêncio');
  });

  await teste('ESTE É O CASO REAL: cliente respondeu enquanto o texto era gerado', async () => {
    estado.reivindicados = [rascunhoBase(vinteMinAtras, 'assistant')];
    // Quando o texto ficar pronto, o banco já mostra a resposta dela.
    estado.rascunho = rascunhoBase(new Date().toISOString(), 'user');
    await pollarFollowups();
    assert.strictEqual(estado.enviados.length, 0,
      'mandou o follow-up por cima da resposta do cliente — foi o que a Jessica viu');
    assert.ok(estado.devolvidos.includes(TEL), 'não devolveu o follow-up pra fila');
  });

  await teste('cliente digitando agora (mensagem na janela de agrupamento)', async () => {
    estado.reivindicados = [rascunhoBase(vinteMinAtras, 'assistant')];
    estado.rascunho = rascunhoBase(vinteMinAtras, 'assistant');
    // Mensagem dela acabou de chegar e está esperando os segundos de silêncio.
    agruparMensagem({ telefone: TEL, pushName: 'Jessica', tipo: 'text',
                      texto: 'Filé de frango e carne de panela', key: { id: 'x' }, msgId: 'x' }, 'req');
    await pollarFollowups();
    assert.strictEqual(estado.enviados.length, 0, 'falou por cima de quem estava escrevendo');
    assert.ok(estado.devolvidos.includes(TEL), 'não devolveu o follow-up pra fila');
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
