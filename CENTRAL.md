# Central de atendimento Chapelão

Implementação local a partir de especificacao-central-whatsapp.md, no repositório agente-chapelao. Data: 15/10/2026, fuso America/Sao_Paulo.

## Situação da entrega

O código implementa painel React/TypeScript, API Express, worker Node persistente e migração Supabase com RLS. **Ainda não foi aplicado ao Supabase nem publicado no Easypanel.** Nenhum webhook real foi redirecionado e nenhuma mensagem foi enviada aos clientes durante o desenvolvimento.

O agente atual permanece como padrão de inicialização. A central só inicia com CENTRAL_ENABLED=true. A versão legada e seus pollers não são carregados nesse modo. Não execute o agente legado em outro contêiner respondendo aos mesmos números após o corte.

Aproveitou-se o Express do repositório existente em vez de adicionar Next.js. O painel React/TypeScript é compilado por Vite e servido pelo mesmo backend. As transações e os locks de sessão exigem processos Node persistentes; esta implementação não usa hospedagem Sites/Cloudflare Workers.

## Ambiente identificado

| Item                          | Valor / resultado verificado                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Supabase                      | https://qlswjefuinhbtlhauhgj.supabase.co                                                       |
| Chave publicável recebida     | A consulta autenticada à Data API recebeu HTTP 401; precisa ser conferida                      |
| Plugin Supabase               | Sem ferramentas administrativas disponíveis nesta sessão, inclusive após a reconexão informada |
| Evolution                     | https://assistente-evolution-api.b1h6rm.easypanel.host                                         |
| Versão observada da Evolution | 2.3.7, informada pelo endpoint raiz                                                            |
| Instância principal           | Chapela - atendimento; conexão open                                                            |
| Instância secundária          | chapelao; conexão open                                                                         |
| Webhooks atuais               | Habilitados nas duas instâncias, somente MESSAGES_UPSERT, byEvents=false                       |
| Agente atual                  | https://agente-agente-chapelao.b1h6rm.easypanel.host                                           |
| Repositório de origem         | https://github.com/pertso402/agente-chapelao                                                   |

As consultas foram somente leitura. O retorno atual de configuração não confirmou headers de autenticação; ausência desse campo na resposta não prova ausência de suporte. Validar headers na versão instalada antes do corte. Se necessário, usar gateway autenticado. Nunca remover a autenticação do endpoint para contornar isso.

## O que está implementado

- Conversas identificadas por instância + JID, com histórico, ciclo, responsável e epochs persistidos.
- Identificação permanente do WhatsApp de origem; navegador envia texto, nunca escolhe destino.
- Recebimento autenticado que só confirma após gravar o job durável; duplicatas não repetem mensagens ou efeitos.
- Estados ai, waiting_human, human e closed. Controle humano não expira por tempo, reload ou logout.
- Assumir, devolver à fila, devolver à IA, encerrar e transferir, com idempotência e auditoria.
- Configuração da IA por número; reativação não retoma trabalhos antigos nem remove chamados da fila.
- Fila Postgres com leases, SKIP LOCKED, renovação, retentativas limitadas e quarentena.
- Locks de sessão: instância antes da conversa. Pausa global usa lock exclusivo da instância.
- Snapshot de versão conferido depois da geração e antes do despacho. Modelo fora do lock; POST externo dentro da barreira de coordenação, sem transação SQL aberta durante a rede.
- Status real de outbox, tratamento unknown sem retry cego e resolução explícita auditada por administrador.
- Login e recuperação de senha pelo Supabase Auth; membership revalidada no backend; RLS de leitura; sem escrita direta do browser.
- Admin pode desativar/reativar membros. Desativação devolve suas conversas e cancela mensagens pendentes na mesma transação, além de remover sessões Auth. Envios humanos incertos bloqueiam a operação até conferência.
- Painel em português, filas, busca, filtro por número, histórico paginado, mídia com autenticação e rascunho preservado em erro de envio.
- Realtime para atualização e snapshot periódico de 30 segundos como recuperação; alerta sonoro ativado por clique, com aba líder via Web Locks em navegadores compatíveis.
- Página de operação com estado das instâncias, jobs atrasados/falhos/quarentena e mensagens incertas.

## Integração da IA e limites operacionais

O adaptador em src/central/agent.js compartilha as ferramentas existentes buscar_itens_do_dia, buscar_cardapio e info_restaurante. Ele usa exclusivamente o histórico da conversa e do ciclo atual.

**O piloto da central mantém as ferramentas de pedidos, pagamentos, cupons e cancelamentos fora do alcance da IA.** A equipe humana finaliza essas ações no sistema existente. O agente legado grava rascunhos e histórico por telefone; reutilizá-lo sem adaptação misturaria as sessões dos dois números. Não houve migração ou duplicação de tabelas de negócio.

O adaptador retorna reply, handoff ou no_action. Não envia diretamente à Evolution. OPENAI_MODEL é obrigatório no worker: use um modelo compatível validado na conta. A disponibilidade e o custo desse modelo não foram testados, pois a chave OpenAI não foi fornecida nesta sessão. Falha do modelo resulta em fila humana.

Devolver à IA espera a próxima mensagem do cliente, evitando resposta extra a perguntas antigas. O limite de duas perguntas de esclarecimento é conservador: não é zerado por uma inferência do modelo sobre progresso.

Mídia é recuperada da Evolution por chave da mensagem, mediante autenticação da atendente, com limite de 8 MB. Imagens e áudios permitidos podem ser exibidos; outros tipos são baixados sem execução. Ao abrir um anexo pela primeira vez, o backend preserva uma cópia no bucket privado cw-media, usando caminho com restaurante/instância/conversa/mensagem; leituras seguintes usam essa cópia. O bucket precisa ser criado com node scripts/central-storage.js. Não foram executadas criação do bucket, recuperação real ou validação de mídia nesta sessão. A política de retenção ainda precisa ser definida. Não há download por URL arbitrária.

JIDs @lid permanecem separados e não são tratados como telefone. O mapeamento de JID alternativo, importação de histórico, reconciliação sem ID do provedor e preservação de mídia não foram validados no ambiente real. Um eco sem associação e com envio incerto é colocado em quarentena para revisão; o sistema não atribui autoria por texto/horário.

## Arquivos principais

| Caminho                                                 | Uso                                             |
| ------------------------------------------------------- | ----------------------------------------------- |
| src/central/server.js                                   | Autenticação, leitura, comandos e webhook       |
| src/central/engine.js                                   | Transações, máquina de estados, fila e despacho |
| src/central/database.js                                 | Pool e locks com liberação em finally           |
| src/central/evolution.js                                | Normalização e transporte por instância         |
| src/central/agent.js                                    | Adaptador de IA e ferramentas de leitura        |
| central/ui/                                             | Interface React/TypeScript                      |
| supabase/migrations/20261015064518_central_whatsapp.sql | Schema, índices, grants, RLS e Realtime         |
| tests/central.test.js                                   | Verificação funcional local                     |
| scripts/central-db.js                                   | Inventário e aplicação explícita da migração    |
| scripts/central-admin.js                                | Associação de conta Auth já convidada           |
| scripts/central-probe.js                                | Diagnóstico de leitura, sem mensagens           |
| .env.central.example                                    | Variáveis necessárias; sem segredos reais       |

O prefixo cw_ e o schema cw_private separam a central dos objetos existentes. O SQL falha se os mesmos objetos já existirem, em vez de sobrescrevê-los. cw_private não deve ser exposto pela Data API. As tabelas de negócio já existentes não foram inspecionadas remotamente por falta de acesso administrativo; execute o inventário antes da migração.

## Rodar e conferir localmente

Requer Node 24 LTS ou versão compatível >=22.12.

```sh
npm ci
npm run build:central
npm run test:central
npm test
npm run preview:central
```

A demonstração abre em http://localhost:3000 e tem botão próprio. Ela usa Postgres embarcado em memória, contas e dados fictícios, sem ler .env e sem chamar serviços reais. Não é um modo de autenticação do serviço de produção.

Para a instalação real, configure segredos no Easypanel seguindo .env.central.example. DATABASE_URL deve ser conexão direta ou pool em modo de sessão; porta transacional 6543 é rejeitada. Verificação TLS não é desativada. A conexão privilegiada deve alcançar somente o backend/worker.

## Preparação do banco e da equipe

1. Confirmar acesso administrativo ao projeto e backup recuperável. Conferir schema e tabelas já existentes com node scripts/central-db.js inspect.
2. Aplicar a migração revisada: node scripts/central-db.js apply. Isso cria somente os objetos da central e inicia as duas instâncias com IA pausada.
3. Criar o bucket privado com node scripts/central-storage.js. Executar os advisors de segurança e revisar grants/RLS no Supabase real. Eles não foram executados nesta sessão.
4. Desativar cadastro público no Supabase Auth. Convidar as contas individuais pelo painel Auth; configurar Site URL e redirect de recuperação para o domínio da central.
5. Associar a conta já existente com node scripts/central-admin.js EMAIL admin "Nome". Para atendentes, usar attendant. Esse script não envia convites nem inventa contas.
6. Conferir leitura de membro, bloqueio de não membro e negação de escrita direta usando JWTs reais de duas atendentes e um administrador.

Não usar a chave publicável para administração. SUPA_SERVICE_KEY, DATABASE_URL, chaves Evolution e chave OpenAI ficam somente no servidor. As credenciais recebidas foram guardadas em .env.central local ignorado pelo Git e excluído do pacote de código.

## Implantação no Easypanel

Criar dois serviços a partir do mesmo commit/Dockerfile:

| Serviço     | Comando                                 | Rede                                    |
| ----------- | --------------------------------------- | --------------------------------------- |
| Web/backend | node src/start.js, CENTRAL_ENABLED=true | Porta 3000, HTTPS no domínio do agente  |
| Worker      | node src/central/worker-main.js         | Processo persistente, sem porta pública |

Ambos recebem os segredos. APP_ORIGIN deve ser exatamente https://agente-agente-chapelao.b1h6rm.easypanel.host sem barra final. Configure reinício automático. Não usar processos de worker que encerram após uma requisição HTTP.

O Dockerfile recompila o painel e usa npm ci. Não publica arquivos .env. O agente legado continua como padrão enquanto CENTRAL_ENABLED não for true. Para testar a central antes do corte, preferir um serviço/staging separado com números de teste.

## Corte dos webhooks, depois dos testes

| Instância             | Endpoint da central                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Chapela - atendimento | https://agente-agente-chapelao.b1h6rm.easypanel.host/api/webhooks/evolution/435ce918-8d86-4d77-b14e-8cccf751bb88 |
| chapelao              | https://agente-agente-chapelao.b1h6rm.easypanel.host/api/webhooks/evolution/adcfdc9d-3bd9-46ad-b096-76fd032a919c |

Salvar a configuração antiga para recuperação antes de editar. Configurar segredo diferente em X-Webhook-Secret para cada endpoint; HTTPS; byEvents=false; base64=false; eventos MESSAGES_UPSERT, MESSAGES_UPDATE, SEND_MESSAGE e CONNECTION_UPDATE conforme o contrato testado de 2.3.7. Não deixar webhook global duplicado ou outro bot respondendo a essas instâncias.

O endpoint legado /webhook retorna 410 em modo central. GET /api/health informa somente liveness; não comprova worker saudável ou conexão das instâncias. Usar a área de operação para isso.

Fazer piloto no principal e depois habilitar o secundário. Primeiro validar atendimento humano com IA pausada. Só habilitar IA por instância depois de confirmar o modelo, o catálogo e o contrato dos eventos. Nenhuma ativação ou mudança remota foi feita nesta entrega.

## Verificação e critérios ainda pendentes

Resultado verificado: 19 testes da central passaram; os 12 grupos de testes existentes (121 verificações) passaram; compilação TypeScript/Vite e verificação de sintaxe passaram; npm audit retornou zero vulnerabilidades. Interface conferida no navegador, incluindo assunção e envio enfileirado em demonstração.

A suíte local usa Postgres PGlite para executar o SQL e as transações, incluindo RLS real. O adapter de teste serializa conexões e substitui advisory locks porque PGlite não os implementa. **Isso não comprova concorrência de sessões PostgreSQL reais ou comportamento durante queda de conexão de rede.** O teste de locks verifica a ordem e a liberação de recursos.

A prova real de Evolution ainda deve capturar fixtures sanitizadas de mensagem, eco, status, mídia, JID e desconexão; testar as duas instâncias e os 28 cenários de aceite do documento original, especialmente assumir durante POST, queda do worker, áudio/duas abas, reconexão Realtime, revogação e tempo de alerta.

Ainda pendem: acesso de implantação no Easypanel; acesso administrativo/DSN Supabase; chave publicável válida; e-mail da conta administradora; credenciais OpenAI do serviço; testes reais e advisors; validação real de anexos/Storage e ensaio de backup/restauração. Não considerar produção pronta somente pelo sucesso dos testes locais.

## Referências consultadas

- [RLS e grants no Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Changelog do Supabase](https://supabase.com/changelog)
- [Contrato Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Router de mensagens Evolution](https://github.com/evolution-foundation/evolution-api/blob/main/src/api/routes/sendMessage.router.ts) — código main é referência, não prova da imagem 2.3.7 instalada.
