# 🖨️ Impressão automática na térmica

Serviço que roda **no notebook do restaurante**, ligado na impressora. Vigia a
tabela `pedidos` e imprime sozinho todo pedido novo.

> Para quem vai instalar na loja: leia o **`LEIA-ME.txt`** — é o mesmo conteúdo
> sem jargão. Este arquivo aqui é a parte técnica.

```
Cliente fecha no WhatsApp
        ↓
Agente grava o pedido no Supabase (impresso = false)
        ↓
Este serviço, no notebook, reivindica o pedido e imprime
        ↓
Marca impresso = true (nunca sai duas vezes)
```

**Por que não imprimir do servidor?** A impressora está num cabo USB em
Umuarama e o agente roda na nuvem. Este serviço é a ponte.

**Por que a fila fica no banco?** Internet de restaurante cai. Com a fila no
banco o pedido espera e sai quando a conexão volta.

---

## Instalação (Windows, impressora USB)

1. Copie esta pasta para o notebook (ex.: `C:\chapelao-impressao`)
2. Instale o [Node.js LTS](https://nodejs.org) — uma vez só
3. Clique em `1-INSTALAR.bat` → `2-IMPRIMIR-TESTE.bat` → `3-INICIAR.bat`

Não precisa compartilhar a impressora, nem cabo de rede, nem build tools.

## Como a impressão USB funciona

Os dois caminhos usuais no Windows dão trabalho: o pacote `printer` do npm é
módulo nativo (exige Visual Studio Build Tools) e o `//localhost/SHARE` exige
compartilhar a impressora na rede.

Aqui o cupom é montado com `node-thermal-printer` (só para gerar os bytes
ESC/POS) e entregue ao **spooler do Windows** via `winspool.drv`, com tipo de
dado `RAW` — os bytes passam sem o driver tentar formatar. Ver
[`impressora-windows.js`](impressora-windows.js).

Basta o nome que aparece em *Impressoras e scanners*:

```
PRINTER_INTERFACE=windows:Elgin i9
```

Impressora de rede continua suportada:

```
PRINTER_INTERFACE=tcp://192.168.0.87:9100
```

## Configuração (`.env`)

| Variável | Para quê |
|---|---|
| `PRINTER_INTERFACE` | `windows:NOME` (USB) ou `tcp://IP:9100` (rede) |
| `PRINTER_TIPO` | `EPSON` (padrão), `STAR`, `DARUMA`, `TANCA` |
| `PRINTER_LARGURA` | `48` para bobina 80mm, `32` para 58mm |
| `VIAS` | Cupons por pedido (2 = cozinha + entregador) |
| `SUPA_URL` / `SUPA_SERVICE_KEY` | Acesso ao banco |
| `INTERVALO_MS` | Frequência da checagem (padrão 3000) |
| `MAX_TENTATIVAS` | Falhas antes de desistir do pedido (padrão 5) |

## Rodar como serviço

O `3-INICIAR.bat` já reinicia sozinho se o processo cair. Para subir junto com
o Windows, coloque um atalho dele em `shell:startup`.

Alternativa com PM2:

```bash
npm install -g pm2 pm2-windows-startup
pm2 start index.js --name chapelao-impressao
pm2 save && pm2-startup install
```

---

## Perguntas frequentes

**Imprime o mesmo pedido duas vezes?**
Não. Cada pedido é reivindicado com `UPDATE ... WHERE impresso = false`: se
dois computadores tentarem ao mesmo tempo, só um ganha a corrida.

**Impressora sem papel / desligada — perdi o pedido?**
Não. Volta pra fila. Após `MAX_TENTATIVAS` para de tentar (pra não travar a
fila) e o motivo fica na coluna `impressao_erro`.

**Reimprimir um pedido?**
No Supabase → `pedidos`, marque `impresso = false` na linha. Sai em segundos.

**Segurança:** o `.env` contém a `SUPA_SERVICE_KEY`, que dá acesso total ao
banco. Ele fica num notebook físico da loja — não copie para pendrive nem use
o notebook em Wi-Fi público.
