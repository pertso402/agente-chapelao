# Deploy no EasyPanel

## 1. Banco de dados — rodar 1 vez
No Supabase → SQL Editor, cole e execute o conteúdo de `supabase/agent_logs.sql`.

## 2. No EasyPanel — criar aplicação
- **Source**: Git repo ou upload do código
- **Build**: Dockerfile (detecta automático)
- **Port**: 3000

## 3. Variáveis de ambiente (adicionar no EasyPanel)
```
SUPA_URL=https://qlswjefuinhbtlhauhgj.supabase.co
SUPA_KEY=<anon key>
SUPA_SERVICE_KEY=<service role key>
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
EVOLUTION_URL=https://sua-evolution-api.com
EVOLUTION_KEY=sua-key
EVOLUTION_INSTANCE=chapelao
PORT=3000
```

## 4. Evolution API — configurar webhook
Na sua instância Evolution API:
```
URL do webhook: https://SEU-DOMINIO-EASYPANEL.com/webhook
Eventos: messages.upsert
```

## 5. Verificar se está funcionando
```
GET https://SEU-DOMINIO/health
→ { "status": "ok", "agente": "Chapelão" }
```

---

## Onde ver os logs / erros

### Opção A — EasyPanel (logs em tempo real)
- Painel EasyPanel → sua app → aba **Logs**
- Cada linha é JSON estruturado, ex:
  ```json
  {"ts":"2025-06-14T10:00:00Z","nivel":"error","etapa":"tool/criar_pedido/erro","mensagem":"Supabase/criarPedido: ...","telefone":"5511999999999","requestId":"a1b2c3d4"}
  ```

### Opção B — Supabase (erros persistidos)
- Dashboard Supabase → **Table Editor → agent_logs**
- Filtre por `nivel = 'error'` para ver só os erros
- Cada erro tem: telefone do cliente, etapa onde falhou, mensagem e stack trace

### Leitura dos logs
Cada entrada tem:
| Campo | Significado |
|-------|-------------|
| `requestId` | ID único por mensagem recebida — agrupe por ele para ver o fluxo completo |
| `etapa` | Onde está no fluxo (ex: `tool/criar_pedido/erro`, `midia/audio/transcrevendo`) |
| `telefone` | Qual cliente causou o erro |
| `mensagem` | Descrição do erro |
| `erro_stack` | Stack trace completo para debug |

### Fluxo de etapas (em ordem)
```
webhook/recebido
midia/audio/download        ← só se for áudio
midia/audio/transcrevendo   ← só se for áudio
midia/imagem/download       ← só se for imagem
midia/imagem/analisando     ← só se for imagem
historico/carregando
agente/chamando-claude
tool/<nome>/               ← uma por tool chamada
agente/resposta-ok
whatsapp/enviando
historico/salvo
```
Se o log parar em alguma etapa = erro aconteceu nela.
