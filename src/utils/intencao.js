'use strict';

// ─── LER A RESPOSTA ÓBVIA DO CLIENTE, SEM DEPENDER DA LLM ─────────────────────
// Existe por um caso real: a cliente respondeu "Entrega" TRÊS vezes, o agente
// perguntou TRÊS vezes, e o campo tipo_entrega ficou NULL no banco o tempo
// todo. A LLM leu a resposta, seguiu a conversa e simplesmente não chamou a
// tool pra gravar — e o sistema, vendo o campo vazio, mandava perguntar de
// novo. A cliente desistiu: "você faz as mesmas perguntas e não finaliza".
//
// Resposta de uma palavra é coisa demais pra depender de o modelo lembrar de
// registrar. Aqui o CÓDIGO lê e grava, igual já fazemos com o "sim" da
// confirmação. A LLM continua podendo gravar; isto é a rede embaixo.

const { normalizar } = require('./pedido');

// Só decide quando a mensagem é claramente a resposta àquela pergunta. Na
// dúvida devolve null e deixa a conversa seguir — falso positivo aqui seria
// pior que o problema: mudaria o pedido sem o cliente pedir.
const ENTREGA = /\b(entrega|entregar|entregue|delivery|leva|levar|trazer|traz|manda|mandar|envia|enviar)\b/;
const RETIRADA = /\b(retirada|retirar|retiro|buscar|busco|pegar|pego|vou ai|vou at|no local|balcao|tirar)\b/;

const PIX = /\b(pix)\b/;
const CARTAO = /\b(cartao|credito|debito|maquininha|maquina|visa|master|elo)\b/;
const DINHEIRO = /\b(dinheiro|especie|vivo|papel|cash)\b/;

function detectarTipoEntrega(texto) {
  const t = normalizar(texto);
  const entrega = ENTREGA.test(t);
  const retirada = RETIRADA.test(t);
  // Citou os dois ("é entrega ou retirada?") — não é resposta, é pergunta.
  if (entrega === retirada) return null;
  return entrega ? 'delivery' : 'retirada';
}

function detectarFormaPagamento(texto) {
  const t = normalizar(texto);
  const achados = [PIX.test(t) && 'pix', CARTAO.test(t) && 'cartao', DINHEIRO.test(t) && 'dinheiro']
    .filter(Boolean);
  // Duas formas na mesma frase é o agente perguntando, ou o cliente em dúvida.
  return achados.length === 1 ? achados[0] : null;
}

// Aceita o que a LLM mandar em português e devolve o valor canônico. A tool
// declara enum em inglês ('delivery'), mas o modelo conversa em português e
// às vezes manda "entrega" — que entrava cru no banco e quebrava toda a
// lógica que compara com 'delivery'.
function normalizarTipoEntrega(valor) {
  if (!valor) return null;
  const t = normalizar(valor);
  if (t === 'delivery' || t === 'retirada') return t;
  return detectarTipoEntrega(valor);
}

function normalizarFormaPagamento(valor) {
  if (!valor) return null;
  const t = normalizar(valor);
  if (['pix', 'cartao', 'dinheiro'].includes(t)) return t;
  return detectarFormaPagamento(valor);
}

// Dado o que falta no rascunho e a mensagem que o cliente acabou de mandar,
// devolve os campos que dá pra gravar com segurança.
function capturarRespostaObvia(faltando, texto) {
  const campos = {};
  if (!texto) return campos;

  if (faltando.includes('tipo_entrega')) {
    const tipo = detectarTipoEntrega(texto);
    if (tipo) campos.tipo_entrega = tipo;
  }
  if (faltando.includes('forma_pagamento')) {
    const forma = detectarFormaPagamento(texto);
    if (forma) campos.forma_pagamento = forma;
  }
  return campos;
}

module.exports = {
  detectarTipoEntrega, detectarFormaPagamento,
  normalizarTipoEntrega, normalizarFormaPagamento,
  capturarRespostaObvia,
};
