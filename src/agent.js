'use strict';

const OpenAI = require('openai');
const { TOOLS, executarTool } = require('./tools');
const { salvarRascunho, limparRascunho, criarPedidoCompleto, tentarIniciarConfirmacao } = require('./services/supabase');
const { avaliarRascunho, descreverFaltando, parseItens, rotuloPagamento } = require('./utils/pedido');
const { comRetry } = require('./utils/retry');
const {
  MODEL_AGENTE, EFFORT_AGENTE, EFFORT_FOLLOWUP, MAX_TOKENS_AGENTE,
  TAXA_ENTREGA, FRETE_GRATIS_ACIMA_DE, prazoOfertaTexto, TEXTO_HORARIO, fmtBRL,
} = require('./config');
const logger = require('./logger');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const MAX_ITER = 8;

// Tools cujo uso significa "o cliente quer ver o cardápio" — quando alguma
// delas roda, o sistema manda o vídeo do buffet de hoje junto da resposta.
const TOOLS_DE_CARDAPIO = new Set(['buscar_cardapio', 'buscar_itens_do_dia']);

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

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
Você não é um tirador de pedidos: você é o atendente que faz a pessoa querer pedir. Cada mensagem sua tem que empurrar a conversa um passo adiante.

## COMO VENDER (isto define se o cliente fecha ou some)

### 1. Preço nunca anda sozinho
Preço solto é objeção pronta. Todo valor que você citar vem colado no que a pessoa ganha e no que ela faz em seguida.

❌ "A média sai R$ 21,00."
✅ "A Média sai *R$ 21* já com 2 carnes e 6 acompanhamentos. Fechando 2, o pedido passa de R$ 40 e *a entrega sai de graça*. Prefere 2 Médias ou 1 Média e 1 Grande?"

A estrutura é sempre a mesma: *preço → o que vem junto → o ganho → pergunta de escolha*.

### 2. Frete grátis é sua melhor arma
Entrega custa R$ 11, mas é GRÁTIS acima de R$ 40. Nunca cite os R$ 11 sozinhos — quem ouve só "R$ 11 de entrega" desiste; quem ouve "faltam R$ 8 e a entrega sai de graça" aumenta o pedido.
Quando o retorno de salvar_dados_pedido trouxer FALTA_PARA_FRETE_GRATIS, ofereça *UM item específico* que feche essa diferença, com preço colado. Um item só, escolhido por você — não uma lista pro cliente escolher.
Quando trouxer FRETE_GRATIS_CONQUISTADO, avise que ele ganhou a entrega. Benefício que o cliente não percebe não converte.

### 3. Termine SEMPRE com pergunta de escolha fechada
Toda mensagem sua acaba com uma pergunta que não dá pra responder "sim" ou "não". Duas opções concretas, ambas levando ao pedido.

❌ "Quer mais alguma coisa?" · "Posso ajudar em algo mais?" · "Ficou bom assim?"
✅ "Prefere a Média ou a Grande?" · "Mando pra hoje ou amanhã?" · "Pra entrega ou retirada?" · "Coca ou Guaraná pra acompanhar?"

A conversa morre quando você entrega a bola e não pede nada de volta. A ÚNICA exceção é o RESUMO_FINAL_TEXTO_EXATO, que já termina pedindo o *SIM* — nesse caso não acrescente nada.

### 4. Prazo, quando for verdade
Condição de primeira compra tem prazo, e prazo faz decidir agora. Sem prazo, "depois eu peço" é a resposta automática — e depois nunca chega.
Use o prazo informado no contexto desta conversa. Nunca invente prazo, nunca invente promoção.

### 5. Ritmo
Uma pergunta por mensagem. Cliente com fome no celular não responde questionário. Se faltam 3 informações, pergunte a mais fácil primeiro e vá levando.
Nunca peça pro cliente "dar uma olhada no cardápio e me avisar" — isso é entregar a bola. Sugira você, com nome e preço.

⛔ LIMITE ABSOLUTO: você pode oferecer *frete grátis* (regra do sistema) e o *brinde do cupom*, quando o contexto disser que existe. NADA MAIS é de graça. Nunca invente desconto, item de cortesia, combo ou promoção que não esteja escrito neste contexto. Prometer o que o sistema não cumpre é pior que perder a venda: o cliente chega na porta cobrando.

## FLUXO DE ATENDIMENTO (conduza ativamente)
1. Saudação calorosa + pergunte o que a pessoa deseja hoje.
2. Para mostrar itens/preços: chame buscar_cardapio ANTES. Para marmitex: chame TAMBÉM buscar_itens_do_dia — ela informa o limite (até 2 carnes, até 6 acompanhamentos); sempre repasse esse limite.
   O SISTEMA envia sozinho o vídeo do buffet de hoje quando você usa essas tools. Não prometa vídeo, não descreva o vídeo, não diga "vou te mandar um vídeo" — ele já vai junto.
3. Assim que o cliente escolher um item, chame salvar_dados_pedido (NOMES EXATOS do cardápio) e depois CONFIRME de volta o item e o preço que o retorno da tool trouxe, já emendando na próxima escolha — ex: "Anotei: 1x Marmitex Pequena — R$ 23,00 ✅ Coca ou Guaraná pra acompanhar?". Só avance depois desse eco: ele existe pra pegar item errado antes de virar pedido, e a pergunta no fim é o que mantém a conversa viva.
4. Se o item for MARMITEX: pergunte quais carnes (até 2) e acompanhamentos (até 6), usando os nomes exatos de buscar_itens_do_dia, e mande no MESMO item via os campos "carnes" e "acompanhamentos". O sistema aplica o limite de verdade — se o retorno trouxer "AVISOS" dizendo que cortou algo, explique com gentileza e pergunte se as opções mantidas estão OK.
5. O campo "itens" de salvar_dados_pedido é a lista COMPLETA e substitui a anterior inteira. Para adicionar um item, reenvie todos os itens (os antigos + o novo). Nunca mande só o item novo achando que ele será somado.
6. Pergunte: entrega (delivery) ou retirada? → se delivery, peça o endereço completo. Se o cliente mandar localização (aparece como "📍 [Localização compartilhada]: ... link do Google Maps"), isso É endereço válido — salve o link inteiro no campo endereco, não peça pra digitar de novo.
7. Pergunte a forma de pagamento: PIX, dinheiro ou cartão.
8. 💵 SE FOR DINHEIRO, é OBRIGATÓRIO perguntar em seguida: "Precisa de troco pra quanto?" — em uma mensagem curta e natural. É a diferença entre o entregador sair com troco ou o cliente ficar sem receber.
   - Se ele disser um valor ("100", "pra 50", "cinquenta reais"), salve em troco_para.
   - Se ele disser que tem o valor certo / não precisa de troco ("é certinho", "não precisa", "tenho trocado"), salve troco_para com o valor 0.
   - Só siga para o resumo depois que essa pergunta estiver respondida. Nunca invente o valor do troco, nunca calcule quanto é o troco — quem calcula é o sistema.
9. SEMPRE que coletar algo, chame salvar_dados_pedido. O retorno diz o que ainda falta.
10. Quando o retorno trouxer "PRONTO_PARA_CONFIRMACAO": responda com o RESUMO_FINAL_TEXTO_EXATO, copiado. Nada além disso.
11. Depois do pedido confirmado (PIX): o sistema envia a chave. Quando chegar "📎 COMPROVANTE PIX CONFIRMADO", agradeça — o sistema já cuidou do status.

## ÁUDIO
Áudio chega transcrito como "🎙️ [Áudio]: ...". Trate como se o cliente tivesse digitado.
Se a transcrição vier truncada, sem sentido, ou ambígua sobre item/quantidade/tamanho:
- NÃO adivinhe e NÃO salve nada.
- Peça, com leveza, que ele mande por escrito o que quer — em UMA frase curta. Ex: "Não consegui escutar direito 😅 Me manda por escrito o que você quer?"
- Se o cliente insistir no áudio e você continuar sem entender, chame chamar_atendente.

## QUANDO CHAMAR O ATENDENTE HUMANO (tool chamar_atendente)
Chame SEMPRE que:
- Você não souber responder algo com certeza, ou tiver qualquer dúvida real sobre o que fazer.
- O cliente reclamar de algo que você não resolve (pedido anterior errado, demora, produto com problema).
- O cliente pedir alteração ou cancelamento de pedido JÁ confirmado.
- O cliente pedir desconto, negociar preço, pedir nota fiscal, ou perguntar de pagamento fora do padrão.
- O cliente perguntar algo sobre o restaurante que nenhuma tool responde.
- O cliente parecer irritado, confuso, ou repetir a mesma coisa porque você não entendeu.
- Você não conseguir entender o que o cliente quer nem por áudio nem por escrito.
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
⛔ Imagem chega descrita como "📎 [Imagem]: ...". Se for comprovante de pagamento, o sistema já trata sozinho — você não precisa fazer nada além de responder com naturalidade.

## COMUNICAÇÃO
Escreva para uma pessoa com fome, no celular, provavelmente no intervalo do trabalho. Uma ideia por mensagem. Frases curtas e completas. Sem jargão, sem repetir o que ela acabou de dizer, sem encher de confirmação ("Perfeito! Ótima escolha! Maravilha!"). Vá direto ao ponto com simpatia.
Não invente promessas de prazo, entrega ou disponibilidade que nenhuma tool te deu.`;

// ─── CONTEXTO DINÂMICO ────────────────────────────────────────────────────────
// Estado do pedido + regras que mudam por conversa. Vai como uma segunda
// mensagem de sistema, logo antes da fala do cliente.

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
      rascunho.troco_para != null && `- Troco para: ${Number(rascunho.troco_para) === 0 ? 'não precisa (valor certo)' : fmtBRL(rascunho.troco_para)}`,
    ].filter(Boolean);

    partes.push(`## ESTADO ATUAL DO PEDIDO (já coletado — NÃO pergunte de novo)\n${linhas.join('\n') || '- (vazio)'}`);

    if (av.completo) {
      partes.push('✅ TUDO COLETADO. Se você ainda não recebeu o RESUMO_FINAL_TEXTO_EXATO nesta rodada, chame salvar_dados_pedido (pode ser sem nenhum campo) para recebê-lo, e responda com ele copiado. NÃO monte o resumo por conta própria.');
    } else {
      partes.push(`⏳ AINDA FALTA: ${descreverFaltando(av.faltando)}. Pergunte isso de forma natural, uma coisa de cada vez.`);
    }
  }

  partes.push(`## ENTREGA E FRETE GRÁTIS
- A entrega custa ${fmtBRL(TAXA_ENTREGA)} — valor único e fixo, para qualquer endereço. Só em delivery (retirada não paga).
- 🎉 ACIMA DE ${fmtBRL(FRETE_GRATIS_ACIMA_DE)} A ENTREGA É GRÁTIS. O sistema aplica sozinho, você não precisa fazer nada além de usar isso como argumento.
- Nunca cite os ${fmtBRL(TAXA_ENTREGA)} sozinhos. Sempre junto: "a entrega é ${fmtBRL(TAXA_ENTREGA)}, mas acima de ${fmtBRL(FRETE_GRATIS_ACIMA_DE)} sai de graça".
- Nunca calcule frete por distância, nunca ofereça isenção fora desta regra, nunca prometa frete grátis abaixo de ${fmtBRL(FRETE_GRATIS_ACIMA_DE)}.

## PRAZO DA CONDIÇÃO
A condição de primeira compra vale ${prazoOfertaTexto()}. Use isso para o cliente decidir agora, sem inventar outro prazo.

## HORÁRIO
Atendemos ${TEXTO_HORARIO}. Se você está conversando agora, é porque está DENTRO do horário — pode montar o pedido normalmente. Fora do horário o sistema responde sozinho, você nem é chamado.
Se o cliente perguntar o horário, informe exatamente: ${TEXTO_HORARIO}.
Se ele pedir pra agendar para outro dia ou fora do horário, chame chamar_atendente — agendamento não é decisão sua.`);

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
// Rede de segurança de implantação: se a conta ainda não tiver acesso ao
// modelo configurado (ou se o parâmetro reasoning_effort for recusado), o
// agente cai para um modelo antigo e SEGUE ATENDENDO, em vez de derrubar o
// restaurante inteiro no meio do almoço. A troca acontece uma vez por
// processo e fica gritando no log até alguém arrumar.
//
// O que NÃO muda no fallback: toda a exatidão de preço, taxa, total e troco,
// que é código e não depende de modelo nenhum.
const MODELO_RESERVA = process.env.OPENAI_MODEL_RESERVA || 'gpt-4o';
let modeloAtivo = MODEL_AGENTE;

// Dois ajustes INDEPENDENTES. Amarrar os dois foi um erro que quebrou a
// produção: um 400 em `reasoning_effort` fazia o código trocar
// `max_completion_tokens` por `max_tokens`, e aí o GPT-5.6 recusava a chamada
// seguinte ("'max_tokens' is not supported with this model").
//   - efeitoAtual / effortDesligado: VALOR do reasoning_effort, e se ele vai
//     ou não no payload. São coisas diferentes: no gpt-5.6-terra, mandar
//     `reasoning_effort: 'none'` FUNCIONA com tools, mas OMITIR o parâmetro
//     não — sem ele o modelo usa o raciocínio padrão e recusa as tools do
//     mesmo jeito. Foi por isso que o segundo erro em produção insistiu.
//   - tokensLegado: usa `max_tokens` (modelo antigo) em vez de
//     `max_completion_tokens` (família 5.x / o-series)
let efeitoAtual = EFFORT_AGENTE;
let effortDesligado = false;
let tokensLegado = !usaApiNova(MODEL_AGENTE);

// A família 5.x e os modelos "o" usam max_completion_tokens e aceitam
// reasoning_effort. Detectar pelo nome evita descobrir isso por tentativa e
// erro em cima do cliente.
function usaApiNova(modelo) {
  return /^(gpt-5|o[1-9])/i.test(String(modelo || ''));
}

function erroDeModeloIndisponivel(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = err?.code || err?.error?.code || '';
  return err?.status === 404
    || code === 'model_not_found'
    || /does not exist|do not have access|unsupported model|unknown model/.test(msg);
}

// 400 reclamando de reasoning_effort → só tira o effort, mantém o resto.
function erroDeEffort(err) {
  const msg = String(err?.message || '').toLowerCase();
  return err?.status === 400 && msg.includes('reasoning_effort');
}

// 400 reclamando do parâmetro de tokens → troca o NOME do parâmetro, nos dois
// sentidos: modelo novo pedindo max_completion_tokens, ou antigo pedindo
// max_tokens.
function erroDeTokens(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.status !== 400) return null;
  if (msg.includes("'max_tokens'") && msg.includes('max_completion_tokens')) return 'novo';
  if (msg.includes("'max_completion_tokens'")) return 'legado';
  return null;
}

// O caso específico do gpt-5.6-terra no /v1/chat/completions:
//   "Function tools with reasoning_effort are not supported ... set
//    reasoning_effort to 'none'"
// A saída é mandar 'none' EXPLÍCITO — omitir não resolve, porque o padrão do
// modelo é raciocinar e aí ele recusa as tools de novo.
function erroDeToolsComEffort(err) {
  const msg = String(err?.message || '').toLowerCase();
  return err?.status === 400
    && msg.includes('reasoning_effort')
    && /function tools|tools are not supported|tools with reasoning/.test(msg);
}

function montarPayload(messages) {
  const payload = {
    model: modeloAtivo,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    // Uma tool por vez: o rascunho é lido e reescrito a cada chamada, então
    // duas tools em paralelo poderiam se atropelar no mesmo estado.
    parallel_tool_calls: false,
  };
  if (tokensLegado) payload.max_tokens = MAX_TOKENS_AGENTE;
  else payload.max_completion_tokens = MAX_TOKENS_AGENTE;
  if (!effortDesligado && !tokensLegado) payload.reasoning_effort = efeitoAtual;
  return payload;
}

// Tenta, corrige o que a API reclamar e tenta de novo. Limite de tentativas
// pra nunca virar laço infinito em cima de um erro que não é de parâmetro.
async function chamarModelo(client, messages) {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      return await client.chat.completions.create(montarPayload(messages));
    } catch (err) {
      const tipoTokens = erroDeTokens(err);

      // Precisa vir ANTES do tratamento genérico de effort: aqui a correção é
      // mandar 'none', não parar de mandar o parâmetro.
      if (erroDeToolsComEffort(err)) {
        if (efeitoAtual !== 'none') {
          logger.error('agente/tools-com-effort',
            `"${modeloAtivo}" não aceita tools com reasoning_effort="${efeitoAtual}" — mudando para 'none'.`,
            { erro: err.message });
          efeitoAtual = 'none';
          continue;
        }
        if (!effortDesligado) {
          logger.error('agente/tools-com-effort',
            `"${modeloAtivo}" recusou tools até com reasoning_effort='none' — removendo o parâmetro.`,
            { erro: err.message });
          effortDesligado = true;
          continue;
        }
      }

      if (erroDeModeloIndisponivel(err) && modeloAtivo !== MODELO_RESERVA) {
        logger.error('agente/modelo-indisponivel',
          `Sem acesso a "${modeloAtivo}" — caindo para "${MODELO_RESERVA}". Confira o plano da conta OpenAI.`,
          { erro: err.message });
        modeloAtivo = MODELO_RESERVA;
        tokensLegado = !usaApiNova(MODELO_RESERVA);
        effortDesligado = !usaApiNova(MODELO_RESERVA);
        efeitoAtual = EFFORT_AGENTE;
        continue;
      }

      if (tipoTokens === 'novo' && tokensLegado) {
        logger.error('agente/tokens-param', `"${modeloAtivo}" exige max_completion_tokens — corrigindo.`, { erro: err.message });
        tokensLegado = false;
        continue;
      }
      if (tipoTokens === 'legado' && !tokensLegado) {
        logger.error('agente/tokens-param', `"${modeloAtivo}" exige max_tokens — corrigindo.`, { erro: err.message });
        tokensLegado = true;
        effortDesligado = true; // quem usa max_tokens não conhece reasoning_effort
        continue;
      }

      if (erroDeEffort(err) && !effortDesligado) {
        logger.error('agente/effort-recusado',
          `"${modeloAtivo}" recusou reasoning_effort="${efeitoAtual}" — repetindo sem ele.`,
          { erro: err.message });
        effortDesligado = true;
        continue;
      }

      throw err;
    }
  }
  throw new Error('Não consegui ajustar os parâmetros da chamada ao modelo.');
}

// Chamada sem tools (follow-up). Mesma correção de parâmetros do agente.
async function chamarModeloSimples(client, maxTokens, messages) {
  const monta = () => {
    const p = { model: modeloAtivo, messages };
    if (tokensLegado) p.max_tokens = maxTokens;
    else p.max_completion_tokens = maxTokens;
    if (!effortDesligado && !tokensLegado) p.reasoning_effort = EFFORT_FOLLOWUP;
    return p;
  };

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      return await client.chat.completions.create(monta());
    } catch (err) {
      const tipoTokens = erroDeTokens(err);

      if (erroDeModeloIndisponivel(err) && modeloAtivo !== MODELO_RESERVA) {
        modeloAtivo = MODELO_RESERVA;
        tokensLegado = !usaApiNova(MODELO_RESERVA);
        effortDesligado = !usaApiNova(MODELO_RESERVA);
        efeitoAtual = EFFORT_AGENTE;
        continue;
      }
      if (tipoTokens === 'novo' && tokensLegado) { tokensLegado = false; continue; }
      if (tipoTokens === 'legado' && !tokensLegado) { tokensLegado = true; effortDesligado = true; continue; }
      if (erroDeEffort(err) && !effortDesligado) { effortDesligado = true; continue; }
      throw err;
    }
  }
  throw new Error('Não consegui ajustar os parâmetros da chamada ao modelo.');
}

// Exposto no /health pra dar pra ver, de fora, se o fallback entrou em ação.
function modeloEmUso() {
  return {
    configurado: MODEL_AGENTE, em_uso: modeloAtivo,
    reasoning_effort: effortDesligado ? '(nao enviado)' : efeitoAtual,
    param_tokens: tokensLegado ? 'max_tokens' : 'max_completion_tokens',
  };
}

// ─── LOOP PRINCIPAL DO AGENTE ─────────────────────────────────────────────────

async function rodarAgente(mensagemUsuario, historico, rascunho, requestId, telefone, ofertaAtiva) {
  const client = getClient();

  // A API exige que a conversa comece com system/user. Histórico que comece
  // com assistant (oferta enviada pelo agente de recompra antes de qualquer
  // mensagem do cliente) confunde o modelo — descarta esse prefixo.
  const anteriores = (historico || []).map(h => ({ role: h.role, content: h.content }));
  while (anteriores.length && anteriores[0].role !== 'user') anteriores.shift();

  const messages = [
    { role: 'system', content: SYSTEM_ESTATICO },
    { role: 'system', content: montarContextoDinamico(rascunho, ofertaAtiva) },
    ...anteriores,
    { role: 'user', content: mensagemUsuario },
  ];

  logger.step(requestId, telefone, 'agente/chamando-openai', {
    model: MODEL_AGENTE,
    effort: effortDesligado ? null : efeitoAtual,
    historico_msgs: anteriores.length,
    etapa: rascunho?.etapa_atual || 'inicio',
  });

  let resposta = await comRetry(
    () => chamarModelo(client, messages),
    { tentativas: 3, requestId, etapa: 'openai/create' }
  );

  let iteracoes = 0;
  let atendenteChamado = false;
  let mostrouCardapio = false;

  while (resposta.choices[0].finish_reason === 'tool_calls' && iteracoes < MAX_ITER) {
    iteracoes++;
    const assistantMsg = resposta.choices[0].message;
    messages.push(assistantMsg);

    for (const toolCall of (assistantMsg.tool_calls || [])) {
      const nomeTool = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); }
      catch (e) {
        logger.warn('tool/args-invalidos', `JSON inválido em ${nomeTool}`, { requestId, telefone, raw: toolCall.function.arguments });
      }

      logger.step(requestId, telefone, `tool/${nomeTool}`, { args });

      let resultado;
      try {
        resultado = await executarTool(nomeTool, args, { telefone, ofertaAtiva });
        if (nomeTool === 'chamar_atendente') atendenteChamado = true;
        if (TOOLS_DE_CARDAPIO.has(nomeTool)) mostrouCardapio = true;
        logger.info(`tool/${nomeTool}/ok`, 'Executada', { requestId, telefone });
      } catch (err) {
        resultado = `ERRO em ${nomeTool}: ${err.message}. Não invente o resultado. Se não conseguir seguir sem essa informação, chame chamar_atendente.`;
        logger.error(`tool/${nomeTool}/erro`, err.message, { requestId, telefone, stack: err.stack });
      }

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: String(resultado) });
    }

    resposta = await comRetry(
      () => chamarModelo(client, messages),
      { tentativas: 3, requestId, etapa: 'openai/create-loop' }
    );
  }

  if (iteracoes >= MAX_ITER) {
    logger.warn('agente/max-iter', 'Limite de iterações atingido', { requestId, telefone });
    const err = new Error('Limite de iterações do agente atingido.');
    err.precisaAtendente = 'o agente ficou preso em um laço de ferramentas e não conseguiu concluir';
    throw err;
  }

  const textoFinal = resposta.choices[0].message?.content?.trim() || '';
  logger.step(requestId, telefone, 'agente/ok', {
    iteracoes,
    finish_reason: resposta.choices[0].finish_reason,
    resposta_len: textoFinal.length,
    tokens_in: resposta.usage?.prompt_tokens,
    tokens_out: resposta.usage?.completion_tokens,
  });

  return { texto: textoFinal, atendenteChamado, mostrouCardapio };
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
        trocoPara:      rascunho.troco_para,
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
    troco_para: resultado.trocoPara,
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

  const msgs = (historico || []).map(h => ({ role: h.role, content: h.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) msgs.push({ role: 'user', content: '(cliente ficou em silêncio)' });

  // Usa o mesmo caminho protegido do agente: se o modelo novo não estiver
  // disponível, o follow-up também cai pro reserva em vez de falhar em silêncio
  // dentro do poller.
  const resposta = await comRetry(
    () => chamarModeloSimples(client, 600, [
        { role: 'system', content: SYSTEM_ESTATICO },
        { role: 'system', content: montarContextoDinamico(rascunho, null) },
        ...msgs,
        {
          role: 'system',
          content: 'TAREFA AGORA: o cliente ficou em silêncio há alguns minutos no meio desta conversa. Escreva UMA mensagem curta (no máximo 2 frases), calorosa e natural, retomando de onde parou — sem inventar informação nova, sem repetir o cardápio inteiro, sem citar valores, sem soar como cobrança. Se já tinha itens escolhidos, convide gentilmente a fechar o pedido. Responda só com o texto da mensagem, nada mais.',
        },
      ]),
    { tentativas: 2, requestId, etapa: 'openai/followup' }
  );

  const texto = resposta.choices[0].message?.content?.trim() || '';
  logger.step(requestId, telefone, 'followup/gerado', { chars: texto.length });
  return texto;
}

module.exports = {
  rodarAgente, confirmarPedido, gerarFollowup, modeloEmUso,
  SYSTEM_ESTATICO, montarContextoDinamico,
  // Exposto só para o teste de regressão dos parâmetros do modelo — foi um
  // erro aqui que derrubou o atendimento em produção.
  _testes: {
    chamarModelo, montarPayload,
    // `efeito` permite simular quem configurou OPENAI_EFFORT diferente do
    // padrão — é assim que se reproduz o erro de tools+effort de produção.
    resetar(modelo, efeito) {
      modeloAtivo = modelo || MODEL_AGENTE;
      tokensLegado = !usaApiNova(modeloAtivo);
      efeitoAtual = efeito || EFFORT_AGENTE;
      effortDesligado = !usaApiNova(modeloAtivo);
    },
  },
};
