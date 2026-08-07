'use strict';

// Imprime um cupom de teste com dados fictícios. Rode ANTES de deixar o agente
// no ar — assim você descobre problema de nome, cabo ou acento agora, e não no
// primeiro pedido de verdade.
//
//   Clique duas vezes em IMPRIMIR-TESTE.bat  (ou: npm run teste)

require('dotenv').config();

const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
const { imprimirRaw, listarImpressoras, conferirImpressora } = require('./impressora-windows');

const {
  PRINTER_INTERFACE,
  PRINTER_TIPO = 'EPSON',
  PRINTER_LARGURA = '48',
} = process.env;

const linha = (t = '') => console.log(t);

(async () => {
  linha();
  linha('══════════════════════════════════════════');
  linha('  TESTE DE IMPRESSÃO — RESTAURANTE CHAPELÃO');
  linha('══════════════════════════════════════════');
  linha();

  // Sem configuração ainda? Mostra as impressoras e já entrega a linha pronta
  // pra colar no .env. É o passo em que quase todo mundo trava.
  if (!PRINTER_INTERFACE) {
    linha('⚠️  O arquivo .env ainda não tem a impressora configurada.');
    linha();
    try {
      const lista = await listarImpressoras();
      if (!lista.length) {
        linha('❌ Nenhuma impressora instalada neste computador.');
        linha('   Ligue a térmica no USB e instale o driver dela primeiro.');
      } else {
        linha('🖨️  Impressoras instaladas neste computador:');
        linha();
        lista.forEach((n, i) => linha(`   ${i + 1}. ${n}`));
        linha();
        linha('👉 Abra o arquivo .env e escreva a linha abaixo, trocando o nome');
        linha('   pelo da sua térmica (copie exatamente como aparece acima):');
        linha();
        linha(`   PRINTER_INTERFACE=windows:${lista[0]}`);
      }
    } catch (e) {
      linha(`❌ Não consegui listar as impressoras: ${e.message}`);
    }
    linha();
    process.exit(1);
  }

  const modoWindows = PRINTER_INTERFACE.toLowerCase().startsWith('windows:');
  const nomeWindows = modoWindows ? PRINTER_INTERFACE.slice('windows:'.length).trim() : null;

  linha(`→ Configuração: ${PRINTER_INTERFACE}`);
  linha(`→ Perfil: ${PRINTER_TIPO} · ${PRINTER_LARGURA} colunas`);
  linha();

  if (modoWindows) {
    const { existe, lista, parecida } = await conferirImpressora(nomeWindows);
    if (!existe) {
      linha(`❌ Não existe impressora chamada "${nomeWindows}" neste computador.`);
      linha();
      linha('🖨️  As instaladas são:');
      lista.forEach((n, i) => linha(`   ${i + 1}. ${n}`));
      linha();
      if (parecida) {
        linha('👉 Provavelmente é esta. Coloque no .env:');
        linha();
        linha(`   PRINTER_INTERFACE=windows:${parecida}`);
      } else {
        linha('👉 Copie o nome exato de uma delas para o .env, assim:');
        linha();
        linha(`   PRINTER_INTERFACE=windows:${lista[0] || 'NOME DA IMPRESSORA'}`);
      }
      linha();
      process.exit(1);
    }
    linha('✅ Impressora encontrada no Windows.');
  }

  const printer = new ThermalPrinter({
    type: PrinterTypes[PRINTER_TIPO.toUpperCase()] || PrinterTypes.EPSON,
    interface: modoWindows ? 'tcp://127.0.0.1:9100' : PRINTER_INTERFACE,
    characterSet: CharacterSet.PC860_PORTUGUESE,
    removeSpecialCharacters: false,
    width: Number(PRINTER_LARGURA),
    options: { timeout: 5000 },
  });

  if (!modoWindows) {
    const conectada = await printer.isPrinterConnected();
    if (!conectada) {
      linha('❌ A impressora não respondeu.');
      linha('   Confira: está ligada? o IP está certo? o computador enxerga ela na rede?');
      process.exit(1);
    }
    linha('✅ Impressora respondeu.');
  }

  linha('→ Enviando cupom de teste...');

  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.println('RESTAURANTE CHAPELAO');
  printer.setTextNormal();
  printer.bold(false);
  printer.println('TESTE DE IMPRESSAO');
  printer.drawLine();

  printer.alignLeft();
  printer.println('Acentuacao: ação, pão, feijão, café');
  printer.drawLine();

  printer.leftRight('2x Marmitex Media', 'R$ 53,00');
  printer.println('   > Carnes: Costela assada, Frango');
  printer.println('   > Acomp.: Arroz, Feijao, Farofa');
  printer.leftRight('1x Coca-Cola Lata 350ml', 'R$ 6,00');
  printer.drawLine();

  printer.leftRight('Subtotal', 'R$ 59,00');
  printer.leftRight('Taxa de entrega', 'R$ 11,00');
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.leftRight('TOTAL', 'R$ 70,00');
  printer.setTextNormal();
  printer.bold(false);

  printer.drawLine();
  printer.alignCenter();
  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println('PAGAMENTO: DINHEIRO');
  printer.bold(false);
  printer.setTextNormal();
  printer.println('Cliente paga com R$ 100,00');
  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println('LEVAR TROCO: R$ 30,00');
  printer.bold(false);
  printer.setTextNormal();
  printer.drawLine();

  printer.alignCenter();
  printer.println('Se voce esta lendo isto no papel,');
  printer.println('esta tudo funcionando.');
  printer.newLine();
  printer.cut();

  if (modoWindows) {
    await imprimirRaw(nomeWindows, printer.getBuffer());
  } else {
    await printer.execute();
  }

  linha();
  linha('✅ Cupom enviado! Confira o papel.');
  linha();
  linha('   Saiu tudo certo?  → feche esta janela e rode INICIAR.bat');
  linha('   Acentos errados?  → me avise, é só trocar uma linha');
  linha('   Não saiu nada?    → confira se tem papel e se a tampa está fechada');
  linha();
})().catch((err) => {
  linha();
  linha(`❌ Erro: ${err.message}`);
  linha();
  process.exit(1);
});
