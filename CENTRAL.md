# Central de atendimento Chapelão

Implementação baseada em especificacao-central-whatsapp.md, integrada ao repositório agente-chapelao. Instalação: 15/10/2026, America/Sao_Paulo.

## Instalação e comportamento

Painel: https://agente-central-chapelao.b1h6rm.easypanel.host/

No projeto agente do Easypanel foram criados central-chapelao (web/backend na porta 3000, HTTPS) e central-worker (processo persistente, sem domínio público). Ambos usam o mesmo código e banco. O agente-chapelao anterior foi desativado e preservado para recuperação. Os serviços dos outros restaurantes não foram alterados.

A migração 20261015064518_central_whatsapp.sql foi aplicada ao Supabase. Ela criou os objetos cw_* e cw_private, após inventário remoto; não alterou cardápio, pedidos ou clientes existentes. O bucket cw-media foi criado como privado. A conexão usa o pool de sessão 5432 com certificado oficial Supabase e verificação TLS; não usa pool transacional nem desativa validação de certificado.

| Instância | Evolution | Recebimento |
| --- | --- | --- |
| Principal | Chapela - atendimento | Central, com segredo próprio |
| Secundário | chapelao | Central, com outro segredo |

Ambos têm os eventos MESSAGES_UPSERT, MESSAGES_UPDATE, SEND_MESSAGE e CONNECTION_UPDATE, byEvents=false e base64=false. O webhook global da instalação Evolution está desabilitado. A imagem observada foi evoapicloud/evolution-api:v2.3.7.

Conforme decisão do responsável, o webhook de recompra do secundário foi substituído. O servidor Vercel que dispara ofertas e suas credenciais não foram alterados. Os disparos iniciais continuam sob responsabilidade desse serviço. A resposta ao convite deixa de disparar automaticamente o vídeo do buffet pelo webhook antigo e passa ao atendimento da equipe. Não foi executado disparo real de oferta como teste.

Saídas externas, como ofertas enviadas pelo serviço de recompra, ficam registradas quando notificadas pela Evolution. Uma saída para cliente sem atendimento aberto não gera chamado, não agenda IA e não reabre conversa encerrada. A próxima mensagem recebida do cliente abre o atendimento. Em conversa ativa com IA, uma resposta externa suspende o controle automático para conferência humana.

## Entrada sem e-mail, senha ou IP fixo

Esta instalação usa CENTRAL_AUTH_MODE=trusted_device. O link de ativação autoriza o navegador na primeira abertura. Depois, a pessoa escolhe Atendimento 1, Atendimento 2 ou Gestão; a escolha fica salva por até 180 dias. “Trocar pessoa” permite mudar a identificação no mesmo computador. Não existe restrição por IP.

O link fica no arquivo privado ACESSO-CENTRAL.md, fora do repositório e do ZIP de código. Ele utiliza fragmento #activate=..., removido da barra imediatamente, e expira inicialmente em sete dias. Não é enviado em query strings ou referrers. O servidor armazena somente seu hash SHA-256. Aparelhos já ativados continuam autorizados após o vencimento do link.

Cookies são assinados, HttpOnly, SameSite=Strict e Secure em HTTPS. A API exige o cookie do aparelho além da identificação do operador; comandos verificam a origem. Acesso direto sem autorização recebe 403. Limpar cookies ou usar navegação anônima exige ativação novamente.

O link concede acesso aos perfis da empresa, inclusive Gestão. A escolha do nome identifica quem está operando; não comprova identidade individual. Compartilhar o link somente com a equipe. Para revogar todos os aparelhos, trocar CENTRAL_SESSION_SECRET e gerar um novo link/hash. Para deixar de autorizar novos aparelhos, vencer CENTRAL_ENROLLMENT_UNTIL.

Perfis criados com autorização explícita:

| Perfil | Papel |
| --- | --- |
| Atendimento 1 | attendant |
| Atendimento 2 | attendant |
| Gestão | admin |

Os registros técnicos no Supabase Auth usam endereços aleatórios @internal.invalid e senhas aleatórias, sem envio de convite. A equipe não usa essas credenciais. Membership e atividade são conferidas a cada ação. O modo opcional password permanece disponível; não está selecionado.

## Operação da equipe

1. Abrir a central; na primeira vez, usar o link de ativação.
2. Escolher o perfil e clicar em Abrir central. O navegador lembra a escolha.
3. Clicar em Ativar som em cada estação que deve emitir alerta.
4. Selecionar o chamado, ler o motivo e o histórico, e clicar em Assumir.
5. Enviar a mensagem e acompanhar seu status no histórico.
6. Devolver à fila, transferir, devolver à IA ou encerrar explicitamente.

A conversa continua humana mesmo após sair do painel, recarregar ou esperar. Encerrar termina o ciclo atual; nova mensagem do cliente pode abrir outro. Ativar IA de uma instância não tira chamados existentes da fila. Devolver à IA aguarda a próxima mensagem, sem responder novamente a perguntas antigas.

A área Operação e instâncias mostra IA por número, situação de jobs, mensagens incertas e acesso da equipe. Desativar um membro devolve suas conversas e cancela saídas pendentes na mesma transação. Envios humanos incertos exigem resolução antes de encerrar, transferir ou desativar o responsável.

## IA compartilhada e limites

src/central/agent.js compartilha as ferramentas de leitura buscar_itens_do_dia, buscar_cardapio e info_restaurante do sistema existente. As duas instâncias usam esse mesmo adaptador, com histórico separado por conversa e ciclo.

O modelo gpt-4o foi verificado como disponível com a chave já existente no Easypanel. Um teste consultou o horário do restaurante e obteve uma resposta, sem envio para WhatsApp.

Nesta versão, a IA consulta o catálogo e informações gerais. Pedidos, alterações, pagamentos, reclamações e mídia são encaminhados para pessoas. Ela não grava pedido, não aprova pagamento e não executa ferramentas de cupons/cancelamentos do agente legado. O legado armazenava sessões por telefone; reutilizá-las misturaria o contexto dos dois números.

O adaptador retorna reply, handoff ou no_action. Não envia diretamente à Evolution. Falha do modelo gera encaminhamento humano. Na conclusão desta instalação, o principal está com IA habilitada e o secundário está com IA pausada para atendimento da equipe. Essa configuração pode ser conferida em Operação e instâncias.

## Isolamento e coordenação

- A identidade da conversa é instance_id + chat_jid. O mesmo cliente nos dois números tem dois históricos.
- Todas as tarefas e mensagens têm restaurante e instância; chaves estrangeiras compostas impedem misturar origens.
- O servidor deriva o destino da conversa registrada. Navegador e modelo não escolhem número de envio.
- Webhooks exigem segredo e correspondência do nome da instância. Só recebem 2xx após commit do job.
- Jobs Postgres usam SKIP LOCKED, leases renováveis, tentativas limitadas e quarentena.
- Estado, ciclos, responsável e epochs são persistidos. Gerações antigas são invalidadas antes de gravar e antes de enviar.
- Locks de sessão são adquiridos na ordem instância, conversa. Pausa global usa lock exclusivo da instância.
- O POST de envio mantém a barreira de coordenação, sem manter transação SQL aberta durante a rede.
- Timeout ou queda com entrega ambígua resulta em unknown. Não existe reenvio cego.
- Comandos usam Idempotency-Key e auditoria; disputa para assumir retorna 409.
- Status de entrega fora de ordem não rebaixa mensagens já lidas.
- RLS e grants impedem leitura anônima e escrita direta pelo navegador. No modo por aparelho, o painel usa apenas o backend, com atualização a cada 1,5 segundo.

O agente legado e seus pollers não são carregados com CENTRAL_ENABLED=true. Não religar o serviço antigo enquanto o worker central estiver respondendo aos mesmos números.

O serviço de ofertas Vercel continua como emissor externo. Ele não foi migrado para a outbox da central nesta entrega. A central registra seus eventos como external; campanhas devem respeitar o atendimento humano em andamento.

## Mídia e identificadores

A API recupera mídia pela chave da mensagem, com autenticação da atendente e limite de 8 MB. Preserva cópia no bucket privado cw-media, em caminho com restaurante, instância, conversa e mensagem. Leituras seguintes usam essa cópia. Não há URLs públicas permanentes ou download por URL arbitrária.

Imagens/áudios permitidos são exibidos; outros formatos são baixados sem execução. A recuperação de anexo real ainda precisa de teste operacional. A retenção de anexos deve ser definida pela empresa.

JID @lid não é convertido em telefone. O mapeamento de identificadores alternativos não foi confirmado no ambiente real; conversas não são fundidas por nome ou semelhança. Importação de histórico não está habilitada. A central começa a receber eventos a partir do corte; conversas antigas do agente não foram importadas.

## Código e configuração

| Arquivo | Responsabilidade |
| --- | --- |
| src/start.js | Seleção entre central e legado |
| src/central/server.js | API, autorização e webhook |
| src/central/internal-access.js | Ativação do aparelho e identificação salva |
| src/central/engine.js | Estados, transações, jobs e despacho |
| src/central/database.js | Pool, TLS e locks |
| src/central/evolution.js | Eventos e transporte por instância |
| src/central/agent.js | Adaptador da IA |
| src/central/storage.js | Anexos privados |
| central/ui/ | Painel React/TypeScript |
| supabase/migrations/ | Schema, RLS, índices e dados iniciais |
| .env.central.example | Exemplo sem segredos |

O painel usa React/TypeScript com Vite servido por Express, aproveitando o repositório existente. Backend e worker exigem Node persistente; não são funções que encerram após a requisição HTTP.

Variáveis principais:

```env
CENTRAL_ENABLED=true
CENTRAL_AUTH_MODE=trusted_device
CENTRAL_SESSION_SECRET=<segredo-aleatorio>
CENTRAL_ENROLLMENT_HASH=<sha256-do-token-de-ativacao>
CENTRAL_ENROLLMENT_UNTIL=<validade-do-link-em-milisegundos-unix>
APP_ORIGIN=https://agente-central-chapelao.b1h6rm.easypanel.host
PORT=3000
DATABASE_URL=<conexao-postgres-de-sessao-5432-com-TLS>
SUPA_URL=https://qlswjefuinhbtlhauhgj.supabase.co
SUPA_SERVICE_KEY=<somente-servidor>
OPENAI_API_KEY=<somente-servidor>
OPENAI_MODEL=gpt-4o
EVOLUTION_PRIMARY_KEY=<somente-servidor>
EVOLUTION_SECONDARY_KEY=<somente-servidor>
WEBHOOK_PRIMARY_SECRET=<segredo-proprio>
WEBHOOK_SECONDARY_SECRET=<outro-segredo>
```

SUPA_KEY só é necessária no modo opcional password. As chaves privadas, DATABASE_URL e link de ativação não entram no Git/ZIP. O certificado público Supabase encontra-se em certificates/supabase-root-ca.crt. DATABASE_CA_CERT permite fornecer outra CA explícita, mantendo rejectUnauthorized=true.

Para desenvolvimento:

```sh
npm ci
npm run build:central
npm run test:central
npm run check
npm test
npm run preview:central
```

A prévia localhost:3000 usa banco em memória e dados fictícios, sem ler .env ou conectar números reais. O serviço de produção não permite autenticação de demonstração.

## Verificação realizada

- Compilação TypeScript/Vite e verificação de sintaxe.
- 23 testes funcionais da central passaram, incluindo RLS, isolamento, idempotência, assunção, descarte de IA obsoleta, mídia autenticada, envios incertos, revogação e acesso por aparelho.
- Os 12 grupos de testes existentes passaram, com 121 verificações.
- npm audit retornou zero vulnerabilidades na revisão das dependências.
- PostgreSQL real: TLS validado e exclusão entre duas sessões para a mesma conversa.
- Supabase real: migração aplicada, oito tabelas públicas com RLS, equipe criada e bucket privado.
- Easypanel: painel e worker ativos; ambos os WhatsApps reportaram open.
- HTTPS real: dados negados sem cookie; ativação, identificação e comandos autenticados testados.
- Navegador: entrada sem e-mail/senha, persistência após reload e painel de operação.
- Webhooks reais configurados e relidos, com conferência dos dois segredos.
- Evento sintético de conexão recebido, gravado e concluído pelo worker para cada instância; nenhuma mensagem foi enviada para cliente nesse teste.

A suíte usa PGlite para SQL/RLS e serializa conexões, substituindo advisory locks. O teste adicional em PostgreSQL real valida exclusão entre duas sessões, mas não todos os cenários de concorrência sob falha de rede.

Ainda falta a validação operacional com mensagens reais de entrada e resposta em cada número, anexos reais, todos os 28 cenários de aceite e ensaio de backup/restauração. Os advisors do plugin Supabase não foram executados porque suas ferramentas administrativas não estavam disponíveis nesta sessão. O acesso administrativo usado foi DSN de sessão e a chave de serviço já configurada no Easypanel.

## Recuperação

Foram preservadas cópias privadas da configuração do agente anterior e dos webhooks. Elas contêm credenciais e não integram a entrega pública de código.

Antes de voltar ao legado: pausar IA, conferir saídas pendentes/incertas e interromper o worker central. Restaurar os webhooks anteriores e só então reativar agente-chapelao. Não deixar dois agentes respondendo à mesma instância. Preservar as tabelas cw_* para conferência; recuperação não exige apagá-las.

## Referências

- [API Easypanel](https://easypanel.io/docs/api)
- [TLS Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres#ssl-connections)
- [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Webhook Evolution 2.3.7](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/integrations/event/webhook/webhook.controller.ts)
- [Webhook de recompra inspecionado](https://github.com/pertso402/Agente-recompra-chapelao/blob/main/app/api/webhook-recompra/route.js)
