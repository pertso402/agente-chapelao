-- Coordination only. The existing menu, draft and order tables remain in place.
begin;
create table if not exists cw_private.legacy_runs (
 decision_key text primary key,
 restaurant_id uuid not null,
 instance_id uuid not null,
 conversation_id uuid not null,
 status text not null check(status in ('running','done','uncertain')),
 started_at timestamptz not null default now(),
 completed_at timestamptz,
 foreign key(restaurant_id,instance_id,conversation_id)
   references public.cw_conversations(restaurant_id,instance_id,id)
);
revoke all on cw_private.legacy_runs from public,anon,authenticated;
commit;
