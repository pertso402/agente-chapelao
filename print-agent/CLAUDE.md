# Contexto para o Claude Code — Impressão térmica do Chapelão

Este arquivo é lido automaticamente pelo Claude Code quando ele abre esta
pasta. Se você está instalando isto no notebook do restaurante e quer ajuda
do Claude, **não precisa explicar nada** — está tudo aqui.

---

## Onde você está

Notebook do **Restaurante Chapelão** (marmitaria em Umuarama-PR), na cozinha.
Uma impressora térmica ESC/POS está ligada neste computador por **cabo USB**.
A internet é **Wi-Fi comum** (sem cabo de rede).

Este programa vigia os pedidos no Supabase e imprime cada pedido novo.

## Como o sistema inteiro se encaixa

```
Cliente no WhatsApp
      ↓
Agente de atendimento (roda na nuvem, EasyPanel)  ← outro repositório
      ↓
Supabase — tabela `pedidos` com impresso = false
      ↓
ESTE programa, neste notebook → imprime na térmica USB
      ↓
marca impresso = true
```

Painel de pedidos (outro repositório, roda na Vercel) mostra os pedidos pra
equipe e também tem um botão de imprimir próprio, que usa o navegador.
**Este programa aqui é o automático** — não depende de ninguém clicar.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.js` | Laço principal: reivindica pedido, monta o cupom, manda imprimir |
| `impressora-windows.js` | Envia os bytes ESC/POS pro spooler do Windows (winspool.drv, tipo RAW) |
| `teste-impressora.js` | Cupom de teste com dados fictícios |
| `.env` | Configuração real (**contém segredo — nunca commitar, nunca colar em chat**) |
| `1-INSTALAR.bat` / `2-IMPRIMIR-TESTE.bat` / `3-INICIAR.bat` | Atalhos de clique duplo |

## Decisões que já foram tomadas (não desfaça sem motivo)

- **Impressão via spooler do Windows, não via módulo nativo.** O pacote
  `printer` do npm exige Visual Studio Build Tools; o caminho
  `//localhost/COMPARTILHAMENTO` exige compartilhar a impressora na rede.
  Ambos foram descartados de propósito. `node-thermal-printer` é usado só
  para *gerar* os bytes; quem entrega é `impressora-windows.js`.
- **Fila no banco, com polling de 3s.** Não é realtime porque internet de
  restaurante cai: com a fila no banco, o pedido espera e sai quando a conexão
  volta. Realtime perderia o evento em silêncio.
- **Reivindicação atômica** (`UPDATE ... WHERE impresso = false`): garante que
  o mesmo pedido nunca sai duas vezes, mesmo com dois computadores rodando.
- **`ESC @` prefixado em todo cupom**: sem o reset, a impressora herda estado
  do cupom anterior (um negrito não fechado sai carimbado em todos os
  seguintes).
- **Sem emoji no que vai pro papel.** Térmica ESC/POS não tem esses glifos.
  Emoji só na tela do painel.

## Problemas típicos e como resolver

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Não existe impressora chamada X" | Nome no `.env` diferente do real | Rodar `node teste-impressora.js` — ele lista as instaladas e sugere a linha certa |
| Sujeira / símbolos aleatórios no papel | Perfil ESC/POS errado | Trocar `PRINTER_TIPO=EPSON` por `STAR`, depois `DARUMA`, depois `TANCA` |
| Acentos errados (`feijÃ£o`) | Página de código | Em `index.js` e `teste-impressora.js`, trocar `CharacterSet.PC860_PORTUGUESE` por `PC850_MULTILINGUAL` |
| Texto cortado na lateral | Bobina de 58mm | `PRINTER_LARGURA=32` (padrão 48 = 80mm) |
| Não sai nada, sem erro | Papel/tampa/spooler | Conferir papel e tampa; testar página de teste pelo Windows |
| Sai cortado no meio | Buffer grande demais de uma vez | Investigar em `imprimirRaw` |

Para diagnosticar de verdade, o comando mais útil é:

```bash
node teste-impressora.js
```

Ele valida nome da impressora, conexão e imprime um cupom completo com
acentuação, item com observação e bloco de pagamento com troco.

## Regras ao trabalhar aqui

- **Nunca imprima o conteúdo do `.env`** nem cole a `SUPA_SERVICE_KEY` em
  lugar nenhum. Ela dá acesso total ao banco do restaurante.
- **Não altere dados de pedidos** para "testar". Use `teste-impressora.js`,
  que não toca no banco.
- Se precisar testar o laço completo, crie um pedido de teste e apague depois
  — mas prefira não fazer isso em horário de almoço (11h–14h), que é quando a
  loja está no pico.
- Este notebook é da operação. Se algo aqui parar, a cozinha para junto.
  Prefira mudanças pequenas e testáveis a refatorações.

## Estado esperado quando está tudo certo

`3-INICIAR.bat` aberto e minimizado, com uma linha de log a cada ciclo. Quando
chega pedido:

```json
{"ts":"...","nivel":"info","msg":"Imprimindo pedido","numero_pedido":42}
{"ts":"...","nivel":"info","msg":"✅ Pedido impresso","numero_pedido":42,"total":70}
```
