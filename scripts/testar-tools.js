'use strict';

// EXECUTA cada tool de verdade, com o banco falsificado.
//
// Existe por um estrago real: uma variável (`avisosExtras`) ficou declarada
// numa edição que falhou em silêncio, e TODA chamada de salvar_dados_pedido
// passou a estourar "avisosExtras is not defined". O agente virou inútil em
// produção — o cliente pedia "Média, arroz, feijão, frango assado" e ele
// chamava atendente, porque a tool morria antes de gravar qualquer coisa.
//
// `node --check` NÃO pega isso: variável não declarada é erro de execução, não
// de sintaxe. Só chamando a função pega. É o que este arquivo faz.
//
//   npm run test:tools

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

const ITENS_DO_DIA = {
  carne: ['Frango assado', 'Almôndegas ao molho', 'Costela assada'],
  base: ['Arroz', 'Feijão'],
  acompanhamento: ['Batata frita', 'Mandioca cozida', 'Farofa'],
};

const PRODUTOS = [
  { id: 'md', nome: 'Marmitex Média', categoria: 'Marmitex', preco: 21, disponivel: true },
  { id: 'gr', nome: 'Marmitex Grande', categoria: 'Marmitex', preco: 23, disponivel: true },
  { id: 'coca', nome: 'Coca-Cola Lata 350ml', categoria: 'Bebidas', preco: 7, disponivel: true },
];

// Banco falso: devolve o mínimo que cada tool espera.
const caminhoDb = require.resolve('../src/services/supabase.js');
const rascunho = { telefone: '5544999', itens: '[]', etapa_atual: 'inicio' };

require.cache[caminhoDb] = {
  id: caminhoDb, filename: caminhoDb, loaded: true,
  exports: {
    buscarProdutos: async () => PRODUTOS,
    buscarItensDoDia: async () => ITENS_DO_DIA,
    buscarCombos: async () => ([
      { slug: 'almoco_resolvido', nome: 'Almoço Resolvido', preco: 29.9, subsidio_frete_max: 6,
        itens: [{ quantidade: 1, rotulo: 'Grande' }, { quantidade: 1, rotulo: 'sobremesa' }] },
    ]),
    buscarComboPorId: async () => null,
    precoFinal: (p) => Number(p.preco),
    buscarInfo: async () => ({ nome: 'Chapelão', chave_pix: '000', horario: 'Seg a Sáb' }),
    carregarRascunho: async () => rascunho,
    marcarInteresse: async () => {},
    solicitarTaxaEntrega: async () => false,
    criarAlertaAtendimento: async () => {},
    pausarAtendimento: async () => {},
    atualizarStatusPedido: async () => ({ numero_pedido: 1 }),
    precificarPedido: async () => ({
      itens: [], brindes: [], combo: null,
      subtotal: 21, taxaEntrega: 0, desconto: 0, total: 21,
    }),
    atualizarRascunho: async (_tel, campos) => {
      Object.assign(rascunho, campos);
      return { rascunho, avaliacao: { completo: false, faltando: ['nome'], etapa: 'coletando_dados' }, naoEncontrados: [], avisos: [] };
    },
  },
};

const { TOOLS, executarTool } = require('../src/tools');

let passou = 0;
async function teste(nome, fn) {
  try { await fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('\n🎩 Toda tool roda de verdade (não só compila)\n');

  await teste('todas as tools declaradas têm executor', async () => {
    const nomes = TOOLS.map(t => t.function.name);
    assert.ok(nomes.length >= 5, `só ${nomes.length} tools declaradas`);
    for (const nome of nomes) {
      const r = await executarTool(nome, {}, { telefone: '5544999' });
      assert.ok(typeof r === 'string', `${nome} não devolveu texto`);
      assert.ok(!/is not defined|is not a function|undefined is not/i.test(r),
        `${nome} devolveu erro de programação: ${r}`);
    }
  });

  await teste('ESTE É O BUG: o pedido da cliente grava sem estourar', async () => {
    // "Média / Arroz, feijão, batata frita, mandioca cozida / frango assado,
    // almôndegas ao molho" — o pedido simples que derrubava a tool.
    const r = await executarTool('salvar_dados_pedido', {
      itens: [{
        nome: 'Marmitex Média', quantidade: 1,
        carnes: ['Frango assado', 'Almôndegas ao molho'],
        acompanhamentos: ['Arroz', 'Feijão', 'Batata frita', 'Mandioca cozida'],
      }],
    }, { telefone: '5544999' });
    assert.ok(!/is not defined/i.test(r), `estourou: ${r}`);
    assert.ok(r.includes('salvo') || r.includes('itens'), `retorno inesperado: ${r.slice(0, 120)}`);
  });

  await teste('tipo de entrega em português é aceito e normalizado', async () => {
    const r = await executarTool('salvar_dados_pedido', { tipo_entrega: 'entrega' }, { telefone: '5544999' });
    assert.ok(!/is not defined/i.test(r), r);
    assert.strictEqual(rascunho.tipo_entrega, 'delivery', 'não normalizou "entrega" para delivery');
  });

  await teste('forma de pagamento com acento é aceita', async () => {
    await executarTool('salvar_dados_pedido', { forma_pagamento: 'cartão' }, { telefone: '5544999' });
    assert.strictEqual(rascunho.forma_pagamento, 'cartao');
  });

  await teste('valor sem sentido vira AVISO, não exceção', async () => {
    const r = await executarTool('salvar_dados_pedido', { tipo_entrega: 'teletransporte' }, { telefone: '5544999' });
    assert.ok(!/is not defined/i.test(r), r);
    assert.ok(/AVISO|não entendi/i.test(r), `devia avisar a LLM: ${r.slice(0, 200)}`);
  });

  await teste('cardápio do dia sai sem quebrar', async () => {
    const r = await executarTool('buscar_itens_do_dia', {}, { telefone: '5544999' });
    assert.ok(r.includes('Frango assado'), 'não trouxe as carnes do dia');
  });

  await teste('o cardápio NÃO promete entrega grátis no combo', async () => {
    // O combo cobre ATÉ um teto (R$ 6 no Almoço Resolvido). A mensagem dizia
    // "Combos — a entrega é por nossa conta", e o cliente lia frete grátis:
    // com entrega de R$ 14 ele ainda paga R$ 8. Prometer o que o sistema não
    // cumpre é o pior defeito que este atendimento pode ter.
    const r = await executarTool('buscar_itens_do_dia', {}, { telefone: '5544999' });
    const proCliente = r.split('[INSTRUÇÃO INTERNA')[0];

    assert.ok(!/a entrega é por nossa conta/i.test(proCliente),
      'voltou a prometer entrega por nossa conta sem dizer o teto');
    assert.ok(!/frete gr[áa]tis|entrega gr[áa]tis/i.test(proCliente),
      'apareceu "grátis" na mensagem do cardápio');
    assert.ok(/at[ée] R\$ ?6/.test(proCliente),
      `o teto do subsídio tem que aparecer junto do combo:\n${proCliente}`);
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
