'use strict';

// Teste de regressão dos parâmetros da chamada ao modelo.
//
// Bug que originou este arquivo (visto em produção):
//   "400 Unsupported parameter: 'max_tokens' is not supported with this
//    model. Use 'max_completion_tokens' instead."
//
// Causa: o código tratava `reasoning_effort` e o parâmetro de tokens como se
// fossem a mesma coisa. Um 400 reclamando do effort fazia ele trocar
// max_completion_tokens por max_tokens — que o GPT-5.6 recusa. O agente
// entrava num beco sem saída e toda conversa virava erro técnico.
//
// Roda sem rede e sem chave de API.
//
//   npm run test:modelo

process.env.SUPA_URL = process.env.SUPA_URL || 'https://x.supabase.co';
process.env.SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-teste';

const assert = require('assert');
const { _testes } = require('../src/agent');

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

async function testeAsync(nome, fn) {
  try {
    await fn();
    passou++;
    console.log(`  ✅ ${nome}`);
  } catch (err) {
    console.error(`  ❌ ${nome}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

// Erro no formato que a OpenAI devolve.
function erro400(mensagem) {
  const e = new Error(mensagem);
  e.status = 400;
  return e;
}
function erro404(mensagem) {
  const e = new Error(mensagem);
  e.status = 404;
  e.code = 'model_not_found';
  return e;
}

// Cliente falso: devolve os erros da fila, na ordem, e registra o que recebeu.
function clienteFalso(erros = []) {
  const chamadas = [];
  const fila = [...erros];
  return {
    chamadas,
    chat: {
      completions: {
        create: async (payload) => {
          chamadas.push(payload);
          const e = fila.shift();
          if (e) throw e;
          return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      },
    },
  };
}

(async () => {
  console.log('\n🎩 Parâmetros da chamada ao modelo\n');

  teste('modelo 5.x usa max_completion_tokens e manda reasoning_effort', () => {
    _testes.resetar('gpt-5.6-terra');
    const p = _testes.montarPayload([]);
    assert.ok('max_completion_tokens' in p, 'faltou max_completion_tokens');
    assert.ok(!('max_tokens' in p), 'não pode mandar max_tokens para modelo 5.x');
    assert.ok('reasoning_effort' in p, 'faltou reasoning_effort');
  });

  teste('modelo antigo usa max_tokens e NÃO manda reasoning_effort', () => {
    _testes.resetar('gpt-4o');
    const p = _testes.montarPayload([]);
    assert.ok('max_tokens' in p, 'faltou max_tokens');
    assert.ok(!('max_completion_tokens' in p), 'gpt-4o não conhece max_completion_tokens');
    assert.ok(!('reasoning_effort' in p), 'gpt-4o não conhece reasoning_effort');
  });

  console.log('\n🎩 Correção automática de parâmetro\n');

  await testeAsync('ESTE É O BUG: recusar effort NÃO pode trocar para max_tokens', async () => {
    _testes.resetar('gpt-5.6-terra');
    const cli = clienteFalso([
      erro400("Unsupported value: 'reasoning_effort' does not support 'low' with this model."),
    ]);
    await _testes.chamarModelo(cli, []);

    assert.strictEqual(cli.chamadas.length, 2, 'deveria tentar de novo uma vez');
    const segunda = cli.chamadas[1];
    assert.ok(!('reasoning_effort' in segunda), 'o effort tinha que ter sido removido');
    assert.ok('max_completion_tokens' in segunda,
      'REGRESSÃO: trocou para max_tokens e o GPT-5.6 vai recusar de novo');
    assert.ok(!('max_tokens' in segunda), 'REGRESSÃO: mandou max_tokens para modelo 5.x');
  });

  await testeAsync('modelo que exige max_completion_tokens é corrigido', async () => {
    _testes.resetar('gpt-4o');           // começa no modo legado de propósito
    const cli = clienteFalso([
      erro400("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
    ]);
    await _testes.chamarModelo(cli, []);
    assert.ok('max_completion_tokens' in cli.chamadas[1], 'não corrigiu o nome do parâmetro');
  });

  await testeAsync('modelo que exige max_tokens é corrigido (caminho inverso)', async () => {
    _testes.resetar('gpt-5.6-terra');
    const cli = clienteFalso([
      erro400("Unsupported parameter: 'max_completion_tokens' is not supported with this model."),
    ]);
    await _testes.chamarModelo(cli, []);
    const segunda = cli.chamadas[1];
    assert.ok('max_tokens' in segunda, 'não voltou para max_tokens');
    assert.ok(!('reasoning_effort' in segunda), 'quem usa max_tokens não conhece reasoning_effort');
  });

  await testeAsync('sem acesso ao modelo → cai para o reserva com os parâmetros certos', async () => {
    _testes.resetar('gpt-5.6-terra');
    const cli = clienteFalso([
      erro404('The model `gpt-5.6-terra` does not exist or you do not have access to it.'),
    ]);
    await _testes.chamarModelo(cli, []);
    const segunda = cli.chamadas[1];
    assert.strictEqual(segunda.model, 'gpt-4o', 'não caiu para o modelo reserva');
    assert.ok('max_tokens' in segunda, 'reserva antigo precisa de max_tokens');
    assert.ok(!('reasoning_effort' in segunda), 'reserva antigo não aceita reasoning_effort');
  });

  await testeAsync('erro que não é de parâmetro sobe (não vira laço infinito)', async () => {
    _testes.resetar('gpt-5.6-terra');
    const cli = clienteFalso([erro400('Something else entirely went wrong')]);
    await assert.rejects(() => _testes.chamarModelo(cli, []), /Something else/);
    assert.strictEqual(cli.chamadas.length, 1, 'não devia ter repetido a chamada');
  });

  await testeAsync('duas correções seguidas ainda chegam ao sucesso', async () => {
    _testes.resetar('gpt-5.6-terra');
    const cli = clienteFalso([
      erro400("Unsupported value: 'reasoning_effort' does not support 'low' with this model."),
      erro400("Unsupported parameter: 'max_completion_tokens' is not supported with this model."),
    ]);
    await _testes.chamarModelo(cli, []);
    assert.strictEqual(cli.chamadas.length, 3);
    assert.ok('max_tokens' in cli.chamadas[2]);
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
})();
