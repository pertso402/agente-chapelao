'use strict';

// O caso da Cida (30/09), que custou a venda e teve que ser assumido na mão:
//
//   14:22 cliente: "Av Olinda, 2806, Condomínio Royal Residence..."
//   14:22 agente : "Anotei o endereço ✅ PIX, dinheiro ou cartão?"
//   14:23 cliente: "No PIX, qual o valor?"
//   14:23 agente : "Cida, estou confirmando o valor da entrega..."
//   14:24 agente : "...assim que o valor da entrega for confirmado eu te passo"
//   14:25 agente : "...estou confirmando o valor da entrega e já volto"
//   14:33 cliente: paga R$ 31,75 por conta própria, sem nunca receber um total
//
// O rascunho dela tinha delivery + endereço + pix, e `taxa_solicitada_em` NULL:
// o painel nunca soube que havia uma entrega pra calcular.
//
// Causa: o "pix" foi gravado pela CAPTURA DETERMINÍSTICA, não pela tool. Sem
// nada novo pra salvar, a LLM não chamou salvar_dados_pedido — e o gatilho da
// taxa morava lá dentro.
//
//   npm run test:taxa

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

const estado = { pedidosAbertos: [], alertas: [], falharSolicitar: false, falharAlerta: false };

// Falsifica o CLIENTE do Supabase, não os exports: garantirPedidoDeTaxa chama
// as funções internas do módulo por closure, então trocar o export não teria
// efeito nenhum — e o teste passaria batendo na rede de verdade.
// Falsificando aqui, o caminho real (solicitarTaxaEntrega + criarAlerta) roda.
const caminhoSdk = require.resolve('@supabase/supabase-js');
require.cache[caminhoSdk] = {
  id: caminhoSdk, filename: caminhoSdk, loaded: true,
  exports: {
    createClient: () => ({
      from(tabela) {
        if (tabela === 'atendimento_alertas') {
          return {
            insert: async (linha) => {
              if (estado.falharAlerta) return { error: { message: 'Gateway Timeout' } };
              estado.alertas.push({ telefone: linha.telefone, nome: linha.nome_cliente, motivo: linha.motivo });
              return { error: null };
            },
          };
        }
        // pedido_rascunho: update(...).eq(...).is(...).is(...).select(...)
        // O `insert` genérico existe porque o logger persiste warn/error em
        // agent_logs — sem ele, registrar a falha derrubava o próprio teste
        // da falha.
        const cadeia = {
          insert: async () => ({ error: null }),
          update() { return cadeia; },
          eq(_col, valor) { cadeia._telefone = valor; return cadeia; },
          is() { return cadeia; },
          select() {
            if (estado.falharSolicitar) return Promise.resolve({ data: null, error: { message: 'Gateway Timeout' } });
            estado.pedidosAbertos.push(cadeia._telefone);
            return Promise.resolve({ data: [{ telefone: cadeia._telefone }], error: null });
          },
        };
        return cadeia;
      },
    }),
  },
};

const db = require('../src/services/supabase.js');

let passou = 0;
async function teste(nome, fn) {
  estado.pedidosAbertos = []; estado.alertas = [];
  estado.falharSolicitar = false; estado.falharAlerta = false;
  try { await fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

const RASCUNHO_CIDA = {
  telefone: '556592543375',
  nome_cliente: 'Cida',
  tipo_entrega: 'delivery',
  endereco: 'Av Olinda, 2806, Condomínio Royal Residence, portão branco',
  forma_pagamento: 'pix',
  taxa_entrega: null,
  taxa_solicitada_em: null,
};

(async () => {
  console.log('\n🎩 O cálculo da entrega é aberto pelo ESTADO, não por quem gravou\n');

  await teste('ESTE É O CASO DA CIDA: estado completo abre o pedido e avisa o painel', async () => {
    const r = await db.garantirPedidoDeTaxa(RASCUNHO_CIDA);
    assert.strictEqual(r.estado, 'aberto', `estado inesperado: ${JSON.stringify(r)}`);
    assert.deepEqual(estado.pedidosAbertos, ['556592543375'], 'não abriu o pedido de cálculo');
    assert.strictEqual(estado.alertas.length, 1, 'o painel não foi avisado');
    assert.ok(/Av Olinda/.test(estado.alertas[0].motivo), 'o alerta precisa levar o endereço');
    assert.ok(/pix/.test(estado.alertas[0].motivo), 'o alerta precisa levar a forma de pagamento');
  });

  await teste('falta forma de pagamento: não abre e diz o que falta', async () => {
    const r = await db.garantirPedidoDeTaxa({ ...RASCUNHO_CIDA, forma_pagamento: null });
    assert.strictEqual(r.estado, 'falta_dado');
    assert.deepEqual(r.falta, ['forma de pagamento']);
    assert.strictEqual(estado.pedidosAbertos.length, 0, 'abriu cálculo sem saber a forma de pagamento');
  });

  await teste('já pedido antes: não duplica alerta no painel', async () => {
    const r = await db.garantirPedidoDeTaxa({ ...RASCUNHO_CIDA, taxa_solicitada_em: new Date().toISOString() });
    assert.strictEqual(r.estado, 'ja_pedido');
    assert.strictEqual(estado.alertas.length, 0, 'criou um segundo alerta pra mesma pessoa');
  });

  await teste('retirada não abre cálculo de entrega', async () => {
    const r = await db.garantirPedidoDeTaxa({ ...RASCUNHO_CIDA, tipo_entrega: 'retirada' });
    assert.strictEqual(r.estado, 'nao_e_entrega');
    assert.strictEqual(estado.pedidosAbertos.length, 0);
  });

  await teste('ESTE ERA O SEGUNDO FURO: falha não vira "já estamos calculando"', async () => {
    // Antes: `.catch(() => false)` engolia o erro e a LLM era instruída a dizer
    // que a equipe já estava calculando de qualquer jeito. Era por isso que o
    // agente repetia com tanta confiança que já voltava com o valor.
    estado.falharSolicitar = true;
    const r = await db.garantirPedidoDeTaxa(RASCUNHO_CIDA);
    assert.strictEqual(r.estado, 'falhou', 'a falha precisa aparecer, não ser engolida');
    assert.ok(/Gateway Timeout/.test(r.erro), 'o motivo real tem que chegar a quem chamou');
  });

  await teste('alerta que falha também conta como falha (painel ficaria cego)', async () => {
    estado.falharAlerta = true;
    const r = await db.garantirPedidoDeTaxa(RASCUNHO_CIDA);
    assert.strictEqual(r.estado, 'falhou', 'cálculo aberto sem ninguém saber não pode passar por sucesso');
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
