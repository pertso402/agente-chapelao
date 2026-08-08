'use strict';

// Testes da abertura/fechamento automáticos da loja.
//
// O botão "Aberta/Fechada" do painel é a chave mestra do atendimento. Esta
// rotina só o gira nos horários — e um erro de borda aqui custa um dia inteiro
// de vendas (reabrir uma loja que a cozinha fechou porque acabou a comida) ou
// atrapalha um teste (fechar na cara de quem abriu às 9h de propósito).
//
//   npm run test:loja

const assert = require('assert');
const { decidirLoja, ABRE_HORA, FECHA_HORA } = require('../src/config');

let passou = 0;
function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  ✅ ${nome}`);
  } catch (err) {
    console.error(`  ❌ ${nome}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

const HOJE = '2026-08-10';
const ONTEM = '2026-08-09';

// Atalho: cenário com os padrões do dia útil e nada feito hoje ainda.
function cenario(extra = {}) {
  return decidirLoja({
    hora: 12, diaUtil: true, hoje: HOJE,
    marcadorAbertura: ONTEM, marcadorFechamento: ONTEM,
    lojaAberta: false,
    ...extra,
  });
}

console.log('\n🎩 Abertura automática\n');

teste(`abre às ${ABRE_HORA}h em dia útil`, () => {
  assert.strictEqual(cenario({ hora: ABRE_HORA }).acao, 'abrir');
});

teste('abre no meio do expediente (container reiniciou às 12h)', () => {
  assert.strictEqual(cenario({ hora: 12 }).acao, 'abrir');
});

teste('NÃO abre antes do horário', () => {
  assert.strictEqual(cenario({ hora: ABRE_HORA - 1 }).acao, null);
});

teste('NÃO abre em dia não útil (domingo), mesmo no meio do dia', () => {
  // Já fechada: nada a fazer além de registrar o fechamento do dia.
  assert.strictEqual(cenario({ hora: 12, diaUtil: false }).acao, 'so-marcar');
});

teste('NÃO reabre se já abriu hoje', () => {
  assert.strictEqual(cenario({ hora: 12, marcadorAbertura: HOJE }).acao, null);
});

console.log('\n🎩 A cozinha fechou no meio do expediente\n');

teste('ESTE É O CASO CRÍTICO: acabou a comida ao meio-dia e a loja NÃO reabre', () => {
  // A abertura de hoje já aconteceu; o atendente clicou "Fechada" às 12h30.
  const r = cenario({ hora: 12, marcadorAbertura: HOJE, lojaAberta: false });
  assert.strictEqual(r.acao, null, 'a automação não pode desfazer o clique da cozinha');
});

console.log('\n🎩 Fechamento automático\n');

teste(`fecha depois das ${FECHA_HORA}h se estiver aberta`, () => {
  const r = cenario({ hora: FECHA_HORA, marcadorAbertura: HOJE, lojaAberta: true });
  assert.strictEqual(r.acao, 'fechar');
  assert.strictEqual(r.marcador, 'loja_auto_fechamento');
});

teste('à noite, já fechada, só registra (não fica reavaliando a cada minuto)', () => {
  const r = cenario({ hora: 22, marcadorAbertura: HOJE, lojaAberta: false });
  assert.strictEqual(r.acao, 'so-marcar');
});

teste('NÃO fecha duas vezes no mesmo dia', () => {
  const r = cenario({ hora: 22, marcadorAbertura: HOJE, marcadorFechamento: HOJE, lojaAberta: true });
  assert.strictEqual(r.acao, null);
});

teste('fecha no domingo mesmo sem ter aberto', () => {
  const r = cenario({ hora: 12, diaUtil: false, lojaAberta: true });
  assert.strictEqual(r.acao, 'fechar');
});

console.log('\n🎩 Testar fora do horário (o motivo de tudo isto existir)\n');

teste('abri às 9h pra testar: a automação NÃO fecha na minha cara', () => {
  // Manhã de dia útil, antes de abrir, loja ligada na mão.
  const r = cenario({ hora: 9, lojaAberta: true });
  assert.strictEqual(r.acao, null, 'fechar antes do expediente inviabiliza o teste');
});

teste('mas às 14h o teste esquecido ligado é encerrado sozinho', () => {
  const r = cenario({ hora: FECHA_HORA, lojaAberta: true });
  assert.strictEqual(r.acao, 'fechar');
});

teste('teste às 22h também é encerrado (não passa a noite aberta)', () => {
  const r = cenario({ hora: 22, lojaAberta: true });
  assert.strictEqual(r.acao, 'fechar');
});

console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
