-- Central Chapelão. Executar somente após inventário/backup do projeto de destino.
-- Não modifica cardápio, pedidos, clientes, impressora ou tabelas legadas.
begin;
create schema if not exists cw_private;
revoke all on schema cw_private from public, anon, authenticated;
create table public.cw_restaurants (id uuid primary key default gen_random_uuid(), name text not null);
create table public.cw_members (
 restaurant_id uuid not null references public.cw_restaurants(id), user_id uuid not null references auth.users(id),
 display_name text not null check(length(display_name) between 1 and 120), role text not null check(role in ('admin','attendant')),
 active boolean not null default true, primary key(restaurant_id,user_id)
);
create index cw_members_user_active on public.cw_members(user_id,restaurant_id) where active;
create table public.cw_settings (
 restaurant_id uuid primary key references public.cw_restaurants(id), knowledge jsonb not null default '{}',
 prompt_version text not null default 'central-v1', knowledge_version text not null default 'legacy-catalog'
);
create table public.cw_instances (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.cw_restaurants(id),
 provider_name text not null unique, label text not null, ai_enabled boolean not null default false,
 connection_state text not null default 'unknown' check(connection_state in ('open','close','connecting','unknown')),
 config_epoch bigint not null default 0 check(config_epoch>=0), checked_at timestamptz,
 unique(restaurant_id,id)
);
create table public.cw_conversations (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, instance_id uuid not null,
 chat_jid text not null, customer_name text not null default 'Cliente', phone text,
 state text not null check(state in ('ai','waiting_human','human','closed')),
 assignee_id uuid, control_epoch bigint not null default 0 check(control_epoch>=0),
 inbound_seq bigint not null default 0 check(inbound_seq>=0), cycle integer not null default 1 check(cycle>0),
 ai_clarification_count integer not null default 0 check(ai_clarification_count>=0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closed_at timestamptz,
 foreign key(restaurant_id,instance_id) references public.cw_instances(restaurant_id,id),
 foreign key(restaurant_id,assignee_id) references public.cw_members(restaurant_id,user_id),
 unique(instance_id,chat_jid), unique(restaurant_id,instance_id,id),
 check((state='human' and assignee_id is not null) or (state<>'human' and assignee_id is null))
);
create index cw_conversations_queue on public.cw_conversations(restaurant_id,state,created_at,id);
create index cw_conversations_assignee on public.cw_conversations(restaurant_id,assignee_id,state);
create table public.cw_messages (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, instance_id uuid not null, conversation_id uuid not null,
 cycle integer not null check(cycle>0), direction text not null check(direction in ('in','out')),
 author text not null check(author in ('customer','ai','human','system','external')), author_id uuid,
 provider_id text, kind text not null default 'text', text text not null default '', media_key jsonb,
 status text not null check(status in ('received','pending','sending','accepted','delivered','read','failed','unknown','cancelled')),
 control_epoch bigint, inbound_seq bigint, config_epoch bigint, provider_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(restaurant_id,instance_id,conversation_id) references public.cw_conversations(restaurant_id,instance_id,id),
 foreign key(restaurant_id,author_id) references public.cw_members(restaurant_id,user_id),
 unique(restaurant_id,instance_id,conversation_id,id),
 unique(instance_id,conversation_id,direction,provider_id),
 check((direction='in' and author='customer' and status='received') or direction='out')
);
create index cw_messages_history on public.cw_messages(conversation_id,created_at desc,id desc);
create index cw_messages_provider on public.cw_messages(instance_id,provider_id) where provider_id is not null;
create index cw_messages_unresolved on public.cw_messages(conversation_id,status) where status in ('pending','sending','unknown');
create table public.cw_handoffs (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, instance_id uuid not null, conversation_id uuid not null,
 status text not null check(status in ('pending','claimed','resolved')), reason_code text not null,
 reason_detail text not null, summary text not null default '', created_at timestamptz not null default now(), resolved_at timestamptz,
 foreign key(restaurant_id,instance_id,conversation_id) references public.cw_conversations(restaurant_id,instance_id,id)
);
create unique index cw_handoffs_one_active on public.cw_handoffs(conversation_id) where status in ('pending','claimed');
create index cw_handoffs_queue on public.cw_handoffs(restaurant_id,status,created_at);
create table public.cw_activity_log (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.cw_restaurants(id),
 instance_id uuid, conversation_id uuid, actor_id uuid, action text not null, details jsonb not null default '{}', created_at timestamptz not null default now(),
 foreign key(restaurant_id,instance_id) references public.cw_instances(restaurant_id,id),
 foreign key(restaurant_id,instance_id,conversation_id) references public.cw_conversations(restaurant_id,instance_id,id),
 foreign key(restaurant_id,actor_id) references public.cw_members(restaurant_id,user_id)
);
create index cw_activity_restaurant on public.cw_activity_log(restaurant_id,created_at desc);
create table cw_private.jobs (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, instance_id uuid not null, conversation_id uuid,
 type text not null check(type in ('webhook','ai','send')), dedup_key text not null unique, payload jsonb not null default '{}',
 status text not null default 'pending' check(status in ('pending','running','done','failed','quarantine')),
 attempts integer not null default 0, run_after timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(restaurant_id,instance_id) references public.cw_instances(restaurant_id,id),
 foreign key(restaurant_id,instance_id,conversation_id) references public.cw_conversations(restaurant_id,instance_id,id)
);
create index cw_jobs_ready on cw_private.jobs(run_after,created_at) where status='pending';
create index cw_jobs_lease on cw_private.jobs(lease_until) where status='running';
create table cw_private.ai_decisions (
 decision_key text primary key, restaurant_id uuid not null, instance_id uuid not null, conversation_id uuid not null,
 action text not null check(action in ('reply','handoff','no_action')), created_at timestamptz not null default now(),
 foreign key(restaurant_id,instance_id,conversation_id) references public.cw_conversations(restaurant_id,instance_id,id)
);
create table cw_private.api_requests (
 restaurant_id uuid not null references public.cw_restaurants(id), user_id uuid not null references auth.users(id), key uuid not null,
 fingerprint text not null, response jsonb not null, status_code integer not null, created_at timestamptz not null default now(),
 primary key(restaurant_id,user_id,key)
);
-- Policies não autorizam escrita: só o backend com conexão privilegiada escreve.
alter table public.cw_members enable row level security;
revoke all on public.cw_members from anon,authenticated;
grant select on public.cw_members to authenticated;
create policy cw_own_membership on public.cw_members for select to authenticated
 using(user_id=(select auth.uid()) and active);
do $$
declare t text;
begin
 foreach t in array array['cw_restaurants','cw_settings','cw_instances','cw_conversations','cw_messages','cw_handoffs','cw_activity_log'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  if t='cw_restaurants' then
   execute format('create policy cw_member_read on public.%I for select to authenticated using (exists(select 1 from public.cw_members m where m.restaurant_id=id and m.user_id=(select auth.uid()) and m.active))',t);
  else
   execute format('create policy cw_member_read on public.%I for select to authenticated using (exists(select 1 from public.cw_members m where m.restaurant_id=%I.restaurant_id and m.user_id=(select auth.uid()) and m.active))',t,t);
  end if;
 end loop;
end $$;
alter table cw_private.jobs enable row level security;
alter table cw_private.api_requests enable row level security;
alter table cw_private.ai_decisions enable row level security;
revoke all on all tables in schema cw_private from public,anon,authenticated;
-- Sem SECURITY DEFINER, views, policies de escrita ou alterações em schemas internos.
insert into public.cw_restaurants(id,name) values('ad48a105-9dad-4e67-8058-963082734575','Restaurante Chapelão');
insert into public.cw_settings(restaurant_id) values('ad48a105-9dad-4e67-8058-963082734575');
insert into public.cw_instances(id,restaurant_id,provider_name,label) values
 ('435ce918-8d86-4d77-b14e-8cccf751bb88','ad48a105-9dad-4e67-8058-963082734575','Chapela - atendimento','WhatsApp principal'),
 ('adcfdc9d-3bd9-46ad-b096-76fd032a919c','ad48a105-9dad-4e67-8058-963082734575','chapelao','WhatsApp secundário');
-- Publication de tabelas específicas; não publica fila/segredos.
do $$
declare t text;
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach t in array array['cw_instances','cw_conversations','cw_messages','cw_handoffs'] loop
   execute format('alter publication supabase_realtime add table public.%I',t);
  end loop;
 end if;
end $$;
commit;
