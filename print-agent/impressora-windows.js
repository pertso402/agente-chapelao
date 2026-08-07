'use strict';

// ─── IMPRESSÃO USB NO WINDOWS ─────────────────────────────────────────────────
// Impressora térmica ligada por cabo USB num notebook Windows.
//
// Os dois caminhos "normais" dão trabalho:
//   - pacote `printer` do npm: módulo nativo, exige Visual Studio Build Tools.
//   - `//localhost/COMPARTILHAMENTO`: exige compartilhar a impressora na rede.
//
// Aqui o caminho é outro: mandamos os bytes ESC/POS direto pro spooler do
// Windows (winspool.drv), o mesmo componente que o Bloco de Notas usa pra
// imprimir. Não precisa compilar nada e não precisa compartilhar nada — basta
// o nome que aparece em "Impressoras e scanners".
//
// O tipo de dado é RAW: o Windows repassa os bytes sem interpretar, que é
// exatamente o que uma térmica ESC/POS espera. Se fosse "TEXT", o driver
// tentaria formatar e os comandos de corte/negrito virariam sujeira no papel.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public class ImpressoraRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter")]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter")]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void Enviar(string impressora, string arquivo) {
    byte[] bytes = File.ReadAllBytes(arquivo);
    IntPtr hPrinter;
    if (!OpenPrinter(impressora, out hPrinter, IntPtr.Zero))
      throw new Exception("Nao consegui abrir a impressora '" + impressora + "' (erro " + Marshal.GetLastWin32Error() + ")");

    DOCINFO di = new DOCINFO();
    di.pDocName = "Pedido Chapelao";
    di.pDataType = "RAW";

    try {
      if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter falhou");
      try {
        if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter falhou");
        IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buf, bytes.Length);
          int escritos;
          if (!WritePrinter(hPrinter, buf, bytes.Length, out escritos))
            throw new Exception("WritePrinter falhou");
        } finally { Marshal.FreeCoTaskMem(buf); }
        EndPagePrinter(hPrinter);
      } finally { EndDocPrinter(hPrinter); }
    } finally { ClosePrinter(hPrinter); }
  }
}
'@
[ImpressoraRaw]::Enviar($env:CHAPELAO_IMPRESSORA, $env:CHAPELAO_ARQUIVO)
Write-Output "OK"
`;

function rodarPowerShell(script, env) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve(String(stdout || '').trim());
      }
    );
  });
}

// ESC @ = "esqueça tudo e volte ao padrão de fábrica". A biblioteca não
// coloca isso no início do buffer, e sem o reset a impressora herda o estado
// do cupom anterior — um negrito que não foi fechado por causa de uma falha
// no meio do caminho sai carimbado em todos os pedidos seguintes.
const RESET = Buffer.from([0x1B, 0x40]);

// Envia um buffer ESC/POS pronto para uma impressora instalada no Windows.
async function imprimirRaw(nomeImpressora, buffer) {
  buffer = Buffer.concat([RESET, buffer]);
  // Arquivo temporário porque passar binário por linha de comando corrompe
  // os bytes (o PowerShell reinterpreta como texto/UTF-16).
  const arquivo = path.join(os.tmpdir(), `chapelao-${crypto.randomBytes(6).toString('hex')}.bin`);
  await fs.promises.writeFile(arquivo, buffer);
  try {
    await rodarPowerShell(SCRIPT_PS, {
      CHAPELAO_IMPRESSORA: nomeImpressora,
      CHAPELAO_ARQUIVO: arquivo,
    });
  } finally {
    fs.promises.unlink(arquivo).catch(() => {});
  }
}

// Lista as impressoras instaladas — é o que a pessoa precisa pra descobrir o
// nome exato pra colocar no .env (inclusive acentos e espaços).
async function listarImpressoras() {
  const saida = await rodarPowerShell(
    'Get-Printer | Select-Object -ExpandProperty Name'
  ).catch(async () => {
    // Windows mais antigo sem o módulo PrintManagement
    return rodarPowerShell('(Get-WmiObject -Class Win32_Printer).Name');
  });
  return saida.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// Confere se o nome configurado existe de fato, e sugere o mais parecido
// quando alguém erra um acento ou um espaço.
async function conferirImpressora(nome) {
  const lista = await listarImpressoras();
  if (lista.includes(nome)) return { existe: true, lista };

  const alvo = nome.toLowerCase().replace(/\s+/g, '');
  const parecida = lista.find(n => n.toLowerCase().replace(/\s+/g, '').includes(alvo))
    || lista.find(n => /pos|thermal|term|58|80|elgin|bematech|epson|daruma|tanca/i.test(n));

  return { existe: false, lista, parecida };
}

module.exports = { imprimirRaw, listarImpressoras, conferirImpressora };
