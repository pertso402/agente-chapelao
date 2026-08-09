'use strict';

// Teste de fumaça: EXECUTA as rotinas de fundo com o banco falsificado.
//
// Existe por causa de um bug real: `sincronizarLoja` rodou um dia inteiro em
// produção falhando com "decidirLoja is not defined" — a função estava
// exportada no config mas faltava no require do index. Foram 2145 falhas
// silenciosas: a loja nunca abriu nem fechou sozinha, e ninguém viu, porque o
// erro era engolido pelo try/catch do poller.
//
// `node --check` NÃO pega isso: ele valida sintaxe, não referência indefinida.
// Só chamar a função pega. É isso que este arquivo faz.
//
//   npm run test:fumaca

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';
process.env.EVOLUTION_URL = 'https://falso';

const assert = require('assert');
const path = require('path');

// ─── Banco falso ──────────────────────────────────────────────────────────────
// Substitui o módulo do Supabase ANTES de carregar o index, para nenhuma
// consulta sair da máquina.
const caminhoDb = require.resolve('../src/services/supabase.js');
const chamadas = [];

require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: new Proxy({}, {
    get(_alvo, nome) {
      if (nome === 'then') return undefined; // não confundir com Promise
      return async (...args) => {
        chamadas.push(String(nome));
        switch (nome) {
          case 'buscarLojaAberta': return true;
          case 'lerMarcador': return null;          // ainda não agiu hoje
          case 'reivindicarFollowups': return [];
          case 'reivindicarTravados': return [];
          default: return null;
        }
      };
    },
  }),
};

// Falha o teste se QUALQUER erro for só registrado no log em vez de estourar —
// era exatamente assim que o bug ficou invisível.
const logger = require('../src/logger');
const errosRegistrados = [];
const erroOriginal = logger.error;
logger.error = (etapa, mensagem, extra) => {
  errosRegistrados.push({ etapa, mensagem });
  return erroOriginal.call(logger, etapa, mensagem, extra);
};

const app = require('../src/index.js');

let passou = 0;
async function teste(nome, fn) {
  errosRegistrados.length = 0;
  chamadas.length = 0;
  try {
    await fn();
    const falhas = errosRegistrados.filter(e => /is not defined|is not a function|cannot read/i.test(e.mensagem || ''));
    if (falhas.length) {
      throw new Error(`erro de programação engolido pelo try/catch: ${falhas.map(f => `${f.etapa}: ${f.mensagem}`).join(' | ')}`);
    }
    passou++;
    console.log(`  ✅ ${nome}`);
  } catch (err) {
    console.error(`  ❌ ${nome}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\n🎩 Rotinas de fundo executam de verdade\n');

  await teste('o módulo carrega sem subir servidor nem timer', () => {
    assert.ok(app.sincronizarLoja, 'sincronizarLoja não foi exportada');
    assert.ok(app.pollarFollowups, 'pollarFollowups não foi exportada');
    assert.ok(app.pollar, 'pollar não foi exportada');
  });

  await teste('ESTE É O BUG: sincronizarLoja roda sem "is not defined"', async () => {
    await app.sincronizarLoja();
    assert.ok(chamadas.includes('buscarLojaAberta'),
      'nem chegou a consultar a loja — a função quebrou antes');
    assert.ok(chamadas.includes('lerMarcador'),
      'não leu os marcadores de abertura/fechamento');
  });

  await teste('pollarFollowups roda sem quebrar', async () => {
    await app.pollarFollowups();
  });

  await teste('pollarTravados roda sem quebrar', async () => {
    await app.pollarTravados();
  });

  await teste('o ciclo completo do poller roda sem quebrar', async () => {
    await app.pollar();
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
