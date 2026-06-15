'use strict';

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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
// Persiste o estado do pedido sendo montado, etapa a etapa.
// Garante que o agente nunca "esqueça" o que já foi coletado.

async function carregarRascunho(telefone) {
  const { data } = await sb
    .from('pedido_rascunho')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();
  return data || null;
}

async function salvarRascunho(telefone, campos) {
  const { error } = await sb
    .from('pedido_rascunho')
    .upsert(
      { telefone, ...campos, updated_at: new Date().toISOString() },
      { onConflict: 'telefone' }
    );
  if (error) throw new Error(`Supabase/salvarRascunho: ${error.message}`);
}

async function limparRascunho(telefone) {
  await sb.from('pedido_rascunho').delete().eq('telefone', telefone);
}

// ─── PRODUTOS / CARDÁPIO ──────────────────────────────────────────────────────

async function buscarProdutos() {
  const { data, error } = await sb
    .from('produtos')
    .select('nome, categoria, preco, descricao')
    .eq('disponivel', true)
    .order('categoria')
    .order('nome');
  if (error) throw new Error(`Supabase/buscarProdutos: ${error.message}`);
  return data || [];
}

async function buscarMistura() {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('misturas_do_dia')
    .select('titulo, descricao')
    .eq('data', hoje)
    .eq('ativa', true)
    .maybeSingle();
  if (error) throw new Error(`Supabase/buscarMistura: ${error.message}`);
  return data || null;
}

async function buscarInfo() {
  const { data, error } = await sb.from('info_restaurante').select('chave, valor');
  if (error) throw new Error(`Supabase/buscarInfo: ${error.message}`);
  const info = {};
  for (const row of (data || [])) info[row.chave] = row.valor;
  return info;
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────

async function buscarOuCriarCliente(nome, telefone, endereco) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: ex } = await sb
    .from('clientes')
    .select('id, total_pedidos, total_gasto')
    .eq('telefone', tel)
    .maybeSingle();

  if (ex) return ex;

  const { data, error } = await sb
    .from('clientes')
    .insert({ nome, telefone: tel, endereco: endereco || null, total_pedidos: 0, total_gasto: 0 })
    .select('id, total_pedidos, total_gasto')
    .single();
  if (error) throw new Error(`Supabase/criarCliente: ${error.message}`);
  return data;
}

async function atualizarStatsCliente(clienteId, totalPedido, totalAnterior, pedidosAnteriores) {
  const { error } = await sb.from('clientes').update({
    total_pedidos: pedidosAnteriores + 1,
    total_gasto: parseFloat((totalAnterior + totalPedido).toFixed(2)),
    ultimo_pedido: new Date().toISOString(),
    data_ultima_interacao: new Date().toISOString(),
  }).eq('id', clienteId);
  if (error) throw new Error(`Supabase/atualizarStats: ${error.message}`);
}

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────

async function criarPedidoCompleto({ nomeCliente, telefone, tipoEntrega, endereco, formaPagamento, itens }) {
  const tel = String(telefone).replace(/\D/g, '');
  const subtotal = itens.reduce((s, i) => s + Number(i.preco_unitario) * Number(i.quantidade), 0);
  const taxaEntrega = tipoEntrega === 'delivery' ? (subtotal >= 50 ? 0 : 5) : 0;
  const total = subtotal + taxaEntrega;

  const cliente = await buscarOuCriarCliente(nomeCliente, tel, endereco);

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
      total,
      observacao: null,
    })
    .select('id, numero_pedido, total')
    .single();
  if (pErr) throw new Error(`Supabase/criarPedido: ${pErr.message}`);

  const rows = itens.map(i => ({
    pedido_id: pedido.id,
    produto_id: null,
    nome_produto: i.nome,
    quantidade: Number(i.quantidade),
    preco_unitario: Number(i.preco_unitario),
    total: parseFloat((Number(i.preco_unitario) * Number(i.quantidade)).toFixed(2)),
  }));
  const { error: iErr } = await sb.from('itens_pedido').insert(rows);
  if (iErr) throw new Error(`Supabase/criarItens: ${iErr.message}`);

  await atualizarStatsCliente(cliente.id, total, cliente.total_gasto || 0, cliente.total_pedidos || 0);

  return { numeroPedido: pedido.numero_pedido, total: pedido.total, subtotal, taxaEntrega, formaPagamento };
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
  carregarRascunho, salvarRascunho, limparRascunho,
  buscarProdutos, buscarMistura, buscarInfo,
  buscarOuCriarCliente, criarPedidoCompleto, atualizarStatusPedido,
};
