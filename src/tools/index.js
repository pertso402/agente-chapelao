'use strict';

const db = require('../services/supabase');
const { descreverFaltando, parseItens, montarResumoFinal, avaliarRascunho, calcularTotais } = require('../utils/pedido');
const { TAXA_ENTREGA, FRETE_GRATIS_ACIMA_DE, PAUSA_ATENDENTE_MS, fmtBRL } = require('../config');

// Ordem das categorias: comida primeiro, bebidas/condimentos por último
const ORDEM_CATEGORIA = { 'marmitex': 0, 'combos': 1, 'combo': 1, 'maioneses': 8, 'bebidas': 9 };
function prioridadeCategoria(cat) {
  const k = String(cat || '').toLowerCase().trim();
  return ORDEM_CATEGORIA[k] ?? 5;
}

// ─── DEFINIÇÃO DAS TOOLS (formato OpenAI function calling) ───────────────────

// Cada tool é declarada uma vez aqui e embrulhada no formato da API logo
// abaixo — assim nome, descrição e schema ficam legíveis sem o aninhamento.
const DEFINICOES = [
  {
    name: 'buscar_cardapio',
    description: 'Retorna todos os produtos disponíveis com preços REAIS. Use SEMPRE antes de citar qualquer produto, preço ou quando o cliente quiser pedir. Nunca invente itens.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'buscar_itens_do_dia',
    description: 'Retorna as carnes, base e acompanhamentos disponíveis HOJE na marmitex — a mesma configuração que a cozinha usa no ERP (Porcionamento → Itens do dia). Use sempre que falar de marmitex.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'info_restaurante',
    description: 'Retorna chave PIX, endereço, horário, taxa de entrega e status (aberta/fechada). Use para enviar PIX ou verificar horário/taxa.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'salvar_dados_pedido',
    description: 'Salva/atualiza os dados do pedido no rascunho. Chame SEMPRE que coletar qualquer informação (itens, nome, entrega, endereço, pagamento) — pode chamar com um campo só, ou sem nenhum campo apenas para consultar o estado atual. O retorno diz o que ainda falta e, quando estiver tudo completo, entrega o RESUMO FINAL já pronto para você copiar. NÃO precisa enviar tudo de uma vez.',
    parameters: {
      type: 'object',
      properties: {
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        itens: {
          type: 'array',
          description: 'Lista COMPLETA dos itens do pedido (substitui a lista anterior inteira, não é acréscimo). Use os NOMES EXATOS do cardápio. O preço é preenchido pelo sistema.',
          items: {
            type: 'object',
            properties: {
              nome:            { type: 'string', description: 'Nome do produto exatamente como no cardápio' },
              quantidade:      { type: 'number' },
              carnes:          { type: 'array', items: { type: 'string' }, description: 'SÓ pra item de Marmitex: carnes escolhidas (máx 2), nomes exatos de buscar_itens_do_dia.' },
              acompanhamentos: { type: 'array', items: { type: 'string' }, description: 'SÓ pra item de Marmitex: acompanhamentos escolhidos (máx 6), nomes exatos de buscar_itens_do_dia.' },
            },
            required: ['nome', 'quantidade'],
          },
        },
        itens_brinde: {
          type: 'array',
          description: 'SÓ use quando o cliente tiver cupom de BRINDE ativo (informado no contexto). São os itens de cortesia que ele escolheu. Use os NOMES EXATOS do cardápio. O sistema zera o preço automaticamente.',
          items: {
            type: 'object',
            properties: {
              nome:       { type: 'string', description: 'Nome do produto exatamente como no cardápio' },
              quantidade: { type: 'number' },
            },
            required: ['nome', 'quantidade'],
          },
        },
        tipo_entrega:    { type: 'string', enum: ['delivery', 'retirada'] },
        endereco:        { type: 'string', description: 'Endereço completo (só se delivery)' },
        forma_pagamento: { type: 'string', enum: ['pix', 'dinheiro', 'cartao'] },
        troco_para:      {
          type: 'number',
          description: 'SÓ quando forma_pagamento for "dinheiro". É a nota com que o cliente vai pagar (ex: 100 se ele disser "troco pra 100"). Se ele disser que tem o valor certo ou que não precisa de troco, envie 0. NUNCA envie o valor do troco calculado — envie a nota que ele vai entregar. Quem calcula o troco é o sistema.',
        },
      },
      required: [],
    },
  },
  {
    name: 'atualizar_status_pedido',
    description: 'Atualiza o status do pedido. Use "preparando" após confirmar comprovante PIX.',
    parameters: {
      type: 'object',
      properties: { novo_status: { type: 'string', enum: ['preparando', 'cancelado'] } },
      required: ['novo_status'],
    },
  },
  {
    name: 'chamar_atendente',
    description: 'Chama um atendente HUMANO. Use SEMPRE que: você não souber responder algo com certeza; tiver qualquer dúvida real sobre o que fazer; o cliente pedir algo fora do fluxo normal (alterar pedido já fechado, cancelar, reclamar, negociar preço/desconto, pedir nota fiscal, perguntar sobre pedido anterior); ou acontecer qualquer coisa que você não consiga resolver sozinho com as outras tools. Na dúvida entre chutar e chamar — CHAME. O sistema cria um alerta no painel e pausa seu atendimento por 10 minutos para o atendente assumir.',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumo curto e claro do que o cliente precisa/está reclamando, pra o atendente entender rápido sem reler a conversa toda.' },
      },
      required: ['motivo'],
    },
  },
];

// ─── EXECUTOR ─────────────────────────────────────────────────────────────────

async function executarTool(nome, args, contexto = {}) {
  const { telefone, ofertaAtiva } = contexto;

  switch (nome) {

    case 'buscar_cardapio': {
      const produtos = await db.buscarProdutos();
      if (!produtos.length) return 'Cardápio indisponível no momento.';

      const cats = {};
      for (const p of produtos) {
        const c = (p.categoria || 'Outros').trim();
        (cats[c] = cats[c] || []).push(p);
      }

      const ordenadas = Object.keys(cats).sort((a, b) => prioridadeCategoria(a) - prioridadeCategoria(b));

      // Formato WhatsApp: *negrito* pra categoria, SEM markdown de header (### não
      // renderiza no WhatsApp, vira texto literal feio) e sem peso/gramagem na
      // linha do preço — isso fica só na seção de detalhes internos abaixo.
      let txt = '🍽️ *Cardápio Chapelão*\n\n';
      for (const cat of ordenadas) {
        txt += `*${cat}*\n`;
        for (const p of cats[cat]) {
          const preco = db.precoFinal(p);
          txt += `🔸 ${p.nome.trim()} — ${fmtBRL(preco)}\n`;
        }
        txt += '\n';
      }

      const detalhes = produtos.filter(p => p.descricao);
      if (detalhes.length) {
        txt += '---\n[USO INTERNO — não repita isso pro cliente, é só pra você responder SE ele perguntar peso/detalhe de um item específico]\n';
        txt += detalhes.map(p => `${p.nome.trim()}: ${p.descricao}`).join('\n');
      }

      return txt.trim();
    }

    case 'buscar_itens_do_dia': {
      const itens = await db.buscarItensDoDia();
      if (!itens) return 'Hoje ainda não há itens configurados na marmitex. Avise que a equipe está atualizando o cardápio do dia e ofereça o restante do cardápio (buscar_cardapio).';

      let txt = '🌶️ *Marmitex de Hoje*\n\n';
      if (itens.carne.length) txt += `🥩 *Carnes (escolha até 2):* ${itens.carne.join(', ')}\n`;
      const acompanhamentosTodos = [...itens.base, ...itens.acompanhamento];
      if (acompanhamentosTodos.length) txt += `🍚 *Acompanhamentos (escolha até 6):* ${acompanhamentosTodos.join(', ')}\n`;
      if (txt === '🌶️ *Marmitex de Hoje*\n\n') return 'Hoje ainda não há itens configurados na marmitex. Avise que a equipe está atualizando o cardápio do dia.';

      return txt.trim();
    }

    case 'info_restaurante': {
      const info = await db.buscarInfo();
      return JSON.stringify({
        nome: info.nome || 'Restaurante Chapelão',
        endereco: info.endereco || '',
        chave_pix: info.chave_pix || '',
        horario: info.horario || 'Seg a Sáb, 11h às 14h',
        loja_aberta: String(info.loja_aberta) !== 'false',
        // Taxa vem de src/config.js — valor fixo e único do sistema. O campo
        // taxa_entrega do banco é ignorado de propósito.
        taxa_entrega_reais: TAXA_ENTREGA,
        frete_gratis_acima_de_reais: FRETE_GRATIS_ACIMA_DE,
        observacao_frete: `A entrega custa ${fmtBRL(TAXA_ENTREGA)} para qualquer endereço, MAS é GRÁTIS em pedidos acima de ${fmtBRL(FRETE_GRATIS_ACIMA_DE)}. Nunca cite a taxa sozinha: cite sempre junto com o frete grátis, porque é isso que faz o cliente aumentar o pedido em vez de desistir.`,
        pedido_minimo_reais: Number(info.pedido_minimo || 0),
      });
    }

    case 'salvar_dados_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível no contexto.';

      const campos = {};
      if (args.nome_cliente)    campos.nome_cliente    = args.nome_cliente;
      if (args.itens)           campos.itens           = args.itens;
      if (args.itens_brinde)    campos.itens_brinde    = args.itens_brinde;
      if (args.tipo_entrega)    campos.tipo_entrega    = args.tipo_entrega;
      if (args.endereco)        campos.endereco        = args.endereco;
      if (args.forma_pagamento) campos.forma_pagamento = args.forma_pagamento;
      // troco 0 é resposta válida ("tenho o valor certo") — por isso o teste é
      // contra null/undefined, não contra "valor falsy".
      if (args.troco_para != null) campos.troco_para = Math.max(0, Number(args.troco_para) || 0);

      // Chamada sem nenhum campo é legítima: é assim que o agente pede o
      // RESUMO_FINAL_TEXTO_EXATO quando o pedido já estava completo antes
      // desta mensagem (ex.: cliente disse "e aí, quanto ficou?").
      let rascunho, avaliacao, naoEncontrados = [], avisos = [];
      if (Object.keys(campos).length) {
        ({ rascunho, avaliacao, naoEncontrados, avisos } = await db.atualizarRascunho(telefone, campos));
      } else {
        rascunho = await db.carregarRascunho(telefone);
        if (!rascunho) {
          return 'Nenhum pedido em andamento e nenhum campo enviado. Comece coletando os itens com o cliente.';
        }
        avaliacao = avaliarRascunho(rascunho);
      }

      const itens = parseItens(rascunho.itens);
      const brindes = parseItens(rascunho.itens_brinde);

      // Primeiro sinal real de interesse (carrinho montado) — alimenta a tag do cliente
      if (itens.length) db.marcarInteresse(telefone).catch(() => {});

      const resumo = {
        salvo: true,
        itens: itens.map(i => `${i.quantidade}x ${i.nome}${i.observacao ? ` (${i.observacao})` : ''} (${fmtBRL(i.preco_unitario)} cada)`),
        brindes: brindes.length ? brindes.map(b => `${b.quantidade}x ${b.nome} (cortesia)`) : undefined,
        nome: rascunho.nome_cliente || null,
        tipo_entrega: rascunho.tipo_entrega || null,
        endereco: rascunho.endereco || null,
        forma_pagamento: rascunho.forma_pagamento || null,
        troco_para: rascunho.troco_para == null
          ? null
          : (Number(rascunho.troco_para) === 0 ? 'não precisa de troco' : fmtBRL(rascunho.troco_para)),
      };

      if (avisos?.length) resumo.AVISOS = avisos;

      // ── Munição de venda, já calculada ──────────────────────────────────
      // O agente não faz conta: ele recebe o gancho pronto. Enquanto o
      // pedido não fecha, este é o argumento mais forte que existe pra
      // aumentar o valor sem empurrar item que o cliente não quer.
      if (itens.length && !avaliacao.completo) {
        const parcial = calcularTotais({
          itens,
          tipoEntrega: rascunho.tipo_entrega || 'delivery',
          cupom: ofertaAtiva || null,
        });
        resumo.subtotal_ate_agora = fmtBRL(parcial.subtotal);
        if (parcial.freteGratis) {
          resumo.FRETE_GRATIS_CONQUISTADO =
            `O pedido já passou de ${fmtBRL(FRETE_GRATIS_ACIMA_DE)} — a entrega saiu de graça. Diga isso pro cliente, é um ganho que ele acabou de ter.`;
        } else if (parcial.faltaParaFreteGratis > 0) {
          resumo.FALTA_PARA_FRETE_GRATIS = fmtBRL(parcial.faltaParaFreteGratis);
          resumo.gancho_frete_gratis =
            `Faltam ${fmtBRL(parcial.faltaParaFreteGratis)} pro frete sair de graça (pedidos acima de ${fmtBRL(FRETE_GRATIS_ACIMA_DE)}). Ofereça UM item específico do cardápio que feche essa diferença — não uma lista, um item só, com o preço colado.`;
        }
      }

      if (naoEncontrados.length) {
        resumo.ATENCAO_itens_nao_encontrados = naoEncontrados;
        resumo.instrucao = `Estes itens NÃO existem no cardápio: ${naoEncontrados.join(', ')}. Confirme com o cliente o nome correto.`;
      }

      if (avaliacao.completo) {
        // O SISTEMA calcula os totais e RENDERIZA o resumo. A LLM não faz conta
        // nem monta esse texto — ela copia. É a mesma função de precificação
        // usada para gravar o pedido depois do SIM, então resumo e pedido
        // confirmado não têm como divergir em nenhum centavo.
        const p = await db.precificarPedido({
          itens: rascunho.itens,
          itensBrinde: rascunho.itens_brinde,
          tipoEntrega: rascunho.tipo_entrega,
          cupom: ofertaAtiva || null,
        });

        resumo.status = 'PRONTO_PARA_CONFIRMACAO';
        resumo.subtotal = fmtBRL(p.subtotal);
        resumo.taxa_entrega = fmtBRL(p.taxaEntrega);
        resumo.desconto = fmtBRL(p.desconto);
        resumo.total = fmtBRL(p.total);
        resumo.RESUMO_FINAL_TEXTO_EXATO = montarResumoFinal({
          itens: p.itens,
          brindes: p.brindes,
          tipoEntrega: rascunho.tipo_entrega,
          endereco: rascunho.endereco,
          formaPagamento: rascunho.forma_pagamento,
          trocoPara: rascunho.troco_para,
          totais: p,
          cupomCodigo: ofertaAtiva?.codigo,
        });
        resumo.instrucao_final =
          'ENVIE O CAMPO RESUMO_FINAL_TEXTO_EXATO COMO SUA RESPOSTA, LETRA POR LETRA, ' +
          'SEM REESCREVER, SEM RECALCULAR NENHUM VALOR, SEM ACRESCENTAR NEM REMOVER LINHAS. ' +
          'Não escreva mais nada antes nem depois. O SISTEMA cria o pedido quando o cliente responder SIM — você NÃO cria.';
      } else {
        resumo.status = 'FALTA_COLETAR';
        resumo.falta = descreverFaltando(avaliacao.faltando);
        resumo.instrucao_final = `Ainda falta coletar: ${descreverFaltando(avaliacao.faltando)}. Continue a conversa naturalmente para obter isso. NÃO apresente resumo nem total agora.`;
      }

      return JSON.stringify(resumo);
    }

    case 'atualizar_status_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível.';
      const pedido = await db.atualizarStatusPedido(telefone, args.novo_status);
      return JSON.stringify({ sucesso: true, numero_pedido: pedido.numero_pedido, novo_status: args.novo_status });
    }

    case 'chamar_atendente': {
      if (!telefone) return 'ERRO: telefone não disponível.';
      const rascunho = await db.carregarRascunho(telefone);
      await db.criarAlertaAtendimento(telefone, rascunho?.nome_cliente, args.motivo);
      // Pausa de 10 minutos: tempo do atendente ver o alerta e assumir. Se ele
      // responder pelo WhatsApp, cada mensagem estende a pausa; se resolver
      // pelo painel, a pausa é liberada na hora, sem esperar o timeout.
      await db.pausarAtendimento(telefone, PAUSA_ATENDENTE_MS, `atendente chamado: ${args.motivo}`);
      return JSON.stringify({
        sucesso: true,
        instrucao: 'Avise o cliente, com tranquilidade e em UMA frase curta, que um atendente humano vai assumir a conversa em instantes. NÃO tente mais resolver isso sozinho, não faça perguntas e não continue o pedido — encerre sua resposta por aqui.',
      });
    }

    default:
      throw new Error(`Tool desconhecida: ${nome}`);
  }
}

const TOOLS = DEFINICOES.map(d => ({ type: 'function', function: d }));

module.exports = { TOOLS, executarTool };
