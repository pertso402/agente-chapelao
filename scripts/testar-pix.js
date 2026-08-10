'use strict';

// No PIX o pedido NÃO pode nascer no "SIM": ele só existe depois que o
// comprovante chega e o valor confere. Senão a cozinha monta marmita de quem
// disse "sim" e nunca pagou — foi exatamente isso que aconteceu em produção.
//
// Dinheiro e cartão continuam fechando na hora: não há o que conferir.
//
//   npm run test:pix

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

// ─── Banco falso ──────────────────────────────────────────────────────────────
const caminhoDb = require.resolve('../src/services/supabase.js');
const registro = { criouPedido: 0, salvou: [], precificou: 0 };

require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: {
    tentarIniciarConfirmacao: async () => true,
    salvarRascunho: async (tel, campos) => { registro.salvou.push(campos); },
    limparRascunho: async () => { registro.salvou.push({ LIMPOU: true }); },
    precificarPedido: async () => {
      registro.precificou++;
      return {
        subtotal: 32.5, taxaEntrega: 11, desconto: 0, total: 43.5,
        itens: [], brindes: [{ nome: 'Refrigerante 200ml Pet', quantidade: 1 }],
      };
    },
    criarPedidoCompleto: async () => {
      registro.criouPedido++;
      return {
        numeroPedido: 77, total: 43.5, subtotal: 32.5, taxaEntrega: 11,
        desconto: 0, trocoPara: null, cupomAplicado: null, brindes: [], formaPagamento: 'dinheiro',
      };
    },
  },
};

const { confirmarPedido } = require('../src/agent');

const RASCUNHO = {
  itens: JSON.stringify([{ nome: 'Marmitex Média', quantidade: 1, preco_unitario: 26.5, produto_id: 1 }]),
  nome_cliente: 'Ana',
  tipo_entrega: 'delivery',
  endereco: 'Rua X, 100',
  taxa_entrega: 11,
};

let passou = 0;
async function teste(nome, fn) {
  registro.criouPedido = 0; registro.precificou = 0; registro.salvou.length = 0;
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
  console.log('\n🎩 PIX: o pedido só nasce depois do comprovante\n');

  await teste('ESTE É O BUG: "sim" no PIX NÃO cria pedido nem manda pro painel', async () => {
    const r = await confirmarPedido({ ...RASCUNHO, forma_pagamento: 'pix' }, '5544999', 'req1', null);
    assert.strictEqual(registro.criouPedido, 0,
      'o pedido foi criado no SIM — a cozinha vai receber pedido de quem ainda não pagou');
    assert.strictEqual(r.numeroPedido, null, 'não pode existir número de pedido antes do pagamento');
    assert.strictEqual(r.aguardandoPix, true);
  });

  await teste('o total combinado fica guardado para conferir o comprovante depois', async () => {
    await confirmarPedido({ ...RASCUNHO, forma_pagamento: 'pix' }, '5544999', 'req2', null);
    const gravado = registro.salvou.find(c => c.total_confirmado != null);
    assert.ok(gravado, 'nada foi gravado — não haveria contra o que conferir o comprovante');
    assert.strictEqual(gravado.total_confirmado, 43.5);
    assert.strictEqual(gravado.etapa_atual, 'aguardando_pix');
  });

  await teste('o brinde continua no rascunho (o pedido ainda não existe pra recebê-lo)', async () => {
    await confirmarPedido({ ...RASCUNHO, forma_pagamento: 'pix' }, '5544999', 'req3', null);
    const zerou = registro.salvou.some(c => c.itens_brinde === JSON.stringify([]));
    assert.ok(!zerou, 'zerar o brinde aqui faria o cliente perder a cortesia já prometida');
  });

  await teste('o rascunho NÃO é apagado — ele é a única cópia do pedido até o pagamento', async () => {
    await confirmarPedido({ ...RASCUNHO, forma_pagamento: 'pix' }, '5544999', 'req4', null);
    assert.ok(!registro.salvou.some(c => c.LIMPOU),
      'apagar o rascunho aqui perderia o pedido inteiro se o cliente pagasse depois');
  });

  console.log('\n🎩 Dinheiro e cartão fecham na hora\n');

  for (const forma of ['dinheiro', 'cartao']) {
    await teste(`${forma}: o pedido é criado no SIM e vai pro painel`, async () => {
      const rascunho = { ...RASCUNHO, forma_pagamento: forma };
      if (forma === 'dinheiro') rascunho.troco_para = 50;
      const r = await confirmarPedido(rascunho, '5544999', 'req5', null);
      assert.strictEqual(registro.criouPedido, 1, 'não criou o pedido — nada chegaria na cozinha');
      assert.strictEqual(r.numeroPedido, 77);
      assert.ok(registro.salvou.some(c => c.LIMPOU), 'o rascunho tem que ser limpo depois de fechar');
    });
  }

  await teste('dinheiro SEM resposta de troco nem chega a criar pedido', async () => {
    // O troco faz parte do pedido: sem ele o entregador sai sem saber quanto
    // levar e a conta acontece na porta do cliente.
    await assert.rejects(
      () => confirmarPedido({ ...RASCUNHO, forma_pagamento: 'dinheiro' }, '5544999', 'req6', null),
      /incompleto|troco/i
    );
    assert.strictEqual(registro.criouPedido, 0);
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
