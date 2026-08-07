'use strict';

// Imprime um cupom de teste com dados fictícios. Rode ANTES de colocar o
// agente pra valer — assim você descobre problema de cabo, IP ou acento
// agora, e não no primeiro pedido de verdade.
//
//   npm run teste

require('dotenv').config();

const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');

const {
  PRINTER_INTERFACE,
  PRINTER_TIPO = 'EPSON',
  PRINTER_LARGURA = '48',
} = process.env;

if (!PRINTER_INTERFACE) {
  console.error('✗ Falta PRINTER_INTERFACE no .env (ex: tcp://192.168.0.87:9100)');
  process.exit(1);
}

(async () => {
  const printer = new ThermalPrinter({
    type: PrinterTypes[PRINTER_TIPO.toUpperCase()] || PrinterTypes.EPSON,
    interface: PRINTER_INTERFACE,
    characterSet: CharacterSet.PC860_PORTUGUESE,
    removeSpecialCharacters: false,
    width: Number(PRINTER_LARGURA),
    options: { timeout: 5000 },
  });

  console.log(`→ Testando ${PRINTER_INTERFACE} (${PRINTER_TIPO}, ${PRINTER_LARGURA} colunas)...`);

  const conectada = await printer.isPrinterConnected();
  if (!conectada) {
    console.error('✗ A impressora não respondeu.');
    console.error('  Confira: está ligada? o IP/nome está certo? o PC enxerga ela na rede?');
    process.exit(1);
  }
  console.log('✓ Impressora respondeu. Enviando cupom de teste...');

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
  printer.println('Cifrao: R$ 11,00');
  printer.drawLine();

  printer.leftRight('2x Marmitex Media', 'R$ 53,00');
  printer.println('   > Carnes: Frango, Bife');
  printer.println('   > Acomp.: Arroz, Feijao, Farofa');
  printer.leftRight('1x Coca-Cola 350ml', 'R$ 6,00');
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
  printer.println('Se voce esta lendo isto,');
  printer.println('a impressao esta funcionando.');
  printer.newLine();
  printer.cut();

  await printer.execute();
  console.log('✓ Cupom enviado! Confira o papel.');
  console.log('  Acentos errados? Troque CharacterSet para PC850_MULTILINGUAL no .env do agente.');
})().catch((err) => {
  console.error('✗ Erro:', err.message);
  process.exit(1);
});
