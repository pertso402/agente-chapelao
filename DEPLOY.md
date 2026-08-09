# Deploy — Agente Chapelão v3.1

O sistema tem **duas partes**:

| Parte | Onde roda | Para quê |
|---|---|---|
| **Agente** (`src/`) | Nuvem (EasyPanel) | Atende o cliente no WhatsApp e grava o pedido |
| **Agente de impressão** (`print-agent/`) | PC do restaurante | Imprime o pedido na térmica |

A impressora está na cozinha e o agente roda na nuvem — a nuvem não alcança um
cabo USB em Umuarama. Por isso a impressão é um serviço separado, na mesma rede
da impressora. Instruções dele: [`print-agent/README.md`](print-agent/README.md).

---

## 1. Banco de dados — rodar uma vez

No Supabase → SQL Editor, execute **na ordem**:

| Arquivo | O que cria |
|---|---|
| `supabase/agent_logs.sql` | Tabela de logs/erros do agente |
| `supabase/pedido_rascunho.sql` | Estado do pedido entre mensagens |
| `supabase/atendimento.sql` | Alertas do painel + pausa de 10 min |
| `supabase/impressao.sql` | Fila de impressão na tabela `pedidos` |

## 2. EasyPanel — criar/atualizar a aplicação

- **Source**: repositório Git
- **Build**: Dockerfile (detecta automático)
- **Port**: 3000

## 3. Variáveis de ambiente

```
SUPA_URL=https://qlswjefuinhbtlhauhgj.supabase.co
SUPA_KEY=<anon key>
SUPA_SERVICE_KEY=<service role key>

OPENAI_API_KEY=sk-...               # agente + comprovante PIX + áudio

EVOLUTION_URL=https://sua-evolution-api.com
EVOLUTION_KEY=sua-key
EVOLUTION_INSTANCE=chapelao

TAXA_ENTREGA=11
FRETE_GRATIS_ACIMA_DE=40
PAUSA_ATENDENTE_MIN=10
TZ_RESTAURANTE=America/Sao_Paulo

PORT=3000
```

> O agente roda em **OpenAI GPT-5.6 Terra**. A única variável obrigatória que
> você precisa conferir no EasyPanel além das que já existiam é `TAXA_ENTREGA=11`.
> Todo o resto tem padrão no código.

## 4. Evolution API — webhook

```
URL: https://SEU-DOMINIO-EASYPANEL.com/webhook
Eventos: messages.upsert
```

## 5. Conferir se subiu

```
GET https://SEU-DOMINIO/health
```

```json
{
  "status": "ok",
  "agente": "Chapelão v3",
  "modelo": { "configurado": "gpt-5.6-terra", "em_uso": "gpt-5.6-terra",
              "usando_effort": true, "param_tokens": "max_completion_tokens" },
  "atendimento": { "horario": "de segunda a sábado, das 11h às 14h",
                   "aberto_agora": true, "hora_local": "12:30" },
  "vars": { "supa": true, "openai": true, "evolution": true }
}
```

| Campo | O que olhar |
|---|---|
| `agente` | Tem que ser `Chapelão v3`. Se vier `v2`, o deploy não pegou. |
| `modelo.em_uso` | Se estiver diferente de `configurado`, a conta OpenAI não tem acesso ao modelo novo e o fallback entrou. Funciona igual, mas vale corrigir. |
| `atendimento.aberto_agora` | Reflete o botão do painel. |
| `vars` | Qualquer `false` = variável faltando. |

---

## O botão "Aberta / Fechada" do painel

É a **chave mestra** do atendimento automático. O agente lê esse valor a cada
mensagem recebida:

| Botão | O que o cliente recebe no WhatsApp |
|---|---|
| 🟢 **Aberta** | Atendimento normal — mesmo fora das 11h–14h |
| 🔴 **Fechada** | Mensagem educada com o horário, sem montar pedido |

O horário age sobre o **botão**, não sobre a conversa:

- **11h**, de segunda a sábado → liga o botão sozinho
- **depois das 14h** → desliga o botão sozinho

Cada uma dessas ações acontece **no máximo uma vez por dia**. É isso que faz a
automação ser útil em vez de atrapalhar:

- Fechou ao meio-dia porque acabou a comida? **Não reabre sozinho.**
- Abriu às 9h para testar? **Não fecha na sua cara** — só depois das 14h.

Para testar o atendimento fora do horário, é só clicar em **Aberta** no painel.
Não precisa mexer em variável nem publicar nada. E se esquecer ligado, o
sistema desliga depois das 14h.

---

## Mudar a taxa de entrega ou o piso do frete grátis

Só existe **um** lugar: a variável `TAXA_ENTREGA` (ou o valor padrão em
`src/config.js`). Ela alimenta ao mesmo tempo o resumo que o cliente lê, o
pedido gravado no banco e o cupom impresso — não tem como um mostrar um valor
e o outro cobrar outro. O campo `taxa_entrega` da tabela `info_restaurante` é
ignorado de propósito.

Depois de mudar, confirme com:

```bash
npm run test:precos
```

---

## Onde ver logs e erros

### EasyPanel (tempo real)
Painel → sua app → aba **Logs**. Cada linha é JSON:

```json
{"ts":"2026-08-07T14:00:00Z","nivel":"error","etapa":"pix/valor-divergente",
 "telefone":"5544...","requestId":"a1b2c3d4"}
```

### Supabase (erros persistidos)
Table Editor → `agent_logs`, filtre por `nivel = 'error'`.

### Painel de atendimento
Table Editor → `atendimento_alertas` com `status = 'aberto'` — é a fila de
conversas esperando uma pessoa.

### Etapas do fluxo (em ordem)
```
webhook/recebido
midia/audio            ← só áudio
midia/imagem           ← só imagem
estado/ok
pix/comprovante-recebido   ← comprovante PIX
pix/valor-divergente       ← comprovante não bateu com o total
pedido/confirmando-via-SIM
agente/chamando-openai
tool/<nome>
agente/ok
whatsapp/ok
atendente/escalado         ← IA passou a conversa para uma pessoa
```

Log que para numa etapa = erro aconteceu nela.

---

## Rodar local

```bash
npm install
copy .env.example .env     # preencha as chaves
npm run dev
```

Testes de preço (não precisam de chave nem de internet):

```bash
npm run test:precos
```
