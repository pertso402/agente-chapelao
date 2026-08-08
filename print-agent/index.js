'use strict';

// ─── AGENTE DE IMPRESSÃO TÉRMICA ──────────────────────────────────────────────
// Roda no PC/mini-PC do restaurante, ao lado da impressora. Faz uma coisa só:
// vigia a tabela `pedidos` no Supabase e imprime o que ainda não foi impresso.
//
// Por que polling e não realtime: a internet de restaurante cai. Com polling,
// a fila fica no banco e o cupom sai assim que a conexão volta — nenhum pedido
// se perde. Realtime perde o evento e ninguém percebe até o cliente ligar.
//
// A reivindicação do pedido é ATÔMICA (UPDATE ... WHERE impresso = false):
// mesmo com duas impressoras/dois PCs rodando este agente, cada pedido sai
// uma vez só.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
const { imprimirRaw, conferirImpressora } = require('./impressora-windows');

const {
  SUPA_URL,
  SUPA_SERVICE_KEY,
  PRINTER_INTERFACE,
  PRINTER_TIPO = 'EPSON',
  PRINTER_LARGURA = '48',
  INTERVALO_MS = '3000',
  MAX_TENTATIVAS = '5',
  VIAS = '1',
  TZ_RESTAURANTE = 'America/Sao_Paulo',
  NOME_RESTAURANTE = 'RESTAURANTE CHAPELAO',
} = process.env;

for (const [k, v] of Object.entries({ SUPA_URL, SUPA_SERVICE_KEY, PRINTER_INTERFACE })) {
  if (!v) {
    console.error(`✗ Falta a variável ${k} no .env — veja print-agent/.env.example`);
    process.exit(1);
  }
}

const sb = createClient(SUPA_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

const log = (nivel, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), nivel, msg, ...extra }));

// ─── IMPRESSORA ───────────────────────────────────────────────────────────────
// Dois modos:
//   windows:NOME DA IMPRESSORA → USB no Windows. Monta o cupom, pega os bytes
//     ESC/POS e manda direto pro spooler (ver impressora-windows.js). Não exige
//     compartilhar a impressora nem compilar módulo nativo.
//   tcp://IP:9100 (ou caminho de arquivo) → impressora de rede. A própria
//     biblioteca faz a conexão.

const MODO_WINDOWS = PRINTER_INTERFACE.toLowerCase().startsWith('windows:');
const NOME_IMPRESSORA_WINDOWS = MODO_WINDOWS ? PRINTER_INTERFACE.slice('windows:'.length).trim() : null;

function novaImpressora() {
  return new ThermalPrinter({
    type: PrinterTypes[PRINTER_TIPO.toUpperCase()] || PrinterTypes.EPSON,
    // No modo Windows a biblioteca só monta o buffer; quem entrega é o
    // spooler. O endereço abaixo nunca chega a ser usado.
    interface: MODO_WINDOWS ? 'tcp://127.0.0.1:9100' : PRINTER_INTERFACE,
    characterSet: CharacterSet.PC860_PORTUGUESE, // acentos do português
    removeSpecialCharacters: false,
    width: Number(PRINTER_LARGURA),
    options: { timeout: 5000 },
  });
}

const fmtBRL = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

function fmtDataHora(iso) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_RESTAURANTE,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

const ROTULO_PAGAMENTO = { pix: 'PIX', dinheiro: 'DINHEIRO', cartao: 'CARTAO' };

// Monta o cupom. Layout pensado para 80mm mas funciona em 58mm (só quebra
// linha mais cedo) — o que importa é a informação que a cozinha e o entregador
// precisam, em ordem de urgência.
function montarCupom(printer, pedido, itens, cliente) {
  printer.alignCenter();
  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println(NOME_RESTAURANTE);
  printer.bold(false);
  printer.setTextNormal();
  printer.println('WhatsApp / Delivery');
  printer.drawLine();

  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println(`PEDIDO #${pedido.numero_pedido}`);
  printer.bold(false);
  printer.setTextNormal();

  const ehDelivery = pedido.tipo_entrega === 'delivery';
  printer.setTextSize(1, 0);
  printer.println(ehDelivery ? '** ENTREGA **' : '** RETIRADA **');
  printer.setTextNormal();
  printer.println(fmtDataHora(pedido.created_at));
  printer.drawLine();

  // ── Cliente ──
  printer.alignLeft();
  printer.bold(true);
  printer.println(`CLIENTE: ${(cliente?.nome || 'Nao informado').toUpperCase()}`);
  printer.bold(false);
  if (cliente?.telefone) printer.println(`FONE: ${formatarTelefone(cliente.telefone)}`);

  if (ehDelivery && pedido.endereco_entrega) {
    printer.println('');
    printer.bold(true);
    printer.println('ENDERECO:');
    printer.bold(false);
    for (const linha of quebrar(pedido.endereco_entrega, Number(PRINTER_LARGURA))) {
      printer.println(linha);
    }
  }
  printer.drawLine();

  // ── Itens ──
  printer.bold(true);
  printer.println('ITENS');
  printer.bold(false);
  printer.println('');

  for (const it of itens) {
    printer.setTextSize(1, 0);
    printer.bold(true);
    printer.leftRight(
      `${it.quantidade}x ${it.nome_produto}`.slice(0, Number(PRINTER_LARGURA) - 12),
      fmtBRL(it.total),
    );
    printer.bold(false);
    printer.setTextNormal();

    // Carnes e acompanhamentos da marmitex — a linha que a cozinha realmente lê
    if (it.observacao) {
      for (const linha of quebrar(`   > ${it.observacao}`, Number(PRINTER_LARGURA))) {
        printer.println(linha);
      }
    }
    printer.println('');
  }

  printer.drawLine();

  // ── Valores ──
  printer.leftRight('Subtotal', fmtBRL(pedido.subtotal));
  if (Number(pedido.taxa_entrega) > 0) printer.leftRight('Taxa de entrega', fmtBRL(pedido.taxa_entrega));
  if (Number(pedido.desconto) > 0)     printer.leftRight('Desconto', `-${fmtBRL(pedido.desconto)}`);

  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.leftRight('TOTAL', fmtBRL(pedido.total));
  printer.bold(false);
  printer.setTextNormal();

  // ── Pagamento ──
  // Bloco próprio, em corpo grande e cercado por linhas: é a informação que
  // mais gera confusão na porta do cliente. Em dinheiro, o troco a levar sai
  // JÁ CALCULADO — ninguém faz conta de cabeça segurando marmita.
  printer.drawLine();
  printer.alignCenter();
  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println(`PAGAMENTO: ${ROTULO_PAGAMENTO[pedido.forma_pagamento] || String(pedido.forma_pagamento || '').toUpperCase()}`);
  printer.bold(false);
  printer.setTextNormal();

  if (pedido.forma_pagamento === 'dinheiro') {
    const trocoPara = Number(pedido.troco_para);
    if (Number.isFinite(trocoPara) && trocoPara > 0) {
      printer.println(`Cliente paga com ${fmtBRL(trocoPara)}`);
      printer.setTextSize(1, 1);
      printer.bold(true);
      printer.println(`LEVAR TROCO: ${fmtBRL(trocoPara - Number(pedido.total))}`);
      printer.bold(false);
      printer.setTextNormal();
    } else if (trocoPara === 0) {
      printer.setTextSize(1, 0);
      printer.println('CLIENTE TEM O VALOR CERTO');
      printer.setTextNormal();
    } else {
      // Pedido antigo ou criado sem a pergunta do troco: avisa em vez de
      // deixar o entregador descobrir na porta.
      printer.setTextSize(1, 0);
      printer.bold(true);
      printer.println('!! TROCO NAO INFORMADO !!');
      printer.bold(false);
      printer.setTextNormal();
    }
  } else if (pedido.forma_pagamento === 'pix') {
    printer.println('PIX confirmado no atendimento');
  } else if (pedido.forma_pagamento === 'cartao') {
    printer.println('LEVAR MAQUININHA');
  }
  printer.drawLine();

  if (pedido.observacao) {
    printer.drawLine();
    printer.alignLeft();
    printer.bold(true);
    printer.println('OBSERVACAO:');
    printer.bold(false);
    for (const linha of quebrar(pedido.observacao, Number(PRINTER_LARGURA))) printer.println(linha);
  }

  printer.alignCenter();
  printer.println('');
  printer.println('Obrigado pela preferencia!');
  printer.newLine();
  printer.cut();
}

function quebrar(texto, largura) {
  const palavras = String(texto).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((atual + ' ' + p).trim().length > largura) {
      if (atual) linhas.push(atual);
      atual = p;
    } else {
      atual = (atual + ' ' + p).trim();
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

function formatarTelefone(tel) {
  const d = String(tel).replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel;
}

async function imprimirPedido(pedido, itens, cliente) {
  const printer = novaImpressora();

  if (!MODO_WINDOWS) {
    const conectada = await printer.isPrinterConnected();
    if (!conectada) throw new Error(`Impressora não respondeu em ${PRINTER_INTERFACE}`);
  }

  for (let via = 0; via < Math.max(1, Number(VIAS)); via++) {
    montarCupom(printer, pedido, itens, cliente);
  }

  if (MODO_WINDOWS) {
    await imprimirRaw(NOME_IMPRESSORA_WINDOWS, printer.getBuffer());
  } else {
    await printer.execute();
  }
  printer.clear();
}

// ─── FILA ─────────────────────────────────────────────────────────────────────

// Reivindica UM pedido de forma atômica.
//
// Primeiro lista candidatos, depois tenta marcar UM com
// `UPDATE ... WHERE id = X AND impresso = false RETURNING *`. A condição
// `impresso = false` dentro do UPDATE é o que garante exclusividade: se dois
// agentes (dois PCs, duas impressoras) listarem o mesmo pedido, só um recebe
// linha de volta — o outro segue para o próximo candidato. Sem isso, o mesmo
// pedido sairia impresso duas vezes.
async function reivindicarPedido() {
  const { data: candidatos, error } = await sb
    .from('pedidos')
    .select('id')
    .eq('impresso', false)
    .lt('impressao_tentativas', Number(MAX_TENTATIVAS))
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) throw new Error(`Supabase/listarPedidosPendentes: ${error.message}`);
  if (!candidatos?.length) return null;

  for (const { id } of candidatos) {
    const { data: reivindicados, error: uErr } = await sb
      .from('pedidos')
      .update({ impresso: true, impresso_em: new Date().toISOString() })
      .eq('id', id)
      .eq('impresso', false) // ← perde a corrida quem chegar depois
      .select('*');

    if (uErr) throw new Error(`Supabase/reivindicarPedido: ${uErr.message}`);
    if (reivindicados?.length) return reivindicados[0];
  }

  return null;
}

// Falhou a impressão: devolve pra fila e conta a tentativa. Depois de
// MAX_TENTATIVAS o pedido para de ser tentado (impressora quebrada não pode
// travar a fila inteira) e fica visível no ERP pela coluna impressao_erro.
async function devolverParaFila(pedidoId, tentativasAtuais, erro) {
  const { error } = await sb
    .from('pedidos')
    .update({
      impresso: false,
      impresso_em: null,
      impressao_tentativas: (tentativasAtuais || 0) + 1,
      impressao_erro: String(erro).slice(0, 500),
    })
    .eq('id', pedidoId);
  if (error) log('error', 'Falha ao devolver pedido para a fila', { pedidoId, erro: error.message });
}

async function carregarDetalhes(pedido) {
  const [{ data: itens, error: eItens }, { data: cliente }] = await Promise.all([
    sb.from('itens_pedido')
      .select('nome_produto, quantidade, preco_unitario, total, observacao')
      .eq('pedido_id', pedido.id)
      .order('id', { ascending: true }),
    sb.from('clientes').select('nome, telefone').eq('id', pedido.cliente_id).maybeSingle(),
  ]);

  if (eItens) throw new Error(`Supabase/itens_pedido: ${eItens.message}`);
  if (!itens?.length) throw new Error('Pedido sem itens — não imprimo cupom vazio.');

  return { itens, cliente };
}

let rodando = false;

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    // Esvazia a fila inteira a cada ciclo: se chegaram 3 pedidos no intervalo,
    // os 3 saem agora, não um a cada 3 segundos.
    for (;;) {
      const pedido = await reivindicarPedido();
      if (!pedido) break;

      log('info', 'Imprimindo pedido', { numero_pedido: pedido.numero_pedido });
      try {
        const { itens, cliente } = await carregarDetalhes(pedido);
        await imprimirPedido(pedido, itens, cliente);
        log('info', '✅ Pedido impresso', { numero_pedido: pedido.numero_pedido, total: pedido.total });
      } catch (err) {
        log('error', '❌ Falha ao imprimir', {
          numero_pedido: pedido.numero_pedido,
          tentativa: (pedido.impressao_tentativas || 0) + 1,
          erro: err.message,
        });
        await devolverParaFila(pedido.id, pedido.impressao_tentativas, err.message);
        break; // impressora provavelmente está fora — espera o próximo ciclo
      }
    }
  } catch (err) {
    log('error', 'Erro no ciclo do agente de impressão', { erro: err.message });
  } finally {
    rodando = false;
  }
}

// ─── START ────────────────────────────────────────────────────────────────────

(async () => {
  log('info', '🖨️  Agente de impressão Chapelão iniciando', {
    interface: PRINTER_INTERFACE,
    tipo: PRINTER_TIPO,
    largura: PRINTER_LARGURA,
    intervalo_ms: Number(INTERVALO_MS),
    vias: Number(VIAS),
  });

  try {
    if (MODO_WINDOWS) {
      const { existe, lista, parecida } = await conferirImpressora(NOME_IMPRESSORA_WINDOWS);
      if (existe) {
        log('info', `✅ Impressora "${NOME_IMPRESSORA_WINDOWS}" encontrada no Windows`);
      } else {
        // Nome errado é o erro nº 1 aqui (um acento, um espaço a mais). Em vez
        // de só falhar, mostramos a lista real pra pessoa copiar e colar.
        log('error', `❌ Não existe impressora chamada "${NOME_IMPRESSORA_WINDOWS}" neste computador.`);
        log('error', `   Impressoras instaladas: ${lista.join(' | ') || '(nenhuma)'}`);
        if (parecida) log('error', `   Você quis dizer: PRINTER_INTERFACE=windows:${parecida}`);
        log('error', '   Corrija o arquivo .env e inicie de novo.');
      }
    } else {
      const ok = await novaImpressora().isPrinterConnected();
      log(ok ? 'info' : 'warn', ok ? '✅ Impressora respondeu' : '⚠️  Impressora NÃO respondeu — vou seguir tentando a cada ciclo');
    }
  } catch (err) {
    log('warn', '⚠️  Não consegui testar a impressora agora', { erro: err.message });
  }

  setInterval(ciclo, Number(INTERVALO_MS));
  ciclo();
})();

process.on('SIGINT', () => { log('info', 'Encerrando agente de impressão'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Encerrando agente de impressão'); process.exit(0); });
