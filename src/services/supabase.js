'use strict';

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { normalizar, parseItens, avaliarRascunho, calcularSubtotal } = require('../utils/pedido');
const logger = require('../logger');

const sb = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// ─── HISTÓRICO DE CONVERSA ────────────────────────────────────────────────────

async function carregarHistorico(telefone, limite = 16) {
  const { data, error } = await sb
    .from('n8n_chat_histories')
    .select('message')
    .eq('session_id', telefone)
    .order('created_at', { ascending: true })
    .limit(limite);

  if (error) throw new Error(`Supabase/carregarHistorico: ${error.message}`);

  return (data || [])
    .map(row => {
      try { return typeof row.message === 'string' ? JSON.parse(row.message) : row.message; }
      catch { return null; }
    })
    .filter(m => m && m.role && m.content);
}

async function salvarMensagem(telefone, role, content) {
  const { error } = await sb.from('n8n_chat_histories').insert({
    session_id: telefone,
    message: JSON.stringify({ role, content, ts: Date.now() }),
  });
  if (error) throw new Error(`Supabase/salvarMensagem: ${error.message}`);
}

// ─── RASCUNHO DO PEDIDO ───────────────────────────────────────────────────────
// Fonte da verdade do estado do pedido. A etapa é SEMPRE recalculada pelo código.

async function carregarRascunho(telefone) {
  const { data } = await sb
    .from('pedido_rascunho')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();
  return data || null;
}

// Merge parcial de baixo nível: nunca apaga campo que não veio.
async function salvarRascunho(telefone, campos) {
  const update = { ...campos, updated_at: new Date().toISOString() };

  const { data: existing } = await sb
    .from('pedido_rascunho')
    .select('telefone')
    .eq('telefone', telefone)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from('pedido_rascunho').update(update).eq('telefone', telefone);
    if (error) throw new Error(`Supabase/salvarRascunho(update): ${error.message}`);
  } else {
    const { error } = await sb.from('pedido_rascunho').insert({ telefone, ...update });
    if (error) throw new Error(`Supabase/salvarRascunho(insert): ${error.message}`);
  }
}

// Alto nível: merge campos + valida itens + RECALCULA etapa determinística.
// Retorna { rascunho, avaliacao, naoEncontrados }.
async function atualizarRascunho(telefone, campos) {
  const atual = (await carregarRascunho(telefone)) || {};

  let naoEncontrados = [];
  const merge = { ...campos };

  // Se vierem itens, valida contra o catálogo (preço REAL, nome canônico)
  if (campos.itens !== undefined) {
    const { itens, naoEncontrados: nf } = await validarItens(campos.itens);
    merge.itens = JSON.stringify(itens);
    naoEncontrados = nf;
  }

  // Brinde passa pela MESMA validação de catálogo: assim a LLM não consegue
  // inventar um item de cortesia que não existe no cardápio.
  if (campos.itens_brinde !== undefined) {
    const { itens: brindes, naoEncontrados: nfb } = await validarItens(campos.itens_brinde);
    merge.itens_brinde = JSON.stringify(brindes);
    naoEncontrados = naoEncontrados.concat(nfb);
  }

  // Estado consolidado (atual + novos campos) para avaliar
  const consolidado = { ...atual, ...merge };
  const avaliacao = avaliarRascunho(consolidado);

  // Código decide a etapa — a LLM nunca seta isso
  merge.etapa_atual = avaliacao.etapa;

  await salvarRascunho(telefone, merge);

  const rascunho = await carregarRascunho(telefone);
  return { rascunho, avaliacao, naoEncontrados };
}

async function limparRascunho(telefone) {
  await sb.from('pedido_rascunho').delete().eq('telefone', telefone);
}

// Trava atômica pra confirmação: só UMA chamada concorrente consegue passar
// etapa_atual de 'aguardando_confirmacao' pra 'processando' (o UPDATE...WHERE
// é atômico no Postgres). Duas mensagens "sim" quase simultâneas (double-tap,
// retry do WhatsApp) não criam dois pedidos — a segunda simplesmente perde
// a corrida e recebe travou=false.
async function tentarIniciarConfirmacao(telefone) {
  const { data, error } = await sb
    .from('pedido_rascunho')
    .update({ etapa_atual: 'processando', updated_at: new Date().toISOString() })
    .eq('telefone', telefone)
    .eq('etapa_atual', 'aguardando_confirmacao')
    .select('telefone');
  if (error) throw new Error(`Supabase/tentarIniciarConfirmacao: ${error.message}`);
  return (data || []).length > 0;
}

// ─── POLLER: FOLLOW-UP E WATCHDOG ─────────────────────────────────────────────
// UPDATE...RETURNING atômico (supabase-js faz isso num único round-trip via
// PostgREST) — evita a corrida de "SELECT candidatos → depois agir → depois
// marcar", onde uma mensagem nova do cliente podia chegar no meio e o
// follow-up sair por cima, redundante.

async function reivindicarFollowups(silencioMs) {
  const limite = new Date(Date.now() - silencioMs).toISOString();
  const { data, error } = await sb
    .from('pedido_rascunho')
    .update({ followup_enviado: true })
    .eq('followup_enviado', false)
    .eq('ultima_msg_role', 'assistant')
    .neq('etapa_atual', 'processando')
    .lte('ultima_msg_em', limite)
    .select('*');
  if (error) throw new Error(`Supabase/reivindicarFollowups: ${error.message}`);
  return data || [];
}

// Rascunhos presos em 'processando' há muito tempo (processo pode ter morrido
// no meio de confirmarPedido, entre a trava atômica e o final de
// criarPedidoCompleto). NÃO tenta recriar o pedido sozinho — risco de
// duplicar se criarPedidoCompleto já tinha terminado. Só alerta pro dono agir.
async function reivindicarTravados(travadoMs) {
  const limite = new Date(Date.now() - travadoMs).toISOString();
  const { data, error } = await sb
    .from('pedido_rascunho')
    .update({ alerta_travado_enviado: true })
    .eq('etapa_atual', 'processando')
    .eq('alerta_travado_enviado', false)
    .lte('updated_at', limite)
    .select('*');
  if (error) throw new Error(`Supabase/reivindicarTravados: ${error.message}`);
  return data || [];
}

// ─── PAUSA DE ATENDIMENTO (atendente humano assumiu) ─────────────────────────

async function verificarPausa(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { data } = await sb
    .from('agente_pausas')
    .select('pausado_ate')
    .eq('telefone', tel)
    .maybeSingle();
  if (!data?.pausado_ate) return false;
  return new Date(data.pausado_ate).getTime() > Date.now();
}

async function pausarAtendimento(telefone, ms, motivo) {
  const tel = String(telefone).replace(/\D/g, '');
  const pausadoAte = new Date(Date.now() + ms).toISOString();
  const { error } = await sb
    .from('agente_pausas')
    .upsert({ telefone: tel, pausado_ate: pausadoAte, motivo: motivo || null }, { onConflict: 'telefone' });
  if (error) throw new Error(`Supabase/pausarAtendimento: ${error.message}`);
}

// ─── PRODUTOS / CARDÁPIO ──────────────────────────────────────────────────────

async function buscarProdutos() {
  const { data, error } = await sb
    .from('produtos')
    .select('id, nome, categoria, preco, preco_promocional, preco_delivery, descricao, disponivel')
    .eq('disponivel', true)
    .order('categoria')
    .order('nome');
  if (error) throw new Error(`Supabase/buscarProdutos: ${error.message}`);
  return data || [];
}

// Todo pedido feito por este agente é delivery/retirada (nunca balcão), então
// preco_delivery (quando configurado) tem prioridade sobre o preço de balcão.
// Promocional continua valendo em qualquer canal.
function precoFinal(p) {
  if (p.preco_promocional != null) return Number(p.preco_promocional);
  if (p.preco_delivery != null) return Number(p.preco_delivery);
  return Number(p.preco);
}

// Valida itens contra o catálogo: preço real, nome canônico, produto_id.
// Itens sem correspondência voltam em naoEncontrados (não são salvos).
async function validarItens(itensInput) {
  const produtos = await buscarProdutos();
  const itens = [];
  const naoEncontrados = [];

  for (const item of parseItens(itensInput)) {
    const alvo = normalizar(item.nome);
    if (!alvo) continue;

    let prod = produtos.find(p => normalizar(p.nome) === alvo);
    if (!prod) {
      prod = produtos.find(p => {
        const pn = normalizar(p.nome);
        return pn.includes(alvo) || alvo.includes(pn);
      });
    }

    if (!prod) {
      naoEncontrados.push(item.nome);
      continue;
    }

    itens.push({
      produto_id: prod.id,
      nome: prod.nome.trim(),
      quantidade: Math.max(1, Number(item.quantidade) || 1),
      preco_unitario: precoFinal(prod),
      observacao: item.observacao ? String(item.observacao).trim() : null,
    });
  }

  return { itens, naoEncontrados };
}

// Itens do dia (carnes/base/acompanhamentos) — a MESMA fonte que o ERP usa na
// tela de Porcionamento ("Itens do dia"). Se hoje ainda não foi configurado,
// cai pro último dia configurado (mesma regra de fallback do ERP), pra nunca
// informar o cardápio errado nem ficar sem resposta.
async function buscarItensDoDia() {
  const hoje = new Date().toISOString().slice(0, 10);

  let { data: rows, error } = await sb
    .from('itens_do_dia')
    .select('inventory_item_id, ativo')
    .eq('data', hoje);
  if (error) throw new Error(`Supabase/buscarItensDoDia(hoje): ${error.message}`);

  if (!rows || !rows.length) {
    const { data: ultimaData, error: eData } = await sb
      .from('itens_do_dia')
      .select('data')
      .lt('data', hoje)
      .order('data', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eData) throw new Error(`Supabase/buscarItensDoDia(ultimaData): ${eData.message}`);

    if (ultimaData) {
      const r2 = await sb.from('itens_do_dia').select('inventory_item_id, ativo').eq('data', ultimaData.data);
      if (r2.error) throw new Error(`Supabase/buscarItensDoDia(fallback): ${r2.error.message}`);
      rows = r2.data;
    }
  }

  const ativos = (rows || []).filter(r => r.ativo).map(r => r.inventory_item_id);
  if (!ativos.length) return null;

  const { data: itens, error: eItens } = await sb
    .from('inventory_items')
    .select('nome, porc_categoria')
    .in('id', ativos)
    .eq('porc_ativo', true)
    .eq('ativo', true);
  if (eItens) throw new Error(`Supabase/buscarItensDoDia(itens): ${eItens.message}`);
  if (!itens || !itens.length) return null;

  const porCategoria = { carne: [], base: [], acompanhamento: [] };
  for (const i of itens) {
    if (porCategoria[i.porc_categoria]) porCategoria[i.porc_categoria].push(i.nome.trim());
  }
  return porCategoria;
}

async function buscarInfo() {
  const { data, error } = await sb.from('info_restaurante').select('chave, valor');
  if (error) throw new Error(`Supabase/buscarInfo: ${error.message}`);
  const info = {};
  for (const row of (data || [])) info[row.chave] = row.valor;
  return info;
}

async function getTaxaEntrega() {
  const info = await buscarInfo();
  const t = Number(info.taxa_entrega);
  return Number.isFinite(t) ? t : 5;
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────

// Upsert leve chamado na PRIMEIRA MENSAGEM de qualquer conversa (não só na
// compra). Nunca sobrescreve nome/origem de um contato que já existe —
// preserva a atribuição do primeiro contato. Não lança: chamado é best-effort.
async function garantirCliente(telefone, pushName, adInfo) {
  const tel = String(telefone).replace(/\D/g, '');
  const payload = { telefone: tel, nome: pushName || 'Cliente', total_pedidos: 0, total_gasto: 0 };
  if (adInfo) {
    payload.veio_de_anuncio = true;
    payload.anuncio_meta = adInfo;
  }
  const { error } = await sb
    .from('clientes')
    .upsert(payload, { onConflict: 'telefone', ignoreDuplicates: true });
  if (error) throw new Error(`Supabase/garantirCliente: ${error.message}`);
}

// Marca o primeiro sinal real de interesse (carrinho montado) — idempotente,
// nunca sobrescreve um timestamp já setado. Alimenta a tag gerada em clientes.
async function marcarInteresse(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { error } = await sb
    .from('clientes')
    .update({ demonstrou_interesse_em: new Date().toISOString() })
    .eq('telefone', tel)
    .is('demonstrou_interesse_em', null);
  if (error) throw new Error(`Supabase/marcarInteresse: ${error.message}`);
}

async function buscarOuCriarCliente(nome, telefone, endereco) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: ex } = await sb
    .from('clientes')
    .select('id, total_pedidos, total_gasto, primeiro_pedido, veio_de_anuncio')
    .eq('telefone', tel)
    .maybeSingle();

  if (ex) {
    // Atualiza nome/endereço se vieram (cliente pode ter mudado)
    const patch = {};
    if (nome) patch.nome = nome;
    if (endereco) patch.endereco = endereco;
    if (Object.keys(patch).length) await sb.from('clientes').update(patch).eq('id', ex.id);
    return ex;
  }

  const { data, error } = await sb
    .from('clientes')
    .insert({ nome, telefone: tel, endereco: endereco || null, total_pedidos: 0, total_gasto: 0 })
    .select('id, total_pedidos, total_gasto, primeiro_pedido, veio_de_anuncio')
    .single();
  if (error) throw new Error(`Supabase/criarCliente: ${error.message}`);
  return data;
}

async function atualizarStatsCliente(cliente, totalPedido) {
  const agora = new Date().toISOString();
  const patch = {
    total_pedidos: (cliente.total_pedidos || 0) + 1,
    total_gasto: parseFloat(((cliente.total_gasto || 0) + totalPedido).toFixed(2)),
    ultimo_pedido: agora,
    data_ultima_interacao: agora,
  };
  if (!cliente.primeiro_pedido) patch.primeiro_pedido = agora;

  const { error } = await sb.from('clientes').update(patch).eq('id', cliente.id);
  if (error) throw new Error(`Supabase/atualizarStats: ${error.message}`);
}

// ─── CUPONS / OFERTAS DE RECOMPRA ─────────────────────────────────────────────
// O agente de recompra (projeto separado) manda ofertas com cupom pelo
// WhatsApp e grava em `cupons` + `ofertas_enviadas`. Este agente de
// atendimento só LÊ essas tabelas pra saber se o cliente que está falando
// agora tem uma oferta ativa — nunca cria oferta, só consome.

// Retorna o cupom ativo (não usado, dentro da validade) mais recente do
// cliente, ou null se não houver nenhum. Isso é o que dá ao agente de
// atendimento o "contexto" de que uma oferta foi enviada.
async function buscarCupomAtivoPorTelefone(telefone) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: cliente } = await sb.from('clientes').select('id').eq('telefone', tel).maybeSingle();
  if (!cliente) return null;

  const hoje = new Date().toISOString().slice(0, 10);
  const { data: cupom, error } = await sb
    .from('cupons')
    .select('id, codigo, desconto_percentual, valido_ate, usado, cliente_id, tipo, descricao')
    .eq('cliente_id', cliente.id)
    .eq('usado', false)
    .gte('valido_ate', hoje)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase/buscarCupomAtivo: ${error.message}`);

  return cupom || null;
}

// Dá baixa no cupom (nunca mais reutilizável) e marca a oferta como
// convertida. Best-effort: chamado DEPOIS que o pedido já foi criado com
// sucesso — se isso falhar, o pedido continua válido, só loga o problema
// (mesmo padrão de atualizarStatsCliente abaixo).
async function darBaixaCupom(cupomId, pedidoId) {
  const { error: errCupom } = await sb
    .from('cupons')
    .update({ usado: true, pedido_id: pedidoId })
    .eq('id', cupomId)
    .eq('usado', false); // condição evita dar baixa duas vezes numa corrida
  if (errCupom) throw new Error(`Supabase/darBaixaCupom: ${errCupom.message}`);

  const { error: errOferta } = await sb
    .from('ofertas_enviadas')
    .update({ converteu: true, pedido_convertido_id: pedidoId })
    .eq('cupom_id', cupomId);
  if (errOferta) throw new Error(`Supabase/marcarOfertaConvertida: ${errOferta.message}`);
}

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────

async function criarPedidoCompleto({ nomeCliente, telefone, tipoEntrega, endereco, formaPagamento, itens, cupom, itensBrinde }) {
  const tel = String(telefone).replace(/\D/g, '');
  const listaItens = parseItens(itens);
  if (!listaItens.length) throw new Error('Pedido sem itens válidos.');

  // Brinde só existe se houver cupom de brinde ativo. Sem essa trava, bastaria
  // a LLM preencher itens_brinde por conta própria pra dar comida de graça.
  const cupomEhBrinde = cupom?.tipo === 'brinde';
  const listaBrinde = cupomEhBrinde ? parseItens(itensBrinde) : [];

  // Última camada defensiva: resolve preço FRESCO por produto_id (não confia
  // no preço cacheado no rascunho, que pode ter ficado desatualizado se o
  // cardápio mudou durante a conversa). Se o produto sumiu, erro claro.
  const catalogo = await buscarProdutos();
  const listaRepreçada = listaItens.map(i => {
    const prod = catalogo.find(p => p.id === i.produto_id);
    if (!prod) throw new Error(`Produto "${i.nome}" não está mais disponível no cardápio.`);
    return { ...i, preco_unitario: precoFinal(prod) };
  });

  const subtotal = calcularSubtotal(listaRepreçada);
  const taxaConfig = await getTaxaEntrega();
  const taxaEntrega = tipoEntrega === 'delivery' ? taxaConfig : 0;
  // Cupom de brinde não abate percentual — o benefício são os itens grátis.
  const desconto = cupom && !cupomEhBrinde
    ? parseFloat((subtotal * (Number(cupom.desconto_percentual) / 100)).toFixed(2))
    : 0;
  const total = parseFloat((subtotal + taxaEntrega - desconto).toFixed(2));

  const cliente = await buscarOuCriarCliente(nomeCliente, tel, endereco);
  const canal = cliente.veio_de_anuncio ? 'whatsapp_anuncio' : 'whatsapp_organico';

  const { data: pedido, error: pErr } = await sb
    .from('pedidos')
    .insert({
      cliente_id: cliente.id,
      status: 'pendente',
      tipo_entrega: tipoEntrega,
      endereco_entrega: endereco || null,
      forma_pagamento: formaPagamento,
      subtotal,
      taxa_entrega: taxaEntrega,
      desconto,
      cupom_id: cupom ? cupom.id : null,
      total,
      observacao: null,
      canal,
    })
    .select('id, numero_pedido, total')
    .single();
  if (pErr) throw new Error(`Supabase/criarPedido: ${pErr.message}`);

  const rows = listaRepreçada.map(i => ({
    pedido_id: pedido.id,
    produto_id: i.produto_id || null,
    nome_produto: i.nome,
    quantidade: Number(i.quantidade),
    preco_unitario: Number(i.preco_unitario),
    observacao: i.observacao || null,
    total: parseFloat((Number(i.preco_unitario) * Number(i.quantidade)).toFixed(2)),
  }));

  // Itens de cortesia entram no pedido zerados, pra cozinha ver que tem que
  // incluir e o ERP conseguir medir quanto a campanha custou em brinde.
  for (const b of listaBrinde) {
    rows.push({
      pedido_id: pedido.id,
      produto_id: b.produto_id || null,
      nome_produto: `${b.nome} (brinde)`,
      quantidade: Number(b.quantidade) || 1,
      preco_unitario: 0,
      total: 0,
    });
  }

  const { error: iErr } = await sb.from('itens_pedido').insert(rows);
  if (iErr) {
    // Compensa: sem isto, um pedido "cabeçalho" sem nenhum item ficava
    // órfão no banco (aparecia no ERP com total mas 0 itens), e a nova
    // tentativa do cliente criaria outro pedido do zero por cima.
    await sb.from('pedidos').delete().eq('id', pedido.id).then(() => {}, () => {});
    throw new Error(`Supabase/criarItens: ${iErr.message}`);
  }

  try {
    await atualizarStatsCliente(cliente, total);
  } catch (e) {
    // Pedido e itens já estão gravados e são válidos — uma falha só nas
    // estatísticas do cliente não pode fazer o fluxo cair no catch de
    // "pedido falhou" e o cliente tentar de novo (o que criaria um
    // pedido de verdade duplicado). Só loga.
    logger.warn('pedido/stats-cliente-falhou', e.message, { clienteId: cliente.id, numeroPedido: pedido.numero_pedido });
  }

  if (cupom) {
    try {
      await darBaixaCupom(cupom.id, pedido.id);
    } catch (e) {
      // Mesmo raciocínio: o pedido já é válido e não deve ser desfeito por
      // uma falha na baixa do cupom. Só loga — mas isso merece alerta,
      // porque um cupom não baixado pode ser reaproveitado depois.
      logger.error('pedido/baixa-cupom-falhou', e.message, { cupomId: cupom.id, numeroPedido: pedido.numero_pedido });
    }
  }

  return {
    numeroPedido: pedido.numero_pedido,
    total, subtotal, taxaEntrega, desconto,
    cupomAplicado: cupom ? cupom.codigo : null,
    brindes: listaBrinde.map(b => `${b.quantidade || 1}x ${b.nome}`),
    formaPagamento,
  };
}

async function atualizarStatusPedido(telefone, novoStatus) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: cli } = await sb.from('clientes').select('id').eq('telefone', tel).maybeSingle();
  if (!cli?.id) throw new Error('Cliente não encontrado.');

  const { data: pedidos, error } = await sb
    .from('pedidos')
    .select('id, numero_pedido, total')
    .eq('cliente_id', cli.id)
    .eq('status', 'pendente')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Supabase/buscarPedidoPendente: ${error.message}`);
  if (!pedidos?.length) throw new Error('Nenhum pedido pendente encontrado para este cliente.');

  const pedido = pedidos[0];
  const { error: uErr } = await sb.from('pedidos').update({ status: novoStatus }).eq('id', pedido.id);
  if (uErr) throw new Error(`Supabase/atualizarStatus: ${uErr.message}`);

  return pedido;
}

module.exports = {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, atualizarRascunho, limparRascunho, tentarIniciarConfirmacao,
  buscarProdutos, precoFinal, validarItens, buscarItensDoDia, buscarInfo, getTaxaEntrega,
  garantirCliente, marcarInteresse, buscarOuCriarCliente, criarPedidoCompleto, atualizarStatusPedido,
  buscarCupomAtivoPorTelefone, darBaixaCupom,
  verificarPausa, pausarAtendimento, reivindicarFollowups, reivindicarTravados,
};
