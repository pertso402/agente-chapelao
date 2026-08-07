# 🖨️ Impressão automática na térmica

Serviço que roda **no PC do restaurante**, ao lado da impressora. Ele vigia a
tabela `pedidos` e imprime sozinho todo pedido novo — ninguém precisa clicar
em nada.

```
Cliente fecha no WhatsApp
        ↓
Agente grava o pedido no Supabase (impresso = false)
        ↓
Este serviço, no PC da loja, vê o pedido e imprime
        ↓
Marca impresso = true (nunca sai duas vezes)
```

**Por que não imprimir direto do servidor?** Porque a impressora está na
cozinha e o agente roda na nuvem (EasyPanel) — a nuvem não alcança um cabo USB
em Umuarama. Este serviço é a ponte, e é ele que precisa estar na mesma rede
da impressora.

**Por que a fila fica no banco?** Internet de restaurante cai. Com a fila no
banco, o pedido espera e sai assim que a conexão volta. Nada se perde.

---

## Passo 1 — Rodar a SQL (uma vez só)

No Supabase → SQL Editor, cole e execute o conteúdo de
[`../supabase/impressao.sql`](../supabase/impressao.sql). Ela cria as colunas
de controle na tabela `pedidos`.

## Passo 2 — Instalar no PC da loja

Precisa de [Node.js 18+](https://nodejs.org) instalado. Depois, no terminal:

```bash
cd print-agent
npm install
```

## Passo 3 — Configurar

Copie o exemplo e edite:

```bash
copy .env.example .env
```

O único campo que costuma dar trabalho é o `PRINTER_INTERFACE`:

| Como a impressora está ligada | O que colocar |
|---|---|
| **Rede/Ethernet** (recomendado) | `tcp://192.168.0.87:9100` — troque pelo IP dela |
| **USB no Windows** | `//localhost/TERMICA` — compartilhe a impressora com um nome **sem espaços** |
| **USB no Linux** | `/dev/usb/lp0` |

> Para descobrir o IP de uma impressora de rede: desligue, segure o botão
> **FEED** e ligue — ela imprime uma folha de autoteste com o IP.

Bobina de 58mm? Troque `PRINTER_LARGURA=48` para `32`.

## Passo 4 — Testar antes de valer

```bash
npm run teste
```

Sai um cupom de teste com acentos e valores. Se os acentos vierem errados,
troque `CharacterSet.PC860_PORTUGUESE` por `PC850_MULTILINGUAL` no
`teste-impressora.js` e no `index.js`.

## Passo 5 — Deixar rodando sempre

```bash
npm start
```

Para o serviço subir sozinho quando o PC ligar (e reiniciar se travar), use o
**PM2**:

```bash
npm install -g pm2 pm2-windows-startup
pm2 start index.js --name chapelao-impressao
pm2 save
pm2-startup install
```

Comandos do dia a dia:

```bash
pm2 logs chapelao-impressao     # ver o que está acontecendo
pm2 restart chapelao-impressao  # reiniciar
pm2 status                      # está rodando?
```

---

## Perguntas frequentes

**Vai imprimir o mesmo pedido duas vezes?**
Não. Cada pedido é reivindicado com um `UPDATE ... WHERE impresso = false`: se
dois PCs tentarem ao mesmo tempo, só um ganha. Pode rodar em quantos
computadores quiser.

**A impressora ficou sem papel / desligada. Perdi o pedido?**
Não. Ele volta pra fila e sai quando a impressora voltar. Depois de 5
tentativas ele para de ser tentado (pra não travar a fila) e o motivo fica
gravado na coluna `impressao_erro` da tabela `pedidos`.

**Quero uma via pra cozinha e outra pro entregador.**
`VIAS=2` no `.env`.

**Quero reimprimir um pedido.**
No Supabase → Table Editor → `pedidos`, marque `impresso` como `false` na
linha do pedido. Ele sai de novo em segundos.

**Duas impressoras (cozinha e balcão)?**
Rode este serviço duas vezes com `PRINTER_INTERFACE` diferente — mas atenção:
cada pedido sai em **uma** delas, não nas duas (a trava anti-duplicação impede).
Para imprimir nas duas, copie a pasta e troque a condição de reivindicação —
me chame que eu ajusto.

**Segurança:** o `.env` contém a `SUPA_SERVICE_KEY`, que dá acesso total ao
banco. Ele fica num PC físico da loja — não copie para pendrive, não mande por
WhatsApp e não coloque esse PC em rede pública.
