# Central de atendimento Chapelão

Painel: https://agente-central-chapelao.b1h6rm.easypanel.host/

## Operação

A central abre diretamente pelo link, sem e-mail, senha, escolha de perfil ou ativação por aparelho. A instalação usa CENTRAL_AUTH_MODE=open com a identidade compartilhada “Equipe”, vinculada ao perfil Gestão já autorizado. Qualquer pessoa que obtenha o endereço poderá consultar conversas e operar o atendimento, inclusive as funções administrativas. Esse acesso público foi autorizado explicitamente pelo responsável em 15/10/2026. A auditoria identifica a equipe, sem atribuição individual.

1. Abrir o link e clicar em Ativar som se desejar alertas nessa estação.
2. Selecionar a conversa e clicar em Assumir para interromper a atuação da IA.
3. Responder, devolver à fila, devolver à IA ou encerrar.
4. Ao devolver à IA, ela aguarda a próxima mensagem do cliente.

O controle humano persiste após recarregar ou fechar o navegador. Ativar a IA da instância não retira chamados existentes da fila. Enquanto o agente está finalizando uma operação de pedido, Assumir pode solicitar alguns segundos de espera; a coordenação evita duas ações simultâneas sobre o mesmo pedido.

| Número | Funcionamento |
| --- | --- |
| Chapela - atendimento | Agente original completo; equipe assume quando necessário |
| chapelao | Respostas atendidas pela equipe |

O sistema Vercel de campanhas não foi alterado. Os disparos iniciais continuam nesse serviço. Conforme autorização do responsável, a resposta ao convite do secundário passa à central e deixa de disparar o vídeo automático pelo webhook antigo.

## Agente original preservado

O principal executa processarMensagem de src/index.js e reutiliza integralmente src/agent.js, src/tools/index.js, src/config.js e src/utils/pedido.js do agente original. Esses quatro arquivos não tiveram diferenças em relação a origin/main nesta restauração.

Treinamento, coleta de dados, cardápio, preços, ferramentas de pedidos, resumo, confirmação, reserva PIX, verificação de comprovante, áudio e gravação no painel existente continuam disponíveis. As tabelas comerciais antigas não foram substituídas. Um pequeno ajuste reconhece “SIM” após o prefixo interno de transcrição de áudio.

A central coordena recebimento, controle humano e envio. O agente não envia sua resposta diretamente à Evolution: a resposta passa pela outbox persistente e é revalidada antes do envio. As rotinas originais de loja, taxas e acompanhamento continuam no processo persistente, respeitando o controle humano. Mensagens aceitas da equipe são refletidas no histórico antigo e interrompem lembretes antigos.

O secundário permanece humano. O agente antigo usa rascunhos por telefone, sem instância; ativá-lo nos dois números poderia misturar pedidos do mesmo cliente. Essa ativação é bloqueada pelo backend.

Uma marca durável registra o início de cada processamento do agente. Se houver queda após uma possível gravação comercial, o atendimento é encaminhado para conferência em vez de repetir automaticamente o pedido. A integração não transforma as ferramentas comerciais antigas em uma transação única.

## Instalação

O app agente/agente-chapelao no Easypanel serve o painel, API e processamento persistente no mesmo processo Node. O domínio central aponta para esse app. central-chapelao e central-worker ficam parados e preservados para recuperação. Os serviços de outros restaurantes não foram modificados.

O endereço antigo do agente redireciona a página inicial para o domínio da central. O endpoint legado /webhook fica desativado; os dois números usam /api/webhooks/evolution/<instanceId>, cada um com seu segredo.

O código está na branch codex/central-whatsapp. A branch main do agente original permanece preservada. A aplicação usa o Dockerfile do repositório.

Easypanel foi mantido porque este desenho usa timers, filas, leases e conexões persistentes. O frontend poderia ser separado em outra hospedagem, mas não foi necessário para esta correção.

## Banco e segurança técnica

As migrações 20261015064518_central_whatsapp.sql e 20261015084000_full_agent.sql criam a coordenação cw_* e cw_private sem alterar o catálogo, clientes ou pedidos antigos. A segunda adiciona somente cw_private.legacy_runs. O bucket cw-media é privado.

A conexão usa PostgreSQL de sessão na porta 5432, certificado oficial Supabase e verificação TLS. Não usar o pool transacional 6543 para advisory locks. Segredos ficam no ambiente do servidor, fora do Git e do ZIP.

O browser usa a API da central. RLS bloqueia leitura anônima direta no banco; no modo open, é a API pública da central que concede o acesso compartilhado autorizado. Comandos ainda conferem Origin e Idempotency-Key. Webhooks continuam exigindo X-Webhook-Secret e a instância correspondente.

Conversas têm identidade instance_id + chat_jid, com chaves estrangeiras compostas. Eventos repetidos são deduplicados; jobs usam leases renováveis e SKIP LOCKED. Estado, ciclo, responsável e epochs impedem respostas obsoletas após tomada humana. Timeout de envio ambíguo vira unknown, sem reenvio cego.

Os webhooks usam MESSAGES_UPSERT, MESSAGES_UPDATE, SEND_MESSAGE e CONNECTION_UPDATE, byEvents=false e base64=false, na Evolution 2.3.7. Ofertas externas são registradas quando notificadas pelo provedor; uma saída de campanha não cria chamado nem reabre conversa encerrada. Em conversa ativa com IA, resposta externa suspende o controle automático para conferência.

## Configuração

Ver .env.central.example. Configuração desta instalação:

```env
CENTRAL_ENABLED=true
CENTRAL_FULL_AGENT=true
CENTRAL_RUN_WORKER=true
CENTRAL_AUTH_MODE=open
CENTRAL_OPEN_USER_ID=<id-do-perfil-Gestao-existente>
APP_ORIGIN=https://agente-central-chapelao.b1h6rm.easypanel.host
PORT=3000
DATABASE_URL=<conexao-de-sessao-com-TLS>
SUPA_URL=https://qlswjefuinhbtlhauhgj.supabase.co
SUPA_SERVICE_KEY=<somente-servidor>
OPENAI_API_KEY=<somente-servidor>
OPENAI_MODEL=<modelo-original>
EVOLUTION_PRIMARY_KEY=<somente-servidor>
EVOLUTION_SECONDARY_KEY=<somente-servidor>
WEBHOOK_PRIMARY_SECRET=<segredo-proprio>
WEBHOOK_SECONDARY_SECRET=<outro-segredo>
```

As demais variáveis comerciais do app original são preservadas. SUPA_KEY é necessária somente no modo opcional password. Os modos trusted_device e internal_network continuam disponíveis no código, mas não são usados nesta instalação.

| Arquivo | Função |
| --- | --- |
| src/central/server.js | API, painel, acesso compartilhado e inicialização conjunta |
| src/central/engine.js | Estados, fila, eventos e despacho |
| src/central/full-agent.js | Coordenação do agente original e acompanhamento |
| src/central/legacy-context.js | Contexto isolado por processamento |
| src/central/worker-main.js | Processamento persistente |
| src/services/supabase.js | Integração com histórico, pedidos e controle humano |
| src/central/storage.js | Anexos privados |
| central/ui/ | Painel React/TypeScript |

## Validação e limites

Passaram 38 testes da central e do fluxo original, além dos 12 grupos existentes com 121 verificações. A compilação TypeScript/Vite e a verificação de sintaxe passaram. Os testes comerciais usam serviços simulados: nenhum pedido real foi criado e nenhuma mensagem foi enviada a cliente para testá-los.

Os testes cobrem confirmação por SIM, reserva PIX, criação após comprovante, áudio, ferramentas originais, controle humano, retomada, acesso direto, isolamento por número, deduplicação, quedas e envios incertos. PGlite serializa conexões nos testes; não reproduz todos os cenários reais de concorrência.

Ainda é necessária a conferência operacional com um pedido real autorizado, mídia real e os cenários completos de aceite. A leitura de anexos no painel limita arquivos a 8 MB e guarda cópia privada. Identificadores @lid não são adivinhados: o agente usa telefone alternativo somente quando fornecido pelo evento da Evolution. Sem telefone verificável, encaminha para a equipe.

O painel mostra o histórico recebido pela central desde o corte. O agente também consulta seu histórico comercial anterior; não houve importação geral de conversas antigas para a lista do painel.

## Recuperação

Configurações anteriores do app e dos webhooks foram preservadas em backup privado. Antes de retornar ao serviço legado, pausar a IA, conferir saídas incertas e interromper o processamento central. Restaurar o webhook principal antigo e a configuração original do app. Não deixar dois processadores respondendo ao mesmo número. Não apagar as tabelas cw_* para efetuar recuperação.
