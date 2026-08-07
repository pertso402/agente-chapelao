'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const { extrairMensagem, downloadMidia, enviarTexto, enviarMidia, manterDigitando, ehEcoDoBot } = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, stamparRascunho, limparRascunho,
  buscarInfo, atualizarStatusPedido, buscarPedidoPendente, buscarVideoBuffet,
  buscarCupomAtivoPorTelefone,
  garantirCliente, verificarPausa, pausarAtendimento, criarAlertaAtendimento,
  reivindicarFollowups, reivindicarTravados,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido, gerarFollowup } = require('./agent');
const { comRetry } = require('./utils/retry');
const { normalizar } = require('./utils/pedido');
const { PAUSA_ATENDENTE_MS, MAX_FALHAS_AUDIO, fmtBRL, money, MODEL_AGENTE } = require('./config');

const app = express();
app.use(express.json({ limit: '10mb' }));

const fmt = fmtBRL;

// ─── RESPOSTA CENTRAL ──────────────────────────────────────────────────────────
// Todo texto que sai do bot passa por aqui: envia, salva no histórico e stampa
// o rastreio de silêncio (ultima_msg_em/role) usado pelo follow-up. Centralizado
// de propósito — evita ter que lembrar de stampar em cada um dos vários pontos
// que respondem ao cliente.
async function responder(telefone, texto, { requestId, etapa }) {
  await comRetry(() => enviarTexto(telefone, texto), { tentativas: 3, requestId, etapa });
  await salvarMensagem(telefone, 'assistant', texto);
  // stamparRascunho (não salvarRascunho): só atualiza se o rascunho já existir.
  // Se o pedido acabou de ser finalizado (limparRascunho apagou a linha
  // segundos atrás), isso NÃO pode recriar um rascunho fantasma — era
  // exatamente isso que fazia o follow-up disparar pra pedido já pronto.
  await stamparRascunho(telefone, {
    ultima_msg_em: new Date().toISOString(),
    ultima_msg_role: 'assistant',
  }).catch(err => logger.warn('rascunho/stamp-assistant-falhou', err.message, { requestId, telefone }));
}

// ─── ESCALONAMENTO PARA ATENDENTE HUMANO ──────────────────────────────────────
// Caminho único para "a IA não dá conta disso": alerta no painel (com som, pro
// atendente ver na hora) + atendimento pausado por 10 minutos + uma mensagem
// honesta pro cliente. Usado tanto pela tool chamar_atendente quanto por
// qualquer falha técnica — erro de banco, modelo fora do ar, comprovante
// ilegível. Antes, uma falha dessas virava "tenta de novo em instantes" e o
// cliente ficava conversando com um agente quebrado, sem ninguém saber.
async function escalarParaAtendente(telefone, motivo, requestId, { mensagemCliente } = {}) {
  try {
    const rascunho = await carregarRascunho(telefone).catch(() => null);
    await criarAlertaAtendimento(telefone, rascunho?.nome_cliente, motivo);
    await pausarAtendimento(telefone, PAUSA_ATENDENTE_MS, motivo);
    logger.warn('atendente/escalado', motivo, { requestId, telefone, pausa_min: PAUSA_ATENDENTE_MS / 60000 });
  } catch (err) {
    // Se nem o alerta consegue ser gravado, ainda assim avisamos o cliente —
    // ficar mudo é o pior desfecho possível.
    logger.error('atendente/escalar-falhou', err.message, { requestId, telefone, stack: err.stack });
  }

  if (mensagemCliente) {
    await responder(telefone, mensagemCliente, { requestId, etapa: 'escalarAtendente' }).catch(() => {});
  }
}

const MSG_ATENDENTE_PADRAO =
  'Opa, deixa eu chamar alguém da equipe pra te ajudar com isso 🙋 Um atendente assume nossa conversa em instantes, tá? 🎩';

// ─── FILA POR TELEFONE ─────────────────────────────────────────────────────────
// Evita que 2+ mensagens do MESMO cliente, chegando rápido uma atrás da outra
// (antes da primeira terminar seu round-trip com o GPT-4o, que leva alguns
// segundos), processem em paralelo e se atropelem escrevendo o rascunho —
// leitura+escrita do estado não é atômica fora do SIM (que já tem trava própria).
// Clientes DIFERENTES continuam 100% em paralelo; só o mesmo telefone é
// serializado, e um erro numa mensagem nunca trava as próximas dessa fila.
const filasPorTelefone = new Map();
function enfileirar(telefone, tarefa) {
  const anterior = filasPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  filasPorTelefone.set(telefone, atual.catch(() => {}));
  return atual;
}

// ─── DEDUPLICAÇÃO DE MENSAGENS ────────────────────────────────────────────────
const msgProcessadas = new Map();
function jaProcessada(msgId) {
  if (!msgId) return false;
  const agora = Date.now();
  for (const [id, ts] of msgProcessadas) {
    if (agora - ts > 120_000) msgProcessadas.delete(id);
  }
  if (msgProcessadas.has(msgId)) return true;
  msgProcessadas.set(msgId, agora);
  return false;
}

// Localização em tempo real manda vários "pings" periódicos enquanto o
// compartilhamento fica ativo — sem isso, cada ping viraria uma nova rodada
// completa do agente (custo de LLM + risco de responder repetido pro cliente).
const ultimaLocalizacao = new Map(); // telefone -> timestamp
const JANELA_LOCALIZACAO_MS = 5 * 60_000;
function pingDeLocalizacaoRepetido(telefone) {
  const agora = Date.now();
  for (const [tel, ts] of ultimaLocalizacao) {
    if (agora - ts > JANELA_LOCALIZACAO_MS) ultimaLocalizacao.delete(tel);
  }
  const ultima = ultimaLocalizacao.get(telefone);
  ultimaLocalizacao.set(telefone, agora);
  return !!ultima && (agora - ultima) < JANELA_LOCALIZACAO_MS;
}

// Confirmações que disparam a criação do pedido.
// Antes isto exigia IGUALDADE EXATA com a frase — "sim, pode confirmar" ou
// "isso mesmo, obrigado" (frases naturais e comuns) NUNCA batiam, deixando
// o pedido travado em aguardando_confirmacao pra sempre (o cliente achava
// que tinha confirmado, mas nada acontecia). Agora aceita a palavra
// afirmativa como INÍCIO da frase, e rejeita explicitamente frases com
// ressalva (deixando "sim, mas troca o refrigerante" cair pro agente).
const CONFIRMACOES_EXATAS = new Set([
  'sim', 'simm', 's', '1', 'confirmar', 'confirma', 'confirmo',
  'pode confirmar', 'pode fechar', 'fechar', 'fechou', 'isso', 'isso mesmo',
  'ta certo', 'certo', 'correto', 'ok', 'okay', 'beleza', 'blz', 'pode ser',
]);
const CONFIRMACOES_PREFIXO = [
  'sim', 'confirmo', 'confirma', 'pode confirmar', 'pode fechar', 'fechar',
  'fechou', 'isso mesmo', 'isso', 'ta certo', 'certo', 'correto', 'beleza', 'pode ser',
];
const RESSALVA = /\b(mas|so que|so quero|quero mudar|muda|troca|corrige|corrigir|errado|espera|pera|calma|antes|na verdade|ainda nao|primeiro)\b/;

function ehConfirmacao(texto) {
  const t = normalizar(String(texto || '')).replace(/[.!,]+$/, '');
  if (!t) return false;
  if (RESSALVA.test(t)) return false;
  if (CONFIRMACOES_EXATAS.has(t)) return true;
  return CONFIRMACOES_PREFIXO.some((p) => t.startsWith(`${p} `) || t.startsWith(`${p},`));
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    agente: 'Chapelão v2',
    modelo: MODEL_AGENTE,
    vars: {
      supa: !!process.env.SUPA_URL,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      evolution: !!process.env.EVOLUTION_URL,
    },
  });
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  const requestId = uuid().slice(0, 8);
  const body = req.body;

  let msg;
  try {
    msg = extrairMensagem(body);
    if (!msg) return;
  } catch (err) {
    logger.error('webhook/extrair', err.message, { requestId, err });
    return;
  }

  const msgId = body?.data?.key?.id;
  if (jaProcessada(msgId)) {
    logger.info('webhook/dedup', 'Mensagem duplicada ignorada', { requestId, msgId });
    return;
  }

  // ── Mensagem própria (fromMe): eco do bot ou atendente humano assumiu? ──────
  if (msg.fromMe) {
    if (ehEcoDoBot(msg.telefone, msg.msgId)) return; // eco da nossa própria resposta, ignora
    try {
      await pausarAtendimento(msg.telefone, PAUSA_ATENDENTE_MS, 'atendente humano respondeu');
      logger.info('pausa/atendente-humano', 'Atendente respondeu, pausando IA conversacional', {
        requestId, telefone: msg.telefone, pausa_min: PAUSA_ATENDENTE_MS / 60000,
      });
    } catch (err) {
      logger.error('pausa/erro', err.message, { requestId, telefone: msg.telefone, stack: err.stack });
    }
    return;
  }

  // Serializa por telefone: mensagens do MESMO cliente chegando rápido uma
  // atrás da outra esperam a anterior terminar antes de ler/escrever o
  // rascunho — evita duas escritas concorrentes se atropelarem. Clientes
  // diferentes continuam processando 100% em paralelo.
  await enfileirar(msg.telefone, () => processarMensagem(msg, requestId));
});

async function processarMensagem(msg, requestId) {
  const { telefone, pushName, tipo, mensagemRaw, base64: base64Inline, mimetype: mimetypeInline } = msg;
  let conteudo = msg.texto;

  logger.step(requestId, telefone, 'webhook/recebido', { tipo, pushName, preview: (conteudo || '').slice(0, 60) });

  try {
    // ── Mídia: áudio ───────────────────────────────────────────────────────
    if (tipo === 'audioMessage') {
      logger.step(requestId, telefone, 'midia/audio');
      try {
        let b64 = base64Inline, mime = mimetypeInline || 'audio/ogg';
        if (!b64) {
          const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadAudio' });
          b64 = m.base64; mime = m.mimetype || 'audio/ogg';
        }
        const transcricao = await comRetry(() => transcreverAudio(b64, mime), { tentativas: 2, requestId, etapa: 'transcricao' });
        conteudo = `🎙️ [Áudio]: ${transcricao}`;
        logger.info('midia/audio/ok', 'Transcrito', { requestId, telefone, chars: transcricao.length });
      } catch (err) {
        // Áudio não entendido. A escada é: 1ª vez pede pra escrever; se
        // acontecer de novo, entrega pra uma pessoa. Adivinhar o que o cliente
        // falou não é opção, e ficar pedindo "repete" pra sempre é pior ainda.
        logger.error('midia/audio/erro', err.message, { requestId, telefone, stack: err.stack });

        const rascunhoAudio = await carregarRascunho(telefone).catch(() => null);
        const falhas = (rascunhoAudio?.audio_falhas || 0) + 1;
        await salvarRascunho(telefone, { audio_falhas: falhas }).catch(() => {});

        if (falhas < MAX_FALHAS_AUDIO) {
          await responder(
            telefone,
            'Opa, não consegui escutar seu áudio direito aqui 😕 Me manda por escrito o que você quer, por favor?',
            { requestId, etapa: 'audioPedirTexto' }
          );
        } else {
          await escalarParaAtendente(
            telefone,
            `🎙️ [ÁUDIO ILEGÍVEL] ${falhas} áudios seguidos sem transcrição para este cliente. Último erro: ${err.message}`,
            requestId,
            { mensagemCliente: 'Ainda não consegui escutar direito 😔 Já chamei um atendente pra falar com você — ele assume em instantes!' }
          );
        }
        return;
      }
    }

    // ── Mídia: imagem ──────────────────────────────────────────────────────
    let isComprovante = false;
    let comprovanteValor = null;
    if (tipo === 'imageMessage') {
      logger.step(requestId, telefone, 'midia/imagem');
      try {
        let b64 = base64Inline, mime = mimetypeInline || 'image/jpeg';
        if (!b64) {
          const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadImagem' });
          b64 = m.base64; mime = m.mimetype || 'image/jpeg';
        }
        const r = await comRetry(() => analisarImagem(b64, mime), { tentativas: 2, requestId, etapa: 'visao' });
        isComprovante = r.isComprovante;
        comprovanteValor = r.valor;

        // Parece comprovante mas a leitura não foi confiável (foto borrada,
        // cortada, "agendado"). Nunca liberar pedido nessas condições.
        if (r.comprovanteDuvidoso) {
          logger.warn('midia/comprovante-duvidoso', 'Comprovante com leitura incerta', {
            requestId, telefone, confianca: r.confianca, valor: r.valor,
          });
          await escalarParaAtendente(telefone, `💸 [COMPROVANTE ILEGÍVEL] Cliente enviou comprovante que não deu pra ler com segurança (confiança: ${r.confianca}). Conferir manualmente. Leitura parcial: ${r.analise}`, requestId, {
            mensagemCliente: 'Recebi seu comprovante! 📎 Só que a imagem ficou meio difícil de ler aqui — vou pedir pra alguém da equipe conferir pra não ter erro. É rapidinho! 🙏',
          });
          return;
        }

        conteudo = isComprovante
          ? `📎 COMPROVANTE PIX CONFIRMADO: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`
          : `📎 [Imagem]: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`;
        logger.info('midia/imagem/ok', 'Analisada', { requestId, telefone, isComprovante, valor: r.valor, confianca: r.confianca });
      } catch (err) {
        logger.error('midia/imagem/erro', err.message, { requestId, telefone, stack: err.stack });
        await escalarParaAtendente(telefone, `🤖 [ERRO TÉCNICO] Falha ao analisar imagem enviada pelo cliente: ${err.message}`, requestId, {
          mensagemCliente: 'Recebi sua imagem, mas tive um problema pra abrir ela aqui 😕 Já chamei um atendente pra conferir — ele assume em instantes.',
        });
        return;
      }
    }

    // ── Localização (fixa ou em tempo real) ──────────────────────────────────
    if (tipo === 'locationMessage' || tipo === 'liveLocationMessage') {
      if (pingDeLocalizacaoRepetido(telefone)) {
        logger.info('midia/localizacao-ping-ignorado', 'Ping de localização em tempo real repetido, ignorado', { requestId, telefone });
        return;
      }
      logger.step(requestId, telefone, 'midia/localizacao');
    }

    if (!conteudo?.trim()) return;

    // ── Cliente existe desde a 1ª mensagem (não só na compra) + origem de anúncio ─
    garantirCliente(telefone, pushName, msg.adInfo).catch(err =>
      logger.warn('cliente/garantir-falhou', err.message, { requestId, telefone }));

    if (msg.adInfo) {
      logger.info('anuncio/detectado', 'Contexto de anúncio (CTWA) identificado', { requestId, telefone, adInfo: msg.adInfo });
    } else if (msg.contextInfoRaw) {
      // Ajuda a validar/corrigir os paths de detecção contra tráfego real
      logger.info('anuncio/contextinfo-sem-ad', 'contextInfo presente sem externalAdReplyInfo', {
        requestId, telefone, contextInfoRaw: msg.contextInfoRaw,
      });
    }

    // ── Salva a mensagem do cliente + marca rastreio de silêncio (p/ follow-up) ─
    await salvarMensagem(telefone, 'user', conteudo);
    await salvarRascunho(telefone, {
      ultima_msg_em: new Date().toISOString(),
      ultima_msg_role: 'user',
      followup_enviado: false,
      // Chegou mensagem compreensível: zera a contagem de áudios falhados,
      // pra um problema pontual de hoje não escalar pra atendente amanhã.
      audio_falhas: 0,
    }).catch(err => logger.warn('rascunho/stamp-user-falhou', err.message, { requestId, telefone }));

    // ── Estado ──────────────────────────────────────────────────────────────
    const [historico, rascunho, ofertaAtiva] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunho(telefone),
      buscarCupomAtivoPorTelefone(telefone).catch((e) => {
        // Nunca deixa uma falha aqui derrubar o atendimento — sem oferta
        // ativa detectada, o fluxo normal (sem desconto) continua valendo.
        logger.warn('oferta/buscar-falhou', e.message, { requestId, telefone });
        return null;
      }),
    ]);
    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone, historico_msgs: historico.length, etapa: rascunho?.etapa_atual || 'sem rascunho',
      cupom_ativo: ofertaAtiva?.codigo || null,
    });

    // ── FLUXO 1: comprovante PIX (código atualiza status, não depende da LLM) ─
    // Determinístico — continua funcionando mesmo com o atendimento pausado.
    if (isComprovante && rascunho?.etapa_atual === 'aguardando_pix') {
      logger.step(requestId, telefone, 'pix/comprovante-recebido');
      const pararDigitando = manterDigitando(telefone);
      try {
        // Confere o VALOR antes de liberar. Um comprovante legítimo de R$ 20
        // num pedido de R$ 68 é um pagamento parcial — ou o print de outra
        // compra. Liberar isso pra cozinha é prejuízo direto.
        const pendente = await buscarPedidoPendente(telefone);
        const diferenca = comprovanteValor == null ? null : Math.round((comprovanteValor - pendente.total) * 100) / 100;

        if (diferenca === null || Math.abs(diferenca) > 0.01) {
          logger.warn('pix/valor-divergente', 'Valor do comprovante não bate com o pedido', {
            requestId, telefone, valor_comprovante: comprovanteValor, total_pedido: pendente.total, diferenca,
          });
          await escalarParaAtendente(
            telefone,
            `💸 [PIX DIVERGENTE] Pedido #${pendente.numero_pedido}: total ${fmt(pendente.total)}, comprovante ${comprovanteValor == null ? 'sem valor legível' : fmt(comprovanteValor)}${diferenca != null ? ` (diferença ${fmt(diferenca)})` : ''}. Conferir antes de liberar.`,
            requestId,
            { mensagemCliente: `Recebi seu comprovante! 📎 Só que o valor não bateu certinho com o total do pedido *#${pendente.numero_pedido}* (${fmt(pendente.total)}), então vou pedir pra alguém da equipe conferir antes de mandar pra cozinha. Já já te falo! 🙏` },
          );
          return;
        }

        const pedido = await comRetry(() => atualizarStatusPedido(telefone, 'preparando'),
          { tentativas: 3, requestId, etapa: 'statusPreparo' });
        await limparRascunho(telefone);
        const txt = `✅ Comprovante recebido, pagamento confirmado! Pedido *#${pedido.numero_pedido}* já tá indo pra cozinha 🍲\n\n⏱️ Logo logo fica pronto. Valeu, ${pushName}! 🎩`;
        await responder(telefone, txt, { requestId, etapa: 'enviarPixOk' });
        return;
      } catch (err) {
        logger.error('pix/comprovante/erro', err.message, { requestId, telefone, stack: err.stack });
        await escalarParaAtendente(telefone, `🤖 [ERRO TÉCNICO] Falha ao confirmar comprovante PIX: ${err.message}`, requestId, {
          mensagemCliente: 'Recebi seu comprovante, mas tive um problema técnico pra confirmar automaticamente 😅 Já avisei a equipe — alguém confere e libera seu pedido em instantes.',
        });
        return;
      } finally {
        pararDigitando();
      }
    }

    // ── FLUXO 2: confirmação SIM (código cria o pedido) ──────────────────────
    // Determinístico — continua funcionando mesmo com o atendimento pausado.
    if (ehConfirmacao(conteudo) && rascunho?.etapa_atual === 'aguardando_confirmacao') {
      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      const pararDigitando = manterDigitando(telefone);
      try {
        const r = await confirmarPedido(rascunho, telefone, requestId, ofertaAtiva);

        let txt;
        const linhaTaxa = r.taxaEntrega > 0 ? `🚴 Taxa de entrega: ${fmt(r.taxaEntrega)}\n` : '';
        const linhaDesconto = r.desconto > 0 ? `🎁 Desconto (${r.cupomAplicado}): -${fmt(r.desconto)}\n` : '';
        const linhaBrinde = r.brindes?.length ? `🎁 Brinde: ${r.brindes.join(' + ')} (cortesia)\n` : '';
        // Troco: repete o combinado já com a conta feita, pra o cliente
        // conferir agora e não na porta.
        const linhaTroco = (r.formaPagamento === 'dinheiro' && r.trocoPara != null)
          ? (Number(r.trocoPara) === 0
              ? '💵 Sem troco (valor certo)\n'
              : `💵 Troco para ${fmt(r.trocoPara)} — levamos ${fmt(money(Number(r.trocoPara) - Number(r.total)))}\n`)
          : '';
        const corpo =
          `🛍️ Subtotal: ${fmt(r.subtotal)}\n` + linhaTaxa + linhaDesconto + linhaBrinde +
          `💰 *Total: ${fmt(r.total)}*\n` + linhaTroco + '\n';

        if (r.formaPagamento === 'pix') {
          const info = await buscarInfo();
          const chave = info.chave_pix || 'não cadastrada';
          txt = `✅ Pedido *#${r.numeroPedido}* registrado!\n\n` + corpo +
            `📱 *Chave PIX:* \`${chave}\`\n\n` +
            `Faz o PIX e me manda o comprovante aqui que eu já libero pra cozinha 😊`;
        } else {
          const prazo = rascunho.tipo_entrega === 'delivery' ? '~35 minutinhos' : '~20 minutinhos';
          txt = `✅ Pedido *#${r.numeroPedido}* confirmado!\n\n` + corpo +
            `Já tá indo pra cozinha! ⏱️ Previsão: ${prazo}. Bom apetite, ${pushName}! 🎩`;
        }

        await responder(telefone, txt, { requestId, etapa: 'enviarConfirmacao' });
        return;
      } catch (err) {
        if (err.jaProcessando) {
          // Outra mensagem quase simultânea (double-tap, retry do WhatsApp)
          // já está fechando este pedido — essa aqui só desiste em silêncio,
          // a outra já vai mandar a confirmação real pro cliente.
          logger.info('pedido/confirmar/concorrente', 'Confirmação duplicada ignorada', { requestId, telefone });
          return;
        }
        logger.error('pedido/confirmar/erro', err.message, { requestId, telefone, faltando: err.faltando, stack: err.stack });

        if (err.faltando?.length) {
          // Falta dado: é conversa normal, o agente completa na próxima volta.
          await responder(telefone, `Opa! Ainda preciso de: ${err.faltando.join(', ')}. Vamos completar?`,
            { requestId, etapa: 'confirmarErro' }).catch(() => {});
          return;
        }

        // Qualquer outra falha aqui é técnica (banco fora, produto sumiu do
        // cardápio no meio da conversa). O cliente já disse SIM e está
        // esperando o pedido — isso não pode morrer num log.
        await escalarParaAtendente(telefone, `🤖 [ERRO TÉCNICO] Falha ao fechar o pedido depois do SIM do cliente: ${err.message}`, requestId, {
          mensagemCliente: 'Opa! Tive um problema técnico bem na hora de fechar seu pedido 😔 Já chamei um atendente pra finalizar isso com você agora mesmo — seus dados estão salvos, não precisa repetir nada.',
        });
        return;
      } finally {
        pararDigitando();
      }
    }

    // ── Atendimento pausado (atendente humano assumiu)? Só bloqueia a partir daqui ─
    if (await verificarPausa(telefone)) {
      logger.info('pausa/ativa', 'Atendimento pausado, IA não respondeu', { requestId, telefone });
      return;
    }

    // ── FLUXO 3: agente conversacional ───────────────────────────────────────
    const pararDigitandoAgente = manterDigitando(telefone);
    try {
      const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
      const { texto, atendenteChamado, mostrouCardapio } = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone, ofertaAtiva);

      // Cliente perguntou o cardápio → manda o vídeo do buffet de hoje ANTES
      // do texto. Ver a comida vende mais que ler a lista, e o vídeo chegando
      // primeiro faz a mensagem seguinte parecer a legenda dele.
      //
      // Quem decide é o CÓDIGO (o agente usou uma tool de cardápio?), não a
      // LLM: assim ela não promete vídeo que não existe nem esquece de mandar.
      if (mostrouCardapio) {
        try {
          const video = await buscarVideoBuffet();
          if (video) {
            await enviarMidia(telefone, video.url, {
              tipo: video.tipo,
              legenda: '🍽️ Esse é o nosso buffet de hoje!',
            });
            logger.info('buffet/video-enviado', 'Vídeo do buffet enviado', { requestId, telefone, tipo: video.tipo });
          } else {
            logger.info('buffet/sem-video', 'Nenhum vídeo de buffet para hoje', { requestId, telefone });
          }
        } catch (err) {
          // Vídeo é um extra. Se falhar, o cardápio em texto ainda vai — não
          // faz sentido derrubar o atendimento por causa disso.
          logger.warn('buffet/video-falhou', err.message, { requestId, telefone });
        }
      }

      if (!texto) {
        // Resposta vazia é sintoma de algo errado (raciocínio consumiu todo o
        // orçamento, tool travou). Pedir "pode repetir?" só empurra o problema.
        logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
        await escalarParaAtendente(telefone, '🤖 [ERRO TÉCNICO] O agente não produziu resposta para a mensagem do cliente.', requestId, {
          mensagemCliente: MSG_ATENDENTE_PADRAO,
        });
        return;
      }

      await responder(telefone, texto, { requestId, etapa: 'enviarResposta' });
      logger.info('whatsapp/ok', 'Resposta enviada', {
        requestId, telefone, chars: texto.length, atendente_chamado: atendenteChamado,
      });
    } finally {
      pararDigitandoAgente();
    }

  } catch (err) {
    logger.error('webhook/erro-geral', err.message, { requestId, telefone, stack: err.stack });
    // Toda falha não tratada vira alerta no painel + pausa. O cliente nunca
    // fica falando sozinho com um agente quebrado.
    await escalarParaAtendente(
      telefone,
      err.precisaAtendente
        ? `🤖 [AGENTE TRAVADO] ${err.precisaAtendente}`
        : `🤖 [ERRO TÉCNICO] ${err.message}`,
      requestId,
      { mensagemCliente: MSG_ATENDENTE_PADRAO },
    ).catch(() => {});
  }
}

// ─── POLLER: FOLLOW-UP DE SILÊNCIO + WATCHDOG DE PEDIDO TRAVADO ───────────────
// Roda dentro do mesmo processo (container único, sem clustering) a cada 60s.
// Usa claim atômico (UPDATE...RETURNING) em supabase.js — não é "SELECT depois
// agir", então não tem corrida com uma mensagem nova chegando no meio.

const SILENCIO_FOLLOWUP_MS = 7 * 60_000;
const TRAVADO_WATCHDOG_MS = 2 * 60_000;

async function pollarFollowups() {
  const candidatos = await reivindicarFollowups(SILENCIO_FOLLOWUP_MS);
  for (const rascunho of candidatos) {
    const requestId = uuid().slice(0, 8);
    const { telefone } = rascunho;
    try {
      if (await verificarPausa(telefone)) {
        logger.info('followup/pausado', 'Atendimento pausado, follow-up não enviado', { requestId, telefone });
        continue;
      }
      const historico = await carregarHistorico(telefone);
      const texto = await gerarFollowup(historico, rascunho, requestId, telefone);
      if (!texto) continue;
      await responder(telefone, texto, { requestId, etapa: 'followup' });
      logger.info('followup/enviado', 'Follow-up enviado após silêncio', { requestId, telefone });
    } catch (err) {
      logger.error('followup/erro', err.message, { requestId, telefone, stack: err.stack });
    }
  }
}

async function pollarTravados() {
  const travados = await reivindicarTravados(TRAVADO_WATCHDOG_MS);
  for (const r of travados) {
    const requestId = uuid().slice(0, 8);
    logger.error('watchdog/rascunho-travado',
      'Rascunho preso em "processando" — possível pedido não finalizado, verificar manualmente com o cliente',
      { requestId, telefone: r.telefone, nome_cliente: r.nome_cliente, itens: r.itens, updated_at: r.updated_at });

    // O processo pode ter morrido entre a trava e o fim de criarPedidoCompleto:
    // não dá pra recriar sozinho (duplicaria o pedido), então quem decide é uma
    // pessoa. Antes isso só ia pro log e ninguém via.
    await escalarParaAtendente(
      r.telefone,
      `⚠️ [PEDIDO TRAVADO] Cliente disse SIM mas o pedido ficou preso em "processando" desde ${r.updated_at}. Verificar no ERP se o pedido foi criado antes de refazer com o cliente.`,
      requestId,
    ).catch(() => {});
  }
}

let pollando = false;
async function pollar() {
  if (pollando) return;
  pollando = true;
  try {
    await pollarFollowups();
    await pollarTravados();
    logger.info('poller/heartbeat', 'Ciclo do poller concluído', {});
  } catch (err) {
    logger.error('poller/erro-geral', err.message, { stack: err.stack });
  } finally {
    pollando = false;
  }
}
setInterval(pollar, 60_000);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info('servidor/start', `🎩 Agente Chapelão rodando na porta ${PORT}`, {
    port: PORT,
    modelo:    MODEL_AGENTE,
    supa_url:  process.env.SUPA_URL          ? '✓' : '✗ FALTANDO',
    anthropic: process.env.ANTHROPIC_API_KEY ? '✓' : '✗ FALTANDO (agente + visão)',
    openai:    process.env.OPENAI_API_KEY    ? '✓' : '✗ FALTANDO (transcrição de áudio)',
    evolution: process.env.EVOLUTION_URL     ? '✓' : '✗ FALTANDO',
  });
});
