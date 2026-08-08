'use strict';

// Áudio e imagem, tudo na OpenAI.
//   Áudio  → gpt-transcribe (com fallbacks), guiado pelo vocabulário da casa.
//   Imagem → gpt-5.6-terra com saída estruturada por schema: o comprovante PIX
//            volta como JSON validado, não como texto livre pra alguém adivinhar.

const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');
const { MODEL_VISAO, money } = require('../config');
const logger = require('../logger');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── TRANSCRIÇÃO DE ÁUDIO ─────────────────────────────────────────────────────
// Áudio de WhatsApp é o pior caso: ruído de rua, cozinha, pessoa andando.
// Duas coisas melhoram muito a taxa de acerto:
//   1. gpt-transcribe no lugar do whisper-1 (bem melhor em pt-BR ruidoso).
//   2. um "prompt" com o vocabulário do restaurante — sem ele "marmitex média"
//      vira "marmita media" e os nomes dos itens do dia saem irreconhecíveis.
const VOCABULARIO = [
  'Restaurante Chapelão', 'marmitex', 'marmitex pequena', 'marmitex média', 'marmitex grande',
  'refeição', 'esfirra', 'combo', 'maionese', 'refrigerante', 'Coca-Cola', 'Guaraná', 'suco',
  'arroz', 'feijão', 'farofa', 'salada', 'purê', 'macarrão', 'strogonoff', 'almôndegas',
  'frango assado', 'bife de paleta', 'costela assada', 'linguiça assada', 'banana à milanesa',
  'batata frita', 'refogado de repolho', 'delivery', 'entrega', 'retirada',
  'PIX', 'dinheiro', 'cartão', 'troco',
].join(', ');

const MODELOS_TRANSCRICAO = ['gpt-transcribe', 'gpt-4o-transcribe', 'whisper-1'];

async function transcreverComModelo(base64, mimetype, modelo) {
  const buffer = Buffer.from(base64, 'base64');

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'audio.ogg',
    contentType: String(mimetype || 'audio/ogg').split(';')[0],
  });
  form.append('model', modelo);
  form.append('language', 'pt');
  form.append('prompt', `Pedido em restaurante brasileiro. Vocabulário provável: ${VOCABULARIO}.`);

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      timeout: 45000,
    }
  );

  if (!data?.text?.trim()) throw new Error(`${modelo} não retornou transcrição.`);
  return data.text.trim();
}

// Transcrição vazia, com uma letra só, ou puro ruído ("...", "hmm") não é
// transcrição — é falha. Deixar passar faria o agente responder a nada.
function transcricaoUtil(texto) {
  const limpo = String(texto || '').replace(/[.…,!?\s]/g, '');
  return limpo.length >= 2;
}

async function transcreverAudio(base64, mimetype = 'audio/ogg') {
  let ultimoErro;
  for (const modelo of MODELOS_TRANSCRICAO) {
    try {
      const texto = await transcreverComModelo(base64, mimetype, modelo);
      if (!transcricaoUtil(texto)) throw new Error(`${modelo} retornou transcrição vazia ou sem conteúdo.`);
      return texto;
    } catch (err) {
      ultimoErro = err;
      logger.warn('midia/audio/modelo-falhou', `${modelo} falhou: ${err.message}`, { modelo });
    }
  }
  throw ultimoErro || new Error('Nenhum modelo de transcrição respondeu.');
}

// ─── ANÁLISE DE IMAGEM / COMPROVANTE PIX ──────────────────────────────────────
// Saída estruturada (json_schema com strict): o modelo é obrigado a devolver
// exatamente estes campos. Antes a decisão "é comprovante?" saía de procurar as
// palavras "sim" e "pix" num texto livre — qualquer frase do tipo "não, isto
// não é um comprovante PIX" era classificada como comprovante e liberava o
// pedido pra cozinha.

const SCHEMA_IMAGEM = {
  type: 'object',
  properties: {
    eh_comprovante: {
      type: 'boolean',
      description: 'true SOMENTE se a imagem for um comprovante/recibo de pagamento (PIX, TED, transferência) já CONCLUÍDO. Tela de "agendado", "em processamento", QR Code a pagar, print de saldo ou de conversa NÃO contam.',
    },
    confianca: {
      type: 'string',
      enum: ['alta', 'media', 'baixa'],
      description: 'Sua confiança na leitura. Use "baixa" se a imagem estiver cortada, borrada, escura ou se algum campo estiver ilegível.',
    },
    valor: {
      type: ['number', 'null'],
      description: 'Valor transferido em reais, apenas o número (ex: 34.00). null se não for comprovante ou se o valor não estiver legível.',
    },
    data_hora:   { type: ['string', 'null'], description: 'Data e hora da transação como aparece na imagem. null se ausente.' },
    destinatario:{ type: ['string', 'null'], description: 'Nome de quem RECEBEU. null se ausente.' },
    remetente:   { type: ['string', 'null'], description: 'Nome de quem PAGOU. null se ausente.' },
    instituicao: { type: ['string', 'null'], description: 'Banco ou instituição do comprovante. null se ausente.' },
    descricao:   { type: 'string', description: 'Uma frase curta em português descrevendo o que é a imagem.' },
  },
  required: ['eh_comprovante', 'confianca', 'valor', 'data_hora', 'destinatario', 'remetente', 'instituicao', 'descricao'],
  additionalProperties: false,
};

const INSTRUCAO_IMAGEM = `Você analisa imagens enviadas por clientes de uma marmitaria pelo WhatsApp.

A imagem é quase sempre uma destas coisas: comprovante de PIX, print de tela do banco, foto de comida, ou algo aleatório.

Ao ler um comprovante:
- Leia os valores EXATAMENTE como estão escritos. Não arredonde, não converta, não corrija o que parece "estranho".
- Atenção ao separador decimal brasileiro: "R$ 1.234,56" é mil duzentos e trinta e quatro reais e cinquenta e seis centavos → 1234.56. "R$ 34,00" → 34.00.
- Se o comprovante disser "agendado", "em processamento", "pendente" ou for um QR Code ainda a pagar, então eh_comprovante é false: o dinheiro ainda não saiu.
- Se qualquer campo estiver borrado, cortado ou ambíguo, use confianca "baixa" em vez de adivinhar. Preferimos um humano conferir a liberar um pedido não pago.
- Se não for comprovante, descreva a imagem em uma frase e deixe os campos de pagamento como null.`;

async function analisarImagem(base64, mimetype = 'image/jpeg') {
  const client = getClient();

  const resposta = await client.chat.completions.create({
    model: MODEL_VISAO,
    max_completion_tokens: 1500,
    reasoning_effort: 'low',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'analise_imagem', strict: true, schema: SCHEMA_IMAGEM },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${String(mimetype || 'image/jpeg').split(';')[0]};base64,${base64}`,
              detail: 'high', // comprovante tem número pequeno; 'low' erra centavo
            },
          },
          { type: 'text', text: INSTRUCAO_IMAGEM },
        ],
      },
    ],
  });

  const texto = resposta.choices[0]?.message?.content?.trim() || '';
  if (!texto) throw new Error('Modelo não retornou análise da imagem.');

  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new Error(`Resposta da análise de imagem não é JSON válido: ${texto.slice(0, 200)}`);
  }

  const valor = dados.valor == null ? null : money(dados.valor);

  // Comprovante só conta como confirmado com leitura de ALTA confiança e valor
  // legível. "media"/"baixa" viram caso de conferência humana — é a diferença
  // entre liberar comida de graça e pedir 30 segundos de paciência ao cliente.
  const isComprovante = dados.eh_comprovante === true && dados.confianca === 'alta' && valor != null;

  const partes = [dados.descricao];
  if (valor != null) partes.push(`Valor: R$ ${valor.toFixed(2).replace('.', ',')}`);
  if (dados.data_hora) partes.push(`Data/hora: ${dados.data_hora}`);
  if (dados.destinatario) partes.push(`Destinatário: ${dados.destinatario}`);
  if (dados.remetente) partes.push(`Pagador: ${dados.remetente}`);
  if (dados.instituicao) partes.push(`Instituição: ${dados.instituicao}`);

  return {
    analise: partes.filter(Boolean).join(' | '),
    isComprovante,
    // Comprovante lido mas com dúvida: o fluxo trata como caso de atendente,
    // em vez de ignorar em silêncio ou confirmar por engano.
    comprovanteDuvidoso: dados.eh_comprovante === true && !isComprovante,
    valor,
    confianca: dados.confianca,
    dados,
  };
}

module.exports = { transcreverAudio, analisarImagem };
