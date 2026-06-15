'use strict';

const db = require('../services/supabase');

// ─── DEFINIÇÃO DAS TOOLS (formato OpenAI function calling) ───────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_cardapio',
      description: 'Retorna todos os produtos disponíveis com preços. Use SEMPRE que o cliente perguntar o que tem, preços ou quiser fazer um pedido.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_mistura_do_dia',
      description: 'Retorna os acompanhamentos especiais da marmitex de hoje. Use sempre ao falar sobre marmitex.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'info_restaurante',
      description: 'Retorna chave PIX, endereço, horário e status da loja (aberta/fechada). Use para enviar chave PIX ou verificar horários.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_dados_pedido',
      description: 'Salva os dados coletados do pedido no rascunho. Use conforme for coletando cada informação do cliente (não espere ter tudo para salvar).',
      parameters: {
        type: 'object',
        properties: {
          nome_cliente:     { type: 'string',  description: 'Nome completo do cliente' },
          itens:            { type: 'array',   description: 'Lista de itens com nome, quantidade e preco_unitario', items: { type: 'object', properties: { nome: { type: 'string' }, quantidade: { type: 'number' }, preco_unitario: { type: 'number' } }, required: ['nome', 'quantidade', 'preco_unitario'] } },
          tipo_entrega:     { type: 'string',  enum: ['delivery', 'retirada'] },
          endereco:         { type: 'string',  description: 'Endereço de entrega (só se delivery)' },
          forma_pagamento:  { type: 'string',  enum: ['pix', 'dinheiro', 'cartao'] },
          etapa_atual:      { type: 'string',  enum: ['coletando_itens', 'coletando_dados', 'aguardando_confirmacao', 'aguardando_pix'], description: 'Etapa atual do atendimento' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atualizar_status_pedido',
      description: 'Atualiza o status do pedido para aguardando_preparo após confirmar comprovante PIX.',
      parameters: {
        type: 'object',
        properties: {
          novo_status: { type: 'string', enum: ['aguardando_preparo', 'cancelado'] },
        },
        required: ['novo_status'],
      },
    },
  },
];

// ─── EXECUTOR ─────────────────────────────────────────────────────────────────

async function executarTool(nome, args, contexto = {}) {
  const { telefone } = contexto;

  switch (nome) {

    case 'buscar_cardapio': {
      const produtos = await db.buscarProdutos();
      if (!produtos.length) return 'Cardápio indisponível no momento.';

      const cats = {};
      for (const p of produtos) {
        if (!cats[p.categoria]) cats[p.categoria] = [];
        cats[p.categoria].push(p);
      }

      let txt = '📋 CARDÁPIO CHAPELÃO\n\n';
      for (const [cat, itens] of Object.entries(cats)) {
        txt += `${cat.toUpperCase()}\n`;
        for (const p of itens) {
          txt += `• ${p.nome} — R$ ${Number(p.preco).toFixed(2).replace('.', ',')}`;
          if (p.descricao) txt += ` (${p.descricao})`;
          txt += '\n';
        }
        txt += '\n';
      }
      return txt.trim();
    }

    case 'buscar_mistura_do_dia': {
      const m = await db.buscarMistura();
      if (!m) return 'Nenhuma mistura especial cadastrada hoje.';
      return `🌶️ MISTURA DE HOJE\n\n${m.titulo}\n${m.descricao || ''}`;
    }

    case 'info_restaurante': {
      const info = await db.buscarInfo();
      return JSON.stringify({
        nome: info.nome_restaurante || 'Chapelão',
        endereco: info.endereco || '',
        chave_pix: info.chave_pix || '',
        horario: info.horario_funcionamento || 'Segunda a Sábado, 10h às 15h',
        loja_aberta: info.loja_aberta !== 'false',
        taxa_entrega: 'R$ 5,00 (delivery) / grátis (retirada)',
      });
    }

    case 'salvar_dados_pedido': {
      if (!telefone) return 'Erro: telefone não disponível no contexto.';
      const campos = {};
      if (args.nome_cliente)    campos.nome_cliente   = args.nome_cliente;
      if (args.itens)           campos.itens          = JSON.stringify(args.itens);
      if (args.tipo_entrega)    campos.tipo_entrega   = args.tipo_entrega;
      if (args.endereco)        campos.endereco       = args.endereco;
      if (args.forma_pagamento) campos.forma_pagamento = args.forma_pagamento;
      if (args.etapa_atual)     campos.etapa_atual    = args.etapa_atual;

      await db.salvarRascunho(telefone, campos);
      return `Dados salvos no rascunho: ${JSON.stringify(campos)}`;
    }

    case 'atualizar_status_pedido': {
      if (!telefone) return 'Erro: telefone não disponível.';
      const pedido = await db.atualizarStatusPedido(telefone, args.novo_status);
      return JSON.stringify({ sucesso: true, numero_pedido: pedido.numero_pedido, novo_status: args.novo_status });
    }

    default:
      throw new Error(`Tool desconhecida: ${nome}`);
  }
}

module.exports = { TOOLS, executarTool };
