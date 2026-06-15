'use strict';

const OpenAI = require('openai');
const { TOOLS, executarTool } = require('./tools');
const { salvarRascunho, limparRascunho, criarPedidoCompleto } = require('./services/supabase');
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
  const estado = rascunho
    ? `\n\n## ESTADO ATUAL DO PEDIDO (dados já coletados — NÃO pergunte de novo)\n${[
        rascunho.nome_cliente   && `- Nome: ${rascunho.nome_cliente}`,
        rascunho.itens          && `- Itens: ${rascunho.itens}`,
        rascunho.tipo_entrega   && `- Entrega: ${rascunho.tipo_entrega}`,
        rascunho.endereco       && `- Endereço: ${rascunho.endereco}`,
        rascunho.forma_pagamento && `- Pagamento: ${rascunho.forma_pagamento}`,
        rascunho.etapa_atual    && `- Etapa: ${rascunho.etapa_atual}`,
      ].filter(Boolean).join('\n')}`
    : '';

  return `Você é "Chapinha" 🎩, assistente virtual do Restaurante Chapelão — marmitaria com comida caseira de verdade.

## PERSONALIDADE
- Caloroso, simpático, direto e eficiente
- Português brasileiro natural, leve, com algum humor
- Emojis com moderação
- Trate o cliente pelo nome quando souber${estado}

## FLUXO OBRIGATÓRIO
1. Saudação + apresentação breve (bom dia/tarde/noite conforme horário do Brasil)
2. Pergunte o que o cliente deseja
3. Cardápio → use buscar_cardapio ANTES de citar qualquer produto. Para marmitex, sempre chame buscar_mistura_do_dia também
4. Auxilie na escolha. Quando o cliente decidir, confirme os itens
5. Salve os itens imediatamente com salvar_dados_pedido (etapa_atual: "coletando_dados")
6. Colete: nome completo → delivery ou retirada → endereço se delivery
7. Salve cada dado coletado com salvar_dados_pedido
8. Pergunte a forma de pagamento (PIX, dinheiro ou cartão)
9. Com TODOS os dados, salve com etapa_atual: "aguardando_confirmacao" e apresente RESUMO FINAL
10. No resumo, instrua: "Responda SIM para confirmar o pedido" (o sistema processa automaticamente)
11. PIX → use info_restaurante para a chave, envie, diga para mandar o comprovante
12. Ao receber "📎 COMPROVANTE PIX CONFIRMADO" → use atualizar_status_pedido com "aguardando_preparo"
13. Confirme pedido em preparo + prazo (delivery ~35min, retirada ~20min)

## REGRAS CRÍTICAS
⛔ NUNCA invente produtos, preços ou chave PIX — use as tools
⛔ NUNCA chame criar_pedido — o SISTEMA cria automaticamente quando cliente responde SIM
⛔ NUNCA pergunte algo que já está no ESTADO ATUAL DO PEDIDO acima
⛔ Se loja fechada (info_restaurante retorna loja_aberta:false) → informe horário, não aceite pedido
⛔ Imagem que NÃO é comprovante: diga o que viu e continue o atendimento normalmente

## FORMATO DO RESUMO FINAL (obrigatório antes do SIM)
🎩 *Resumo do seu pedido:*
[lista de itens com qtd e valor]
📍 [Entrega/Retirada]: [endereço ou "no local"]
💳 Pagamento: [forma]
🛍️ Subtotal: R$ X,XX
🚴 Taxa de entrega: R$ 5,00 ← incluir SOMENTE se for delivery. Se retirada, omitir esta linha.
💰 *Total: R$ X,XX* ← subtotal + taxa de entrega (nunca dizer "frete incluso")

_Responda *SIM* para confirmar ou me diga se quer alterar algo._

## REGRA DE FRETE
- Delivery: taxa fixa de R$ 5,00 sempre (sem exceção)
- Retirada no local: sem taxa
- NUNCA escreva "frete incluso" — sempre mostre subtotal e total separados quando houver taxa`;
}

// ─── LOOP PRINCIPAL DO AGENTE ─────────────────────────────────────────────────

async function rodarAgente(mensagemUsuario, historico, rascunho, requestId, telefone) {
  const openai = getClient();

  const messages = [
    ...historico.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: mensagemUsuario },
  ];

  logger.step(requestId, telefone, 'agente/chamando-openai', {
    model: MODEL,
    historico_msgs: historico.length,
    tem_rascunho: !!rascunho,
    etapa: rascunho?.etapa_atual || 'inicio',
  });

  const systemMsg = { role: 'system', content: buildSystemPrompt(rascunho) };

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
      const nome = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}

      logger.step(requestId, telefone, `tool/${nome}`, { args });

      let resultado;
      try {
        resultado = await executarTool(nome, args, { telefone });
        logger.info(`tool/${nome}/ok`, 'Executada com sucesso', { requestId, telefone });
      } catch (err) {
        resultado = `ERRO em ${nome}: ${err.message}`;
        logger.error(`tool/${nome}/erro`, err.message, { requestId, telefone, stack: err.stack });
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: String(resultado),
      });
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

// ─── CONFIRMAR PEDIDO (acionado pelo SIM do cliente) ─────────────────────────
// Cria o pedido diretamente no banco — sem depender do agente chamar a tool.

async function confirmarPedido(rascunho, telefone, requestId) {
  let itens;
  try {
    itens = typeof rascunho.itens === 'string' ? JSON.parse(rascunho.itens) : rascunho.itens;
  } catch {
    throw new Error('Itens do rascunho inválidos para criar pedido.');
  }

  const resultado = await comRetry(
    () => criarPedidoCompleto({
      nomeCliente:     rascunho.nome_cliente,
      telefone,
      tipoEntrega:     rascunho.tipo_entrega,
      endereco:        rascunho.endereco,
      formaPagamento:  rascunho.forma_pagamento,
      itens,
    }),
    { tentativas: 2, requestId, etapa: 'confirmarPedido' }
  );

  // Atualizar etapa no rascunho (mantém dados para referência, muda etapa)
  await salvarRascunho(telefone, { etapa_atual: 'aguardando_pix' });

  logger.info('pedido/criado', 'Pedido registrado via SIM', {
    requestId,
    telefone,
    numero_pedido: resultado.numeroPedido,
    total: resultado.total,
  });

  return resultado;
}

module.exports = { rodarAgente, confirmarPedido };
