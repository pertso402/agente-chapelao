'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const {
  extrairMensagem, downloadMidia, enviarTexto, enviarMidia, manterDigitando, ehEcoDoBot, estadoInstancia,
} = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, stamparRascunho, limparRascunho, atualizarRascunho,
  precificarPedido, buscarTaxasEstouradas, buscarTaxaPadrao,
  definirTaxaEntrega, reivindicarAvisosDeTaxa,
  buscarInfo, buscarVideoBuffet, criarPedidoCompleto, tentarIniciarPagamento,
  buscarCupomAtivoPorTelefone,
  garantirCliente, verificarPausa, pausarAtendimento, criarAlertaAtendimento,
  buscarLojaAberta, definirLojaAberta, lerMarcador, gravarMarcador,
  reivindicarFollowups, reivindicarTravados,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido, gerarFollowup, modeloEmUso } = require('./agent');
const { comRetry } = require('./utils/retry');
const { normalizar, montarResumoFinal, descreverFaltando } = require('./utils/pedido');
const {
  PAUSA_ATENDENTE_MS, MAX_FALHAS_AUDIO, fmtBRL, money,
  TAXA_ENTREGA_PADRAO, TIMEOUT_TAXA_MS,
  dentroDoHorario, quandoAbreTexto, horaLocal, hojeLocal, TEXTO_HORARIO,
  ABRE_HORA, FECHA_HORA, DIAS_ABERTOS, diaDaSemanaLocal, decidirLoja,
} = require('./config');

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

// ─── FORA DO HORÁRIO DE ATENDIMENTO ───────────────────────────────────────────
// Trava de código, não instrução de prompt: a LLM cede quando o cliente
// insiste ("só hoje, por favor"), e aí a cozinha recebe pedido de madrugada.
//
// Quem escreve fora do horário recebe UMA resposta educada com o horário. As
// mensagens seguintes ficam em silêncio por um tempo — responder cinco vezes
// seguidas "estamos fechados" é pior do que não responder.
const JANELA_AVISO_FECHADO_MS = 60 * 60_000;
const avisoFechadoEnviado = new Map(); // telefone -> timestamp

function jaAvisouQueEstaFechado(telefone) {
  const agora = Date.now();
  for (const [tel, ts] of avisoFechadoEnviado) {
    if (agora - ts > JANELA_AVISO_FECHADO_MS) avisoFechadoEnviado.delete(tel);
  }
  const ultimo = avisoFechadoEnviado.get(telefone);
  if (ultimo && agora - ultimo < JANELA_AVISO_FECHADO_MS) return true;
  avisoFechadoEnviado.set(telefone, agora);
  return false;
}

function mensagemForaDoHorario(pushName) {
  const nome = pushName && pushName !== 'Cliente' ? `, ${pushName}` : '';
  return `Oi${nome}! 🎩 No momento a gente não está atendendo.\n\n` +
    `🕚 Nosso horário é ${TEXTO_HORARIO}.\n\n` +
    `Volto a te atender ${quandoAbreTexto()} — me chama que eu já separo sua marmita quentinha! 😋`;
}

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
app.get('/health', async (_req, res) => {
  // De qual WhatsApp este container fala. Trocar a instância é meia mudança:
  // apontar o webhook da Evolution nova pro agente faz a mensagem CHEGAR, mas
  // a resposta continua saindo pela instância das variáveis de ambiente. Sem
  // este campo, o sintoma (cliente escreve pra um número e recebe resposta de
  // outro) só aparece testando no WhatsApp.
  const whatsapp = await estadoInstancia().catch(err => ({ ok: false, erro: err.message }));

  res.json({
    whatsapp,
    status: 'ok',
    ts: new Date().toISOString(),
    agente: 'Chapelão v3',
    // Mostra o modelo configurado E o que está realmente em uso. Se o
    // fallback tiver entrado em ação (conta sem acesso ao modelo novo), dá
    // pra ver aqui de fora, sem precisar caçar no log.
    modelo: modeloEmUso(),
    atendimento: {
      horario: TEXTO_HORARIO,
      aberto_agora: dentroDoHorario(),
      hora_local: (() => { const { hora, minuto } = horaLocal();
        return `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`; })(),
    },
    vars: {
      supa: !!process.env.SUPA_URL,
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

  // Junta as mensagens picadas antes de responder (ver agruparMensagem).
  agruparMensagem(msg, requestId);
});

// ─── AGRUPAR MENSAGENS PICADAS ────────────────────────────────────────────────
// No WhatsApp as pessoas escrevem em rajada: "Olá!" · "Só pra salvar o número"
// · "Blz" — três mensagens em segundos. Respondendo uma por uma, o agente
// mandava três respostas quase iguais, cada uma perguntando de novo "prefere
// Pequena, Média ou Grande?". Isso é o que faz o atendimento parecer robô.
//
// Agora o texto espera um instante de silêncio e vira UMA rodada só. O relógio
// REINICIA a cada mensagem nova (a pessoa ainda está digitando), com um teto
// pra quem escreve sem parar nunca ficar sem resposta.
//
// Áudio, imagem e localização NÃO esperam: cada um tem tratamento próprio
// (transcrever, ler comprovante) e juntar mudaria o significado. Eles descarregam
// o que estiver acumulado e seguem na frente.
const ESPERA_AGRUPAR_MS = Number(process.env.AGRUPAR_MSG_SEG || 6) * 1000;
const TETO_AGRUPAR_MS = ESPERA_AGRUPAR_MS * 4;

const buffers = new Map(); // telefone -> { msgs, timer, requestId, desde }

function ehTextoSimples(msg) {
  return msg.tipo === 'text' || msg.tipo === 'conversation' || msg.tipo === 'extendedTextMessage';
}

function despachar(telefone) {
  const buf = buffers.get(telefone);
  if (!buf) return;
  clearTimeout(buf.timer);
  buffers.delete(telefone);

  // Uma mensagem só: segue idêntico ao que era antes.
  const base = buf.msgs[buf.msgs.length - 1];
  const textos = buf.msgs.map(m => (m.texto || '').trim()).filter(Boolean);
  const juntado = { ...base, texto: textos.join('\n') };

  if (buf.msgs.length > 1) {
    logger.info('webhook/agrupado', 'Mensagens picadas juntadas numa rodada só', {
      requestId: buf.requestId, telefone, quantidade: buf.msgs.length,
    });
  }

  // Serializa por telefone: mensagens do MESMO cliente chegando rápido uma
  // atrás da outra esperam a anterior terminar antes de ler/escrever o
  // rascunho — evita duas escritas concorrentes se atropelarem. Clientes
  // diferentes continuam processando 100% em paralelo.
  enfileirar(telefone, () => processarMensagem(juntado, buf.requestId));
}

function agruparMensagem(msg, requestId) {
  const { telefone } = msg;

  if (!ehTextoSimples(msg)) {
    despachar(telefone); // manda o texto acumulado antes, na ordem em que veio
    enfileirar(telefone, () => processarMensagem(msg, requestId));
    return;
  }

  const buf = buffers.get(telefone) || { msgs: [], timer: null, requestId, desde: Date.now() };
  clearTimeout(buf.timer);
  buf.msgs.push(msg);

  // Teto: quem manda mensagem a cada 3 segundos sem parar não pode adiar a
  // resposta pra sempre.
  const restante = Math.max(0, TETO_AGRUPAR_MS - (Date.now() - buf.desde));
  buf.timer = setTimeout(() => despachar(telefone), Math.min(ESPERA_AGRUPAR_MS, restante));

  buffers.set(telefone, buf);
}

async function processarMensagem(msg, requestId) {
  const { telefone, pushName, tipo, key, base64: base64Inline, mimetype: mimetypeInline } = msg;
  let conteudo = msg.texto;

  logger.step(requestId, telefone, 'webhook/recebido', { tipo, pushName, preview: (conteudo || '').slice(0, 60) });

  try {
    // ── Mídia: áudio ───────────────────────────────────────────────────────
    if (tipo === 'audioMessage') {
      logger.step(requestId, telefone, 'midia/audio');
      try {
        let b64 = base64Inline, mime = mimetypeInline || 'audio/ogg';
        if (!b64) {
          const m = await comRetry(() => downloadMidia(key), { tentativas: 3, requestId, etapa: 'downloadAudio' });
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
          const m = await comRetry(() => downloadMidia(key), { tentativas: 3, requestId, etapa: 'downloadImagem' });
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
        // Confere o VALOR antes de criar o pedido. Um comprovante legítimo de
        // R$ 20 num pedido de R$ 68 é um pagamento parcial — ou o print de
        // outra compra. Mandar isso pra cozinha é prejuízo direto.
        //
        // A comparação é contra o total FECHADO no SIM (total_confirmado), não
        // contra uma reprecificação: o cliente pagou o número que leu.
        const esperado = Number(rascunho.total_confirmado);
        const diferenca = (comprovanteValor == null || !Number.isFinite(esperado))
          ? null
          : Math.round((comprovanteValor - esperado) * 100) / 100;

        if (diferenca === null || Math.abs(diferenca) > 0.01) {
          logger.warn('pix/valor-divergente', 'Valor do comprovante não bate com o total combinado', {
            requestId, telefone, valor_comprovante: comprovanteValor, total_combinado: esperado, diferenca,
          });
          await escalarParaAtendente(
            telefone,
            `💸 [PIX DIVERGENTE] ${rascunho.nome_cliente || 'Cliente'}: combinado ${fmt(esperado)}, comprovante ${comprovanteValor == null ? 'sem valor legível' : fmt(comprovanteValor)}${diferenca != null ? ` (diferença ${fmt(diferenca)})` : ''}. O pedido NÃO foi criado — conferir com o cliente antes de liberar.`,
            requestId,
            { mensagemCliente: `Recebi seu comprovante! 📎 Só que o valor não bateu certinho com o total do pedido (${fmt(esperado)}), então vou pedir pra alguém da equipe conferir antes de mandar pra cozinha. Já já te falo! 🙏` },
          );
          return;
        }

        // Pagamento confere: AGORA o pedido é criado e vai pro painel e pra
        // impressora. A trava é atômica porque cliente que manda o print duas
        // vezes (ou um retry do WhatsApp) criaria dois pedidos iguais.
        const travado = await tentarIniciarPagamento(telefone);
        if (!travado) {
          logger.info('pix/comprovante-duplicado', 'Outro comprovante da mesma conversa já está sendo processado', { requestId, telefone });
          return;
        }

        let r;
        try {
          r = await comRetry(
            () => criarPedidoCompleto({
              nomeCliente:    travado.nome_cliente,
              telefone,
              tipoEntrega:    travado.tipo_entrega,
              endereco:       travado.endereco,
              formaPagamento: 'pix',
              trocoPara:      null,
              taxaEntrega:    travado.taxa_entrega,
              itens:          travado.itens,
              itensBrinde:    travado.itens_brinde,
              cupom:          ofertaAtiva || null,
            }),
            { tentativas: 3, requestId, etapa: 'criarPedidoAposPix' }
          );
        } catch (err) {
          // Devolve pro estado de espera: o cliente já pagou, então não pode
          // ficar preso em 'processando' sem ninguém olhar.
          await salvarRascunho(telefone, { etapa_atual: 'aguardando_pix' }).catch(() => {});
          throw err;
        }

        await limparRascunho(telefone);
        logger.info('pedido/criado', 'Pedido criado após comprovante PIX conferido', {
          requestId, telefone, numero_pedido: r.numeroPedido, total: r.total,
        });

        // O pedido é reprecificado a partir do catálogo na hora de gravar. Se
        // algum preço mudou entre o SIM e o comprovante, o valor gravado sai
        // diferente do que o cliente pagou. O pedido continua válido (ele pagou
        // o que combinamos), mas alguém precisa saber da diferença.
        if (Math.abs(Number(r.total) - esperado) > 0.01) {
          logger.error('pix/total-mudou-apos-pagamento',
            'Total gravado diferente do total pago pelo cliente', {
              requestId, telefone, numero_pedido: r.numeroPedido, pago: esperado, gravado: r.total });
          await criarAlertaAtendimento(telefone, travado.nome_cliente,
            `⚠️ Pedido #${r.numeroPedido}: cliente pagou ${fmt(esperado)} mas o pedido foi gravado com ${fmt(r.total)} (preço mudou no cardápio no meio da conversa). Conferir.`
          ).catch(() => {});
        }

        const txt = `✅ Comprovante recebido, pagamento confirmado! Pedido *#${r.numeroPedido}* já tá indo pra cozinha 🍲\n\n⏱️ Logo logo fica pronto. Valeu, ${pushName}! 🎩`;
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

    // ── PORTÃO: a loja está aberta? ──────────────────────────────────────────
    // Quem manda é o botão "Aberta/Fechada" do painel. O horário (11h–14h) age
    // sobre ESSE botão, não sobre a conversa — ver sincronizarLoja() no poller.
    //
    // Fazer assim tem duas vantagens: a cozinha fecha na hora que quiser com um
    // clique (acabou a comida, feriado), e dá pra abrir fora do horário para
    // testar sem mexer em variável de ambiente nem publicar nada.
    //
    // Vem depois do comprovante PIX de propósito: dinheiro que já saiu da conta
    // do cliente precisa ser reconhecido a qualquer hora, loja aberta ou não.
    const lojaAberta = await buscarLojaAberta().catch(err => {
      // Falha ao consultar não pode calar o atendimento — na dúvida, atende.
      logger.warn('loja/consulta-falhou', err.message, { requestId, telefone });
      return true;
    });

    if (!lojaAberta) {
      const { hora, minuto } = horaLocal();
      logger.info('horario/fechado', 'Mensagem com a loja fechada', {
        requestId, telefone, hora_local: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`,
      });

      if (jaAvisouQueEstaFechado(telefone)) {
        logger.info('horario/aviso-ja-enviado', 'Silêncio: cliente já foi avisado na última hora', { requestId, telefone });
        return;
      }

      await responder(telefone, mensagemForaDoHorario(pushName), { requestId, etapa: 'foraDoHorario' });
      return;
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
          // Sem número de pedido aqui: no PIX o pedido só é criado depois do
          // comprovante conferido. Anunciar "#42 registrado" e depois a pessoa
          // não pagar deixaria um número que nunca existiu na conversa dela.
          const info = await buscarInfo();
          const chave = info.chave_pix || 'não cadastrada';
          const titular = info.pix_titular ? `\n👤 *${info.pix_titular}*${info.pix_banco ? ` — ${info.pix_banco}` : ''}` : '';
          txt = `🎩 Tudo certo, ${pushName}! Seu pedido está reservado:\n\n` + corpo +
            `📱 *Chave PIX:* \`${chave}\`${titular}\n\n` +
            `Faz o PIX e me manda o comprovante aqui — assim que eu conferir, mando pra cozinha 😊`;
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

// Follow-up adaptativo pela temperatura do lead:
//   - Já escolheu item e está a um passo de fechar → 3 min. É o momento de
//     maior intenção da conversa inteira; 7 minutos de silêncio aqui é tempo
//     de sobra pra pessoa pedir em outro lugar.
//   - Ainda só olhando cardápio → 8 min, pra não parecer insistente com quem
//     nem decidiu se vai pedir.
const SILENCIO_QUENTE_MS = 3 * 60_000;
const SILENCIO_FRIO_MS   = 8 * 60_000;
const TRAVADO_WATCHDOG_MS = 2 * 60_000;

// Etapas em que o cliente já demonstrou intenção real de compra.
const ETAPAS_QUENTES = new Set(['coletando_dados', 'aguardando_confirmacao']);

// ─── ABERTURA E FECHAMENTO AUTOMÁTICOS ────────────────────────────────────────
// O botão do painel é a chave mestra; esta rotina só o gira nos horários.
//
//   11h (seg–sáb) → liga o botão, se ele ainda não foi ligado hoje
//   depois das 14h → desliga o botão, se ele ainda não foi desligado hoje
//
// O "se ainda não foi hoje" é o detalhe que faz isso ser útil em vez de
// irritante: se a cozinha fechar manualmente ao meio-dia porque acabou a
// comida, a rotina NÃO reabre — a abertura de hoje já aconteceu. E se você
// abrir às 9h pra testar, ela não fecha na sua cara: o fechamento só ocorre
// depois das 14h.
//
// Os marcadores ficam no banco, não em memória: o container reinicia a cada
// publicação e a automação não pode rodar duas vezes no mesmo dia.
async function sincronizarLoja() {
  try {
    const hoje = hojeLocal();
    const { hora } = horaLocal();

    const [marcadorAbertura, marcadorFechamento, lojaAberta] = await Promise.all([
      lerMarcador('loja_auto_abertura'),
      lerMarcador('loja_auto_fechamento'),
      buscarLojaAberta(),
    ]);

    const { acao, marcador } = decidirLoja({
      hora, hoje, lojaAberta,
      diaUtil: DIAS_ABERTOS.includes(diaDaSemanaLocal()),
      marcadorAbertura, marcadorFechamento,
    });
    if (!acao) return;

    if (acao === 'abrir') {
      await definirLojaAberta(true);
      logger.info('loja/aberta-automaticamente', `Loja aberta pelo horário (${ABRE_HORA}h)`, { hoje });
    } else if (acao === 'fechar') {
      await definirLojaAberta(false);
      logger.info('loja/fechada-automaticamente', `Loja fechada pelo horário (${FECHA_HORA}h)`, { hoje });
    }
    // 'so-marcar': já estava fechada, só registra que o fechamento de hoje
    // aconteceu — pra não ficar reavaliando isso a cada minuto.
    await gravarMarcador(marcador, hoje);
  } catch (err) {
    logger.error('loja/sincronizar-falhou', err.message, { stack: err.stack });
  }
}

async function pollarFollowups() {
  // Follow-up é mensagem que o restaurante manda sem o cliente pedir. Com a
  // loja fechada isso não é retomada de venda, é incômodo — e a conversa não
  // teria como avançar, porque o portão bloqueia a resposta dele.
  if (!(await buscarLojaAberta().catch(() => false))) return;

  // Reivindica pela janela mais larga e filtra aqui: o banco não sabe a regra
  // de temperatura, e uma query só evita duas rodadas de claim concorrentes.
  const candidatos = (await reivindicarFollowups(SILENCIO_QUENTE_MS)).filter(r => {
    const silencioMs = Date.now() - new Date(r.ultima_msg_em).getTime();
    const limite = ETAPAS_QUENTES.has(r.etapa_atual) ? SILENCIO_QUENTE_MS : SILENCIO_FRIO_MS;
    if (silencioMs >= limite) return true;
    // Ainda não é hora: devolve pra fila pra ser pego no ciclo certo.
    salvarRascunho(r.telefone, { followup_enviado: false }).catch(() => {});
    return false;
  });

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

// ─── TAXA DE ENTREGA: FECHAR O CICLO ──────────────────────────────────────────
// Duas coisas, nesta ordem:
//   1. Quem pediu a taxa e ninguém digitou dentro do prazo recebe o valor
//      padrão. Deixar o cliente esperando indefinidamente perde a venda;
//      cobrar o padrão, não.
//   2. Quem já tem taxa (digitada no painel OU padrão) e ainda não foi avisado
//      recebe a mensagem — PROATIVA, sem o cliente perguntar nada. O claim
//      dessa lista é atômico, então dois ciclos cruzados não avisam duas vezes.
async function pollarTaxas() {
  // 1) Estouro do prazo
  const estouradas = await buscarTaxasEstouradas(TIMEOUT_TAXA_MS);
  if (estouradas.length) {
    const padrao = await buscarTaxaPadrao(TAXA_ENTREGA_PADRAO);
    for (const r of estouradas) {
      try {
        await definirTaxaEntrega(r.telefone, padrao, 'padrao');
        logger.info('taxa/padrao-aplicada',
          `Ninguém digitou a taxa em ${TIMEOUT_TAXA_MS / 60000} min — aplicado o valor padrão`,
          { telefone: r.telefone, taxa: padrao });
      } catch (err) {
        logger.error('taxa/padrao-erro', err.message, { telefone: r.telefone, stack: err.stack });
      }
    }
  }

  // 2) Avisar o cliente
  const paraAvisar = await reivindicarAvisosDeTaxa();
  for (const r of paraAvisar) {
    const requestId = uuid().slice(0, 8);
    const { telefone } = r;
    try {
      if (await verificarPausa(telefone)) continue;

      // Recalcula a etapa agora que a taxa existe — é o que pode levar o
      // rascunho de "coletando_dados" para "aguardando_confirmacao".
      const { rascunho, avaliacao } = await atualizarRascunho(telefone, {});
      const taxa = Number(rascunho.taxa_entrega);

      if (!avaliacao.completo) {
        // Falta outra coisa (nome, por exemplo). Manda só a taxa — o total
        // ainda não pode ser dito, e dizer total incompleto é o bug original.
        await responder(telefone,
          `Confirmei a entrega pro seu endereço: *${fmt(taxa)}* 🚴\n\nSó preciso de mais uma coisinha: ${descreverFaltando(avaliacao.faltando)}.`,
          { requestId, etapa: 'taxa-parcial' });
        continue;
      }

      const cupom = await buscarCupomAtivoPorTelefone(telefone).catch(() => null);
      const totais = await precificarPedido({
        itens:       rascunho.itens,
        itensBrinde: rascunho.itens_brinde,
        tipoEntrega: rascunho.tipo_entrega,
        cupom:       cupom || null,
        taxaEntrega: rascunho.taxa_entrega,
      });

      const resumo = montarResumoFinal({
        itens:          totais.itens,
        brindes:        totais.brindes,
        tipoEntrega:    rascunho.tipo_entrega,
        endereco:       rascunho.endereco,
        formaPagamento: rascunho.forma_pagamento,
        trocoPara:      rascunho.troco_para,
        totais,
        cupomCodigo:    cupom?.codigo,
      });

      await responder(telefone,
        `Confirmei a entrega pro seu endereço: *${fmt(taxa)}* 🚴\n\n${resumo}`,
        { requestId, etapa: 'taxa-definida' });

      logger.info('taxa/cliente-avisado', 'Taxa calculada e resumo enviado', {
        requestId, telefone, taxa, origem: rascunho.taxa_status,
      });
    } catch (err) {
      logger.error('taxa/aviso-erro', err.message, { requestId, telefone, stack: err.stack });
    }
  }
}

let pollando = false;
async function pollar() {
  if (pollando) return;
  pollando = true;
  try {
    await sincronizarLoja();
    await pollarTaxas();
    await pollarFollowups();
    await pollarTravados();
    logger.info('poller/heartbeat', 'Ciclo do poller concluído', {});
  } catch (err) {
    logger.error('poller/erro-geral', err.message, { stack: err.stack });
  } finally {
    pollando = false;
  }
}
// ─── START ────────────────────────────────────────────────────────────────────
// Só sobe servidor e timer quando o arquivo é EXECUTADO. Quando ele é apenas
// importado (pelos testes), nada dispara — é isso que permite um teste chamar
// as rotinas do poller de verdade.
//
// Esse teste existe por um motivo concreto: `sincronizarLoja` rodou um dia
// inteiro em produção falhando com "decidirLoja is not defined" — a função
// estava exportada no config mas faltava no require daqui. `node --check` só
// valida sintaxe e não pega referência indefinida; só executar pega.
if (require.main === module) {
  setInterval(pollar, 60_000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info('servidor/start', `🎩 Agente Chapelão rodando na porta ${PORT}`, {
      port: PORT,
      modelo:    modeloEmUso(),
      horario:   TEXTO_HORARIO,
      aberto_agora: dentroDoHorario(),
      supa_url:  process.env.SUPA_URL       ? '✓' : '✗ FALTANDO',
      openai:    process.env.OPENAI_API_KEY ? '✓' : '✗ FALTANDO (agente, visão e áudio)',
      evolution: process.env.EVOLUTION_URL  ? '✓' : '✗ FALTANDO',
    });
  });
}

module.exports = {
  app, pollar, sincronizarLoja, pollarFollowups, pollarTravados, pollarTaxas,
  _testes: { agruparMensagem, despachar },
};
