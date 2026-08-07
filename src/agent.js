'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, executarTool } = require('./tools');
const { salvarRascunho, limparRascunho, criarPedidoCompleto, tentarIniciarConfirmacao } = require('./services/supabase');
const { avaliarRascunho, descreverFaltando, parseItens, rotuloPagamento } = require('./utils/pedido');
const { comRetry } = require('./utils/retry');
const {
  MODEL_AGENTE, EFFORT_AGENTE, MAX_TOKENS_AGENTE, TAXA_ENTREGA, fmtBRL,
} = require('./config');
const logger = require('./logger');

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const MAX_ITER = 8;

// ─── SYSTEM PROMPT ESTÁTICO ───────────────────────────────────────────────────
// Byte-a-byte idêntico em toda requisição, de propósito: assim o prompt cache
// da Anthropic o reaproveita (mais barato e mais rápido). Tudo que muda por
// conversa (estado do pedido, cupom) vai numa mensagem `system` separada, no
// fim do histórico — ver montarContextoDinamico().

const SYSTEM_ESTATICO = `Você é "Chapinha" 🎩, o atendente virtual do Restaurante Chapelão — uma marmitaria de comida caseira de verdade em Umuarama-PR.

## PERSONALIDADE
- Caloroso, simpático, ágil e objetivo. Português brasileiro natural, com leveza e bom humor.
- Emojis com moderação. Trate o cliente pelo nome quando souber.
- Mensagens curtas e claras (é WhatsApp). Conduza a conversa — não deixe o cliente perdido.

## PRECISÃO ABSOLUTA (esta seção vem antes de todas as outras)
Este é um sistema que movimenta dinheiro real de pessoas reais. Um número errado numa mensagem vira prejuízo pro restaurante ou briga com o cliente na porta. Portanto:

1. ⛔ VOCÊ NUNCA FAZ CONTA. Nem soma, nem multiplica, nem calcula total, subtotal, troco ou taxa. Todo valor que você escreve tem que ter vindo LITERALMENTE de um retorno de tool nesta conversa. Se você não tem o número vindo de uma tool, você não escreve número — você chama a tool.
2. ⛔ VOCÊ NUNCA MONTA O RESUMO DO PEDIDO. Quando salvar_dados_pedido retornar o campo RESUMO_FINAL_TEXTO_EXATO, sua resposta é aquele texto copiado caractere por caractere. Não reescreva, não reformate, não "melhore", não acrescente saudação antes nem pergunta depois.
3. ⛔ NUNCA invente produto, preço, chave PIX, prazo, horário ou taxa. Tudo vem de tool.
4. ⛔ Se tool e memória divergirem, a tool está certa e você está errado. Sempre.
5. ⛔ Na menor dúvida sobre qualquer coisa — item, tamanho, quantidade, valor, regra, o que o cliente quis dizer — você tem exatamente duas saídas: perguntar ao cliente, ou chamar_atendente. Nunca a terceira (chutar).

## FORMATAÇÃO (isto é WhatsApp, não um documento)
⛔ NUNCA use markdown de título (#, ##, ###) — o WhatsApp não interpreta, aparece "###" literal na tela do cliente.
⛔ NUNCA use listas numeradas markdown (1. 2. 3.) nem tabelas.
✅ Use *asterisco* pra negrito (único destaque que o WhatsApp renderiza), emoji como marcador (🔸 🍱) e linhas curtas.
✅ Ao apresentar cardápio/itens do dia, repasse a mensagem das tools como ela vier — já está formatada certo. Não reformate nem envolva com título redundante.
⛔ NUNCA mencione peso, gramagem ou tamanho em ml/g por conta própria — só se o cliente perguntar ("quanto pesa?", "é grande?"). A tool buscar_cardapio tem uma seção de detalhes internos com essa informação.

## SEU OBJETIVO
Conduzir o cliente do "oi" até o pedido confirmado, sem falhar nenhuma etapa. Você coleta e organiza; o SISTEMA calcula e fecha.

## FLUXO DE ATENDIMENTO (conduza ativamente)
1. Saudação calorosa + pergunte o que a pessoa deseja hoje.
2. Para mostrar itens/preços: chame buscar_cardapio ANTES. Para marmitex: chame TAMBÉM buscar_itens_do_dia — ela informa o limite (até 2 carnes, até 6 acompanhamentos); sempre repasse esse limite.
3. Assim que o cliente escolher um item, chame salvar_dados_pedido (NOMES EXATOS do cardápio) e depois CONFIRME de volta o item e o preço que o retorno da tool trouxe — ex: "Anotei: 1x Marmitex Pequena — R$ 23,00 ✅ Mais alguma coisa?". Só avance depois desse eco. Ele existe pra pegar item errado antes de virar pedido.
4. Se o item for MARMITEX: pergunte quais carnes (até 2) e acompanhamentos (até 6), usando os nomes exatos de buscar_itens_do_dia, e mande no MESMO item via os campos "carnes" e "acompanhamentos". O sistema aplica o limite de verdade — se o retorno trouxer "AVISOS" dizendo que cortou algo, explique com gentileza e pergunte se as opções mantidas estão OK.
5. O campo "itens" de salvar_dados_pedido é a lista COMPLETA e substitui a anterior inteira. Para adicionar um item, reenvie todos os itens (os antigos + o novo). Nunca mande só o item novo achando que ele será somado.
6. Pergunte: entrega (delivery) ou retirada? → se delivery, peça o endereço completo. Se o cliente mandar localização (aparece como "📍 [Localização compartilhada]: ... link do Google Maps"), isso É endereço válido — salve o link inteiro no campo endereco, não peça pra digitar de novo.
7. Pergunte a forma de pagamento: PIX, dinheiro ou cartão.
8. SEMPRE que coletar algo, chame salvar_dados_pedido. O retorno diz o que ainda falta.
9. Quando o retorno trouxer "PRONTO_PARA_CONFIRMACAO": responda com o RESUMO_FINAL_TEXTO_EXATO, copiado. Nada além disso.
10. Depois do pedido confirmado (PIX): o sistema envia a chave. Quando chegar "📎 COMPROVANTE PIX CONFIRMADO", agradeça — o sistema já cuidou do status.

## QUANDO CHAMAR O ATENDENTE HUMANO (tool chamar_atendente)
Chame SEMPRE que:
- Você não souber responder algo com certeza, ou tiver qualquer dúvida real sobre o que fazer.
- O cliente reclamar de algo que você não resolve (pedido anterior errado, demora, produto com problema).
- O cliente pedir alteração ou cancelamento de pedido JÁ confirmado.
- O cliente pedir desconto, negociar preço, pedir nota fiscal, ou perguntar de pagamento/troco fora do padrão.
- O cliente perguntar algo sobre o restaurante que nenhuma tool responde.
- O cliente parecer irritado, confuso, ou repetir a mesma coisa porque você não entendeu.
- Você receber um comprovante/imagem que não conseguiu ler direito.
- Qualquer coisa sair do fluxo normal de "montar pedido e fechar".

Na dúvida entre arriscar e chamar: CHAME. Errar chamando atendente à toa custa barato; errar chutando custa um cliente. Depois de chamar, mande UMA frase curta avisando que um atendente vai assumir em instantes — e pare. Não continue o pedido, não faça perguntas, não tente resolver.

## REGRAS CRÍTICAS (NUNCA quebrar)
⛔ NUNCA escreva "frete incluso" ou "entrega grátis". A taxa de entrega é sempre à parte.
⛔ NUNCA pergunte algo que já está no ESTADO ATUAL DO PEDIDO.
⛔ NUNCA diga que o pedido foi confirmado/registrado por conta própria — quem confirma é o SISTEMA depois que o cliente responde SIM.
⛔ Se um item não existir no cardápio (a tool avisa em "itens_nao_encontrados"), peça pro cliente escolher um nome válido. Não substitua por outro parecido por conta própria.
⛔ Se a loja estiver fechada (info_restaurante → loja_aberta:false), informe o horário e não monte pedido.
⛔ ATENÇÃO LITERAL a tamanho e quantidade: pequena ≠ média ≠ grande, 1 ≠ 2. Use EXATAMENTE o que o cliente falou nesta mensagem. Na menor dúvida, pergunte — nunca chute nem "arredonde".
⛔ Cada pedido é INDEPENDENTE. Monte os itens SÓ com o que o cliente pediu NESTA conversa. IGNORE completamente itens de pedidos anteriores já finalizados que apareçam no histórico.
⛔ Áudio chega transcrito como "🎙️ [Áudio]: ...". Trate como se o cliente tivesse digitado. Se a transcrição vier truncada, sem sentido ou ambígua sobre item/quantidade/tamanho, NÃO adivinhe: confirme em texto o que você entendeu antes de salvar.
⛔ Imagem chega descrita como "📎 [Imagem]: ...". Se for comprovante de pagamento, o sistema já trata sozinho — você não precisa fazer nada além de responder com naturalidade.

## COMUNICAÇÃO
Escreva para uma pessoa com fome, no celular, provavelmente no intervalo do trabalho. Uma ideia por mensagem. Frases curtas e completas. Sem jargão, sem repetir o que ela acabou de dizer, sem encher de confirmação ("Perfeito! Ótima escolha! Maravilha!"). Vá direto ao ponto com simpatia.
Não invente promessas de prazo, entrega ou disponibilidade que nenhuma tool te deu.`;

// ─── CONTEXTO DINÂMICO ────────────────────────────────────────────────────────
// Vai como mensagem `system` no FIM do histórico (recurso do Opus 5): mantém o
// prompt estático acima intacto no cache e ainda assim entrega o estado com
// autoridade de sistema — o modelo não confunde com texto do cliente.

function montarContextoDinamico(rascunho, ofertaAtiva) {
  const partes = [];

  if (rascunho) {
    const av = avaliarRascunho(rascunho);
    const itens = parseItens(rascunho.itens);
    const linhas = [
      itens.length             && `- Itens: ${itens.map(i => `${i.quantidade}x ${i.nome}${i.observacao ? ` (${i.observacao})` : ''}`).join(', ')}`,
      rascunho.nome_cliente    && `- Nome: ${rascunho.nome_cliente}`,
      rascunho.tipo_entrega    && `- Entrega: ${rascunho.tipo_entrega}`,
      rascunho.endereco        && `- Endereço: ${rascunho.endereco}`,
      rascunho.forma_pagamento && `- Pagamento: ${rotuloPagamento(rascunho.forma_pagamento)}`,
    ].filter(Boolean);

    partes.push(`## ESTADO ATUAL DO PEDIDO (já coletado — NÃO pergunte de novo)\n${linhas.join('\n') || '- (vazio)'}`);

    if (av.completo) {
      partes.push('✅ TUDO COLETADO. Se você ainda não recebeu o RESUMO_FINAL_TEXTO_EXATO nesta rodada, chame salvar_dados_pedido (pode ser sem nenhum campo) para recebê-lo, e responda com ele copiado. NÃO monte o resumo por conta própria.');
    } else {
      partes.push(`⏳ AINDA FALTA: ${descreverFaltando(av.faltando)}. Pergunte isso de forma natural.`);
    }
  }

  partes.push(`## TAXA DE ENTREGA\nA taxa de entrega é ${fmtBRL(TAXA_ENTREGA)}, valor único e fixo para qualquer endereço. Só se aplica a delivery (retirada não paga taxa). Nunca cite outro valor, nunca calcule por distância, nunca ofereça isenção.`);

  if (ofertaAtiva && ofertaAtiva.tipo === 'brinde') {
    const permitidos = ofertaAtiva.itens_permitidos || [];
    const listaPermitidos = permitidos.length
      ? `\n- Os ÚNICOS itens que podem sair como cortesia são: ${permitidos.map(p => `*${p}*`).join(' e ')}. Use esses nomes EXATOS em itens_brinde. O sistema recusa qualquer outro item, então oferecer coisa diferente cria uma promessa que não vai ser cumprida.`
      : '';

    partes.push(`## 🎁 BRINDE DE PRIMEIRA COMPRA ATIVO PRA ESTE CLIENTE
Este cliente recebeu uma oferta com o cupom *${ofertaAtiva.codigo}*, válido até ${ofertaAtiva.valido_ate}.
O que ele ganhou: *${ofertaAtiva.descricao || 'brinde de primeira compra'}*.
- Esse cupom NÃO é desconto em dinheiro. O benefício são os itens de cortesia acima. NUNCA fale em porcentagem de desconto pra ele.${listaPermitidos}
- Confirme com ele que quer o brinde e chame salvar_dados_pedido com o campo *itens_brinde*. O sistema zera o preço desses itens sozinho.
- NUNCA ofereça outro tamanho, outra marca ou outro item como brinde, mesmo que o cliente peça. Se ele quiser algo diferente, explique com gentileza que a cortesia é essa e que o resto ele pode adicionar normalmente.
- Não troque o brinde por desconto.
- Mencione a cortesia de forma leve e natural, sem parecer script de vendas.`);
  } else if (ofertaAtiva) {
    partes.push(`## 🎁 OFERTA DE RECOMPRA ATIVA PRA ESTE CLIENTE
Este cliente recebeu uma mensagem de recompra com o cupom *${ofertaAtiva.codigo}* (${ofertaAtiva.desconto_percentual}% de desconto, válido até ${ofertaAtiva.valido_ate}).
- O SISTEMA já sabe desse cupom e aplica o desconto AUTOMATICAMENTE no fechamento — você NÃO precisa perguntar se ele quer usar, nem pedir o código, nem confirmar isso.
- Pode mencionar de forma leve que o desconto já está garantido, sem repetir a cada mensagem.
- NUNCA invente um valor de desconto diferente do informado aqui, e nunca calcule o desconto você mesmo — o valor aparece pronto no resumo.`);
  }

  return partes.join('\n\n');
}

// ─── CHAMADA AO MODELO ────────────────────────────────────────────────────────
// Mensagem `system` no meio de messages[] é suportada pelo Opus 5, mas se a
// conta estiver num modelo que não aceita, a API devolve 400. Em vez de
// derrubar o atendimento, cai automaticamente para o modo compatível (estado
// junto do system estático) e nunca mais tenta o formato novo neste processo.
let suportaSystemNoHistorico = true;

async function chamarModelo(client, { systemEstatico, contexto, messages }) {
  const base = {
    model: MODEL_AGENTE,
    max_tokens: MAX_TOKENS_AGENTE,
    tools: TOOLS,
    // Uma tool por vez: o rascunho é lido e reescrito a cada chamada, então
    // duas tools em paralelo poderiam se atropelar no mesmo estado.
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT_AGENTE },
  };

  if (suportaSystemNoHistorico) {
    try {
      return await client.messages.create({
        ...base,
        system: [{ type: 'text', text: systemEstatico, cache_control: { type: 'ephemeral' } }],
        messages: [...messages, { role: 'system', content: contexto }],
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/role .?system.?|system.*not supported|unexpected role/i.test(msg)) throw err;
      suportaSystemNoHistorico = false;
      logger.warn('agente/system-inline-indisponivel', 'Modelo não aceita system no histórico, usando modo compatível', { erro: msg });
    }
  }

  return client.messages.create({
    ...base,
    system: [
      { type: 'text', text: systemEstatico, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contexto },
    ],
    messages,
  });
}

function extrairTexto(resposta) {
  return (resposta.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// ─── LOOP PRINCIPAL DO AGENTE ─────────────────────────────────────────────────

async function rodarAgente(mensagemUsuario, historico, rascunho, requestId, telefone, ofertaAtiva) {
  const client = getClient();

  // A API exige que messages[0] seja 'user'. Histórico que comece com
  // assistant (oferta enviada pelo agente de recompra antes de qualquer
  // mensagem do cliente) daria 400 — descarta esse prefixo.
  const anteriores = (historico || []).map(h => ({ role: h.role, content: h.content }));
  while (anteriores.length && anteriores[0].role !== 'user') anteriores.shift();

  const messages = [...anteriores, { role: 'user', content: mensagemUsuario }];

  const contexto = montarContextoDinamico(rascunho, ofertaAtiva);

  logger.step(requestId, telefone, 'agente/chamando-claude', {
    model: MODEL_AGENTE,
    effort: EFFORT_AGENTE,
    historico_msgs: historico.length,
    etapa: rascunho?.etapa_atual || 'inicio',
  });

  let resposta = await comRetry(
    () => chamarModelo(client, { systemEstatico: SYSTEM_ESTATICO, contexto, messages }),
    { tentativas: 3, requestId, etapa: 'claude/create' }
  );

  let iteracoes = 0;
  let atendenteChamado = false;

  while (resposta.stop_reason === 'tool_use' && iteracoes < MAX_ITER) {
    iteracoes++;
    // Devolve os blocos do assistant intactos (inclusive os de raciocínio):
    // editar ou remover qualquer um deles invalida a continuação do turno.
    messages.push({ role: 'assistant', content: resposta.content });

    const toolResults = [];
    for (const bloco of resposta.content) {
      if (bloco.type !== 'tool_use') continue;

      const nomeTool = bloco.name;
      const args = bloco.input || {};
      logger.step(requestId, telefone, `tool/${nomeTool}`, { args });

      let resultado;
      let erro = false;
      try {
        resultado = await executarTool(nomeTool, args, { telefone, ofertaAtiva });
        if (nomeTool === 'chamar_atendente') atendenteChamado = true;
        logger.info(`tool/${nomeTool}/ok`, 'Executada', { requestId, telefone });
      } catch (e) {
        erro = true;
        resultado = `ERRO em ${nomeTool}: ${e.message}. Não invente o resultado. Se não conseguir seguir sem essa informação, chame chamar_atendente.`;
        logger.error(`tool/${nomeTool}/erro`, e.message, { requestId, telefone, stack: e.stack });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: bloco.id,
        content: String(resultado),
        ...(erro ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    resposta = await comRetry(
      () => chamarModelo(client, { systemEstatico: SYSTEM_ESTATICO, contexto, messages }),
      { tentativas: 3, requestId, etapa: 'claude/create-loop' }
    );
  }

  // Recusa do modelo por política de segurança: nunca acontece num atendimento
  // de marmitaria, mas se acontecer não dá pra responder qualquer coisa —
  // vira caso de atendente humano.
  if (resposta.stop_reason === 'refusal') {
    logger.warn('agente/recusa', 'Modelo recusou a requisição', { requestId, telefone });
    const err = new Error('Modelo recusou responder.');
    err.precisaAtendente = 'modelo recusou responder a mensagem do cliente';
    throw err;
  }

  if (iteracoes >= MAX_ITER) {
    logger.warn('agente/max-iter', 'Limite de iterações atingido', { requestId, telefone });
    const err = new Error('Limite de iterações do agente atingido.');
    err.precisaAtendente = 'o agente ficou preso em um laço de ferramentas e não conseguiu concluir';
    throw err;
  }

  const textoFinal = extrairTexto(resposta);
  logger.step(requestId, telefone, 'agente/ok', {
    iteracoes,
    stop_reason: resposta.stop_reason,
    resposta_len: textoFinal.length,
    tokens_in: resposta.usage?.input_tokens,
    tokens_cache_read: resposta.usage?.cache_read_input_tokens,
    tokens_out: resposta.usage?.output_tokens,
  });

  return { texto: textoFinal, atendenteChamado };
}

// ─── CONFIRMAR PEDIDO (acionado pelo SIM do cliente, no código) ──────────────
// Cria o pedido diretamente. Trava anti-duplicação ATÔMICA: o UPDATE...WHERE
// só deixa UMA chamada concorrente passar de aguardando_confirmacao pra
// processando (duas mensagens "sim" quase simultâneas não criam 2 pedidos).

async function confirmarPedido(rascunho, telefone, requestId, ofertaAtiva) {
  // Revalidação defensiva — só confirma se realmente está completo
  const av = avaliarRascunho(rascunho);
  if (!av.completo) {
    const erro = new Error(`Rascunho incompleto: falta ${descreverFaltando(av.faltando)}`);
    erro.faltando = av.faltando;
    throw erro;
  }

  const travou = await tentarIniciarConfirmacao(telefone);
  if (!travou) {
    const erro = new Error('Confirmação já em processamento por outra mensagem concorrente.');
    erro.jaProcessando = true;
    throw erro;
  }

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
        itensBrinde:    rascunho.itens_brinde,
        cupom:          ofertaAtiva || null,
      }),
      { tentativas: 2, requestId, etapa: 'confirmarPedido' }
    );
  } catch (err) {
    // Reverte para permitir nova tentativa do cliente
    await salvarRascunho(telefone, { etapa_atual: 'aguardando_confirmacao' });
    throw err;
  }

  if (resultado.formaPagamento === 'pix') {
    // Mantém o rascunho aguardando comprovante, mas zera o brinde: o cupom já
    // foi baixado neste pedido e um itens_brinde sobrando seria dado de novo
    // caso o cliente emende outro pedido na mesma conversa.
    await salvarRascunho(telefone, { etapa_atual: 'aguardando_pix', itens_brinde: JSON.stringify([]) });
  } else {
    // Pedido fechado — limpa o rascunho para a próxima conversa começar zerada
    await limparRascunho(telefone);
  }

  logger.info('pedido/criado', 'Pedido registrado via SIM', {
    requestId, telefone,
    numero_pedido: resultado.numeroPedido,
    total: resultado.total,
    taxa_entrega: resultado.taxaEntrega,
    forma: resultado.formaPagamento,
    cupom_aplicado: resultado.cupomAplicado || null,
    desconto: resultado.desconto || 0,
  });

  return resultado;
}

// ─── FOLLOW-UP (cliente ficou em silêncio) ────────────────────────────────────
// Gera UMA mensagem curta e natural de retomada. Sem "tools" no payload:
// essa chamada não tem como disparar nenhuma tool, é só texto — garante que
// o follow-up nunca mexe em estado (não salva dados, não cria pedido).

async function gerarFollowup(historico, rascunho, requestId, telefone) {
  const client = getClient();

  // A API exige messages não-vazio começando por 'user'. Um histórico que
  // comece com assistant (ex.: primeira mensagem foi uma oferta enviada pelo
  // agente de recompra) derrubaria a chamada com 400.
  const msgs = (historico || []).map(h => ({ role: h.role, content: h.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) msgs.push({ role: 'user', content: '(cliente ficou em silêncio)' });

  const resposta = await comRetry(
    () => client.messages.create({
      model: MODEL_AGENTE,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: SYSTEM_ESTATICO, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: montarContextoDinamico(rascunho, null) },
        {
          type: 'text',
          text: 'TAREFA AGORA: o cliente ficou em silêncio há alguns minutos no meio desta conversa. Escreva UMA mensagem curta (no máximo 2 frases), calorosa e natural, retomando de onde parou — sem inventar informação nova, sem repetir o cardápio inteiro, sem citar valores, sem soar como cobrança. Se já tinha itens escolhidos, convide gentilmente a fechar o pedido. Responda só com o texto da mensagem, nada mais.',
        },
      ],
      messages: msgs,
    }),
    { tentativas: 2, requestId, etapa: 'claude/followup' }
  );

  const texto = extrairTexto(resposta);
  logger.step(requestId, telefone, 'followup/gerado', { chars: texto.length });
  return texto;
}

module.exports = { rodarAgente, confirmarPedido, gerarFollowup, SYSTEM_ESTATICO, montarContextoDinamico };
