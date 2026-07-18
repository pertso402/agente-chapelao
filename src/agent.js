'use strict';

const OpenAI = require('openai');
const { TOOLS, executarTool } = require('./tools');
const { salvarRascunho, limparRascunho, criarPedidoCompleto } = require('./services/supabase');
const { avaliarRascunho, descreverFaltando, parseItens } = require('./utils/pedido');
const { comRetry } = require('./utils/retry');
const logger = require('./logger');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const MODEL = 'gpt-4o';
const MAX_TOKENS = 1024;
const MAX_ITER = 8;

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

function buildSystemPrompt(rascunho) {
  let estado = '';
  if (rascunho) {
    const av = avaliarRascunho(rascunho);
    const itens = parseItens(rascunho.itens);
    const linhas = [
      itens.length          && `- Itens: ${itens.map(i => `${i.quantidade}x ${i.nome}`).join(', ')}`,
      rascunho.nome_cliente && `- Nome: ${rascunho.nome_cliente}`,
      rascunho.tipo_entrega && `- Entrega: ${rascunho.tipo_entrega}`,
      rascunho.endereco     && `- Endereço: ${rascunho.endereco}`,
      rascunho.forma_pagamento && `- Pagamento: ${rascunho.forma_pagamento}`,
    ].filter(Boolean);

    estado = `\n\n## ESTADO ATUAL DO PEDIDO (já coletado — NÃO pergunte de novo)\n${linhas.join('\n') || '- (vazio)'}`;
    if (av.completo) {
      estado += `\n\n✅ TUDO COLETADO. Apresente o RESUMO FINAL e peça *SIM*. NÃO chame mais salvar_dados_pedido.`;
    } else {
      estado += `\n\n⏳ AINDA FALTA: ${descreverFaltando(av.faltando)}. Pergunte isso de forma natural.`;
    }
  }

  return `Você é "Chapinha" 🎩, o atendente virtual do Restaurante Chapelão — uma marmitaria de comida caseira de verdade em Umuarama-PR.

## PERSONALIDADE
- Caloroso, simpático, ágil e objetivo. Português brasileiro natural, com leveza e bom humor.
- Emojis com moderação. Trate o cliente pelo nome quando souber.
- Mensagens curtas e claras (é WhatsApp). Conduza a conversa — não deixe o cliente perdido.${estado}

## SEU OBJETIVO
Conduzir o cliente do "oi" até o pedido confirmado, SEM falhar nenhuma etapa. Você coleta e organiza; o SISTEMA fecha o pedido.

## FLUXO DE ATENDIMENTO (conduza ativamente)
1. Saudação calorosa + pergunte o que a pessoa deseja hoje.
2. Para mostrar itens/preços: chame buscar_cardapio ANTES. Para marmitex: chame TAMBÉM buscar_itens_do_dia.
3. Ajude a escolher. Assim que o cliente escolher um item, chame salvar_dados_pedido (NOMES EXATOS do cardápio) e em seguida CONFIRME de volta o item e o preço que o sistema registrou — ex: "Anotei: 1× Marmitex Pequena — R$ 23,00 ✅ Mais alguma coisa?". Só avance depois dessa confirmação. Esse eco evita registrar o item errado.
4. Pergunte: entrega (delivery) ou retirada? → se delivery, peça o endereço completo.
5. Pergunte a forma de pagamento: PIX, dinheiro ou cartão.
6. SEMPRE que coletar algo, chame salvar_dados_pedido. O retorno te diz o que ainda falta.
7. Quando o retorno disser "PRONTO_PARA_CONFIRMACAO": apresente o RESUMO FINAL e peça *SIM*.
8. Após o pedido confirmado (PIX): o sistema envia a chave. Quando chegar "📎 COMPROVANTE PIX CONFIRMADO", chame atualizar_status_pedido com "aguardando_preparo" e agradeça.

## REGRAS CRÍTICAS (NUNCA quebrar)
⛔ NUNCA invente produtos, preços, chave PIX ou horário — sempre use as tools. Os preços vêm do sistema.
⛔ NUNCA escreva "frete incluso". A taxa de entrega é à parte (use info_restaurante para o valor).
⛔ NUNCA pergunte algo que já está no ESTADO ATUAL acima.
⛔ NUNCA diga que o pedido foi confirmado/registrado por conta própria — quem confirma é o SISTEMA após o cliente dizer SIM.
⛔ Se um item não existir no cardápio (a tool avisa em "itens_nao_encontrados"), peça para o cliente escolher um nome válido.
⛔ Se a loja estiver fechada (info_restaurante → loja_aberta:false), informe o horário e não monte pedido.
⛔ ATENÇÃO LITERAL a tamanho e quantidade: pequena ≠ média ≠ grande. Use EXATAMENTE o tamanho que o cliente falou nesta mensagem. Na menor dúvida, pergunte — nunca chute nem "arredonde" para outro tamanho.
⛔ Cada pedido é INDEPENDENTE. Monte os itens SÓ com o que o cliente pediu NESTA conversa. IGNORE completamente itens de pedidos anteriores já finalizados que apareçam no histórico — eles não valem para o pedido atual.

## FORMATO DO RESUMO FINAL (obrigatório antes do SIM)
🎩 *Confira seu pedido:*
[qtd]x [item] — R$ [valor] (uma linha por item)
📍 [Entrega no endereço X | Retirada no local]
💳 Pagamento: [forma]
🛍️ Subtotal: R$ X,XX
🚴 Taxa de entrega: R$ X,XX  ← só se for delivery
💰 *Total: R$ X,XX*  ← subtotal + taxa

_Responde *SIM* pra eu fechar o pedido, ou me diz se quer mudar algo._`;
}

// ─── LOOP PRINCIPAL DO AGENTE ─────────────────────────────────────────────────

async function rodarAgente(mensagemUsuario, historico, rascunho, requestId, telefone) {
  const openai = getClient();

  const messages = [
    ...historico.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: mensagemUsuario },
  ];

  const systemMsg = { role: 'system', content: buildSystemPrompt(rascunho) };

  logger.step(requestId, telefone, 'agente/chamando-openai', {
    model: MODEL,
    historico_msgs: historico.length,
    etapa: rascunho?.etapa_atual || 'inicio',
  });

  let resposta = await comRetry(
    () => openai.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [systemMsg, ...messages],
      tools: TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }),
    { tentativas: 3, requestId, etapa: 'openai/create' }
  );

  let iteracoes = 0;

  while (resposta.choices[0].finish_reason === 'tool_calls' && iteracoes < MAX_ITER) {
    iteracoes++;
    const assistantMsg = resposta.choices[0].message;
    messages.push(assistantMsg);

    const toolResults = [];
    for (const toolCall of (assistantMsg.tool_calls || [])) {
      const nomeTool = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}

      logger.step(requestId, telefone, `tool/${nomeTool}`, { args });

      let resultado;
      try {
        resultado = await executarTool(nomeTool, args, { telefone });
        logger.info(`tool/${nomeTool}/ok`, 'Executada', { requestId, telefone });
      } catch (err) {
        resultado = `ERRO em ${nomeTool}: ${err.message}`;
        logger.error(`tool/${nomeTool}/erro`, err.message, { requestId, telefone, stack: err.stack });
      }

      toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: String(resultado) });
    }

    messages.push(...toolResults);

    resposta = await comRetry(
      () => openai.chat.completions.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [systemMsg, ...messages],
        tools: TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: false,
      }),
      { tentativas: 3, requestId, etapa: 'openai/create-loop' }
    );
  }

  if (iteracoes >= MAX_ITER) {
    logger.warn('agente/max-iter', 'Limite de iterações atingido', { requestId, telefone });
  }

  const textoFinal = resposta.choices[0].message?.content?.trim() || '';
  logger.step(requestId, telefone, 'agente/ok', {
    iteracoes,
    finish_reason: resposta.choices[0].finish_reason,
    resposta_len: textoFinal.length,
  });

  return textoFinal;
}

// ─── CONFIRMAR PEDIDO (acionado pelo SIM do cliente, no código) ──────────────
// Cria o pedido diretamente. Trava anti-duplicação: vira a etapa ANTES de criar.

async function confirmarPedido(rascunho, telefone, requestId) {
  // Revalidação defensiva — só confirma se realmente está completo
  const av = avaliarRascunho(rascunho);
  if (!av.completo) {
    const erro = new Error(`Rascunho incompleto: falta ${descreverFaltando(av.faltando)}`);
    erro.faltando = av.faltando;
    throw erro;
  }

  // Trava: marca como "processando" para que um SIM duplicado não reentre
  await salvarRascunho(telefone, { etapa_atual: 'processando' });

  let resultado;
  try {
    resultado = await comRetry(
      () => criarPedidoCompleto({
        nomeCliente:    rascunho.nome_cliente,
        telefone,
        tipoEntrega:    rascunho.tipo_entrega,
        endereco:       rascunho.endereco,
        formaPagamento: rascunho.forma_pagamento,
        itens:          rascunho.itens,
      }),
      { tentativas: 2, requestId, etapa: 'confirmarPedido' }
    );
  } catch (err) {
    // Reverte para permitir nova tentativa do cliente
    await salvarRascunho(telefone, { etapa_atual: 'aguardando_confirmacao' });
    throw err;
  }

  if (resultado.formaPagamento === 'pix') {
    // Mantém o rascunho aguardando comprovante
    await salvarRascunho(telefone, { etapa_atual: 'aguardando_pix' });
  } else {
    // Pedido fechado — limpa o rascunho para a próxima conversa começar zerada
    await limparRascunho(telefone);
  }

  logger.info('pedido/criado', 'Pedido registrado via SIM', {
    requestId, telefone,
    numero_pedido: resultado.numeroPedido,
    total: resultado.total,
    forma: resultado.formaPagamento,
  });

  return resultado;
}

module.exports = { rodarAgente, confirmarPedido, buildSystemPrompt };
