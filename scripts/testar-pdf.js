'use strict';

// Comprovante em PDF: Nubank, Itaú e Caixa mandam o comprovante como ARQUIVO,
// não como foto. Até aqui o agente respondia "só consigo conferir em foto" —
// trabalho jogado em cima de quem já pagou e já mandou a prova.
//
// O que este arquivo trava:
//   1. a extração de texto funciona de verdade num PDF (não só "a lib carrega");
//   2. o valor sai EXATO, com o separador decimal brasileiro;
//   3. PDF sem camada de texto (escaneado) falha com `semTexto`, que é o único
//      caso em que ainda faz sentido pedir a foto.
//
//   npm run test:pdf

process.env.SUPA_URL = 'https://falso.supabase.co';
process.env.SUPA_SERVICE_KEY = 'falso';
process.env.OPENAI_API_KEY = 'sk-falso';

const assert = require('assert');

// ─── Gera um PDF de verdade, com xref válido ─────────────────────────────────
function pdfComTexto(linhas) {
  const conteudo =
    'BT /F1 11 Tf 40 700 Td 14 TL\n' +
    linhas.map(l => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    '\nET';

  const objetos = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(conteudo)}>>\nstream\n${conteudo}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((corpo, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${corpo}\nendobj\n`;
  });

  const inicioXref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objetos.length + 1}/Root 1 0 R>>\nstartxref\n${inicioXref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1').toString('base64');
}

// OpenAI falso: devolve o que o modelo devolveria lendo o texto do comprovante.
const caminhoOpenai = require.resolve('openai');
require.cache[caminhoOpenai] = {
  id: caminhoOpenai, filename: caminhoOpenai, loaded: true,
  exports: class {
    constructor() {
      this.chat = {
        completions: {
          create: async ({ messages }) => {
            ultimoPrompt = messages[0].content;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    eh_comprovante: true, confianca: 'alta', valor: 34.0,
                    data_hora: '15/09/2026 11:39:12',
                    destinatario: 'Levi Jose de Oliveira', remetente: 'BRUNO OLIVEIRA',
                    instituicao: 'Nubank', descricao: 'Comprovante de Pix concluido',
                  }),
                },
              }],
            };
          },
        },
      };
    }
  },
};

let ultimoPrompt = '';
const { analisarPdf } = require('../src/services/media');

let passou = 0;
async function teste(nome, fn) {
  try { await fn(); passou++; console.log(`  ✅ ${nome}`); }
  catch (err) { console.error(`  ❌ ${nome}\n     ${err.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('\n🎩 Comprovante em PDF é lido, não devolvido ao cliente\n');

  await teste('ESTE É O CASO REAL: comprovante do Nubank em PDF é lido', async () => {
    const base64 = pdfComTexto([
      'Comprovante de transferencia',
      'Valor: R$ 34,00',
      'Data: 15/09/2026 - 11:39:12',
      'Destinatario: Levi Jose de Oliveira',
      'Instituicao: Nubank',
    ]);

    const r = await analisarPdf(base64);
    assert.strictEqual(r.isComprovante, true, 'não reconheceu o comprovante');
    assert.strictEqual(r.valor, 34, `valor errado: ${r.valor}`);
    assert.ok(/34,00/.test(r.analise), `a análise precisa citar o valor: ${r.analise}`);
  });

  await teste('o texto do PDF chega ao modelo (não foi só a lib rodar)', async () => {
    assert.ok(/TEXTO DO PDF/.test(ultimoPrompt), 'o prompt não trouxe o bloco do PDF');
    assert.ok(/R\$ 34,00/.test(ultimoPrompt), `o valor extraído não chegou ao modelo:\n${ultimoPrompt.slice(-300)}`);
    assert.ok(/Nubank/.test(ultimoPrompt), 'a instituição não foi extraída do PDF');
  });

  await teste('o modelo é avisado de que texto extraído não fica "borrado"', async () => {
    // Sem isso, ele usa confiança "baixa" alegando imagem cortada — e um
    // comprovante perfeitamente legível vira caso de atendente à toa.
    assert.ok(/não use confiança "baixa" alegando que está borrado/i.test(ultimoPrompt),
      'falta a instrução que impede a desconfiança herdada da leitura de imagem');
  });

  await teste('PDF escaneado (sem texto) pede foto em vez de estourar', async () => {
    const vazio = pdfComTexto([]);
    await assert.rejects(
      () => analisarPdf(vazio),
      (err) => err.semTexto === true,
      'PDF sem camada de texto tinha que sinalizar semTexto, que é o único caso de pedir foto'
    );
  });

  await teste('arquivo corrompido também cai em semTexto, não em erro técnico', async () => {
    await assert.rejects(
      () => analisarPdf(Buffer.from('isto nao e um pdf').toString('base64')),
      (err) => err.semTexto === true,
      'arquivo ilegível tinha que pedir foto, não escalar pra atendente'
    );
  });

  console.log(`\n${process.exitCode ? '❌ FALHOU' : `✅ ${passou} testes passaram`}\n`);
  process.exit(process.exitCode || 0);
})();
