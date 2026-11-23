'use strict';

// Revisão da semana de 20/10 a 26/10: cada teste é um defeito que apareceu em
// conversa real. Todos rodam o código de verdade, com o banco simulado.
//
//   npm run test:revisao

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

// Banco simulado: cada tabela devolve as linhas daqui, qualquer filtro passa.
// Basta pros caminhos testados, que leem uma tabela pequena e conhecida.
const TABELAS = {
  produtos: [
    { id: 'p1', nome: 'Marmitex Grande', categoria: 'Marmitex', preco: 23, disponivel: true },
  ],
  itens_do_dia: [{ inventory_item_id: 'i1', ativo: true }, { inventory_item_id: 'i2', ativo: true }],
  inventory_items: [
    { nome: 'Costela assada', porc_categoria: 'carne' },
    { nome: 'Arroz', porc_categoria: 'base' },
  ],
  clientes: [],
};
function consulta(tabela) {
  const linhas = () => TABELAS[tabela] || [];
  const q = {
    then: (ok, erro) => Promise.resolve({ data: linhas(), error: null }).then(ok, erro),
    maybeSingle: async () => ({ data: linhas()[0] || null, error: null }),
    single: async () => ({ data: linhas()[0] || null, error: null }),
  };
  for (const m of ['select', 'eq', 'neq', 'in', 'lt', 'gte', 'is', 'order', 'limit', 'not', 'insert', 'update', 'upsert', 'delete']) {
    q[m] = () => q;
  }
  return q;
}
const caminhoSdk = require.resolve('@supabase/supabase-js');
require.cache[caminhoSdk] = {
  id: caminhoSdk, filename: caminhoSdk, loaded: true,
  exports: { createClient: () => ({ from: consulta, rpc: async () => ({ data: null, error: null }) }) },
};

const db = require('../src/services/supabase');
const { carrinhoJaVirouPedido } = require('../src/utils/pedido');
const { pareceRaciocinio } = require('../src/agent')._testes;

let passou = 0;
async function teste(nome, fn) {
  try { await fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('\n🎩 Revisão 20–26/10: o que deu errado em conversa real\n');

  await teste('raciocínio interno não passa como resposta (Lorena 23/10, salmo 91 26/10)', async () => {
    assert.ok(pareceRaciocinio('We need respond, state says missing full name. User sent doc perhaps proof. Need natural? They asked no.'));
    assert.ok(pareceRaciocinio('We need respond likely form payment ambiguity "Sim". Need ask choice. Also state has payment missing.'));
    assert.ok(pareceRaciocinio('Segue: RESUMO_FINAL_TEXTO_EXATO'));
  });

  await teste('mensagem normal em português não é confundida com raciocínio', async () => {
    for (const ok of [
      'Anotei: 1x Marmitex Grande — R$ 23,00 ✅ É pra *entrega* ou *retirada*?',
      'Tem sim, a dobradinha tá no cardápio de hoje 😋 Prefere a Média ou a Grande?',
      'Seu pedido *#318* já está na cozinha e deve sair logo 🎩',
      'Pode pedir pelo iFood também 😊 Mas o cupom é resgatado por aqui.',
    ]) assert.ok(!pareceRaciocinio(ok), `falso positivo: ${ok}`);
  });

  await teste('carrinho fechado à mão pela equipe some (salmo 91: resumo 4x depois do pedido)', async () => {
    const rascunho = { etapa_atual: 'aguardando_confirmacao', itens_atualizados_em: '2026-10-26T13:20:00Z' };
    const pedidos = [{ numero_pedido: 318, created_at: '2026-10-26T13:53:00Z' }];
    assert.strictEqual(carrinhoJaVirouPedido(rascunho, pedidos), true);
  });

  await teste('carrinho novo depois de um pedido continua valendo (segundo pedido do dia)', async () => {
    const rascunho = { etapa_atual: 'coletando_dados', itens_atualizados_em: '2026-10-26T15:00:00Z' };
    const pedidos = [{ numero_pedido: 318, created_at: '2026-10-26T13:53:00Z' }];
    assert.strictEqual(carrinhoJaVirouPedido(rascunho, pedidos), false);
  });

  await teste('rascunho antigo, sem data do carrinho, nunca é apagado por engano', async () => {
    assert.strictEqual(carrinhoJaVirouPedido({ etapa_atual: 'aguardando_pix' }, [{ created_at: '2026-10-26T13:53:00Z' }]), false);
    assert.strictEqual(carrinhoJaVirouPedido(null, []), false);
  });

  await teste('montagem da marmita vai junto com o pedido do cliente pra cozinha (Gustavo 24/10)', async () => {
    const { itens } = await db.validarItens([{
      nome: 'Marmitex Grande', quantidade: 1,
      carnes: ['Costela assada'], acompanhamentos: ['Arroz'],
      observacao: 'costela bem magra, sem gordura',
    }]);
    assert.ok(itens[0].observacao.includes('Carnes: Costela assada'), itens[0].observacao);
    assert.ok(itens[0].observacao.includes('bem magra, sem gordura'), `observação sumiu: ${itens[0].observacao}`);
  });

  await teste('nome do WhatsApp serve pra comanda; "Você", "~" e ".." não', async () => {
    assert.strictEqual(db.nomeUtil('Lorena💖'), 'Lorena');
    assert.strictEqual(db.nomeUtil('Rhayy Vitória🎀'), 'Rhayy Vitória');
    assert.strictEqual(db.nomeUtil('~'), null);
    assert.strictEqual(db.nomeUtil('..'), null);
    assert.strictEqual(db.nomeUtil('Você'), null);
    assert.strictEqual(db.nomeUtil('Cliente'), null);
  });

  await teste('cliente que já comprou usa o nome do último pedido', async () => {
    TABELAS.clientes = [{ nome: 'Jaqueline Palhares', total_pedidos: 4 }];
    assert.strictEqual(await db.nomeConhecido('5544999', 'Jaque'), 'Jaqueline Palhares');
    TABELAS.clientes = [{ nome: 'Jaque', total_pedidos: 0 }];
    assert.strictEqual(await db.nomeConhecido('5544999', 'Jaque 🌸'), 'Jaque');
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
})();
