-- Devolve à IA as conversas pausadas pela central sem ninguém ter assumido,
-- com a mesma regra do agente original (pausa de 10 min). Roda no banco para
-- valer sem depender de deploy do app; o expirePause do engine faz o mesmo na
-- chegada da mensagem, os dois convivem. Não toca em quem clicou Assumir
-- (state 'human'), nem em falha incerta, mídia ou telefone não identificado.
-- Aplicada em produção em 17/10/2026. Desligar: select cron.unschedule('cw-expirar-pausas');
create or replace function cw_private.expirar_pausas() returns int
language plpgsql set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select c.id cid, c.restaurant_id, c.instance_id, h.id hid, h.reason_code
    from cw_conversations c
    join cw_instances i on i.id = c.instance_id and i.ai_enabled
    join cw_handoffs h on h.conversation_id = c.id and h.status = 'pending'
    where c.state = 'waiting_human'
      and h.reason_code in ('external_reply', 'legacy_handoff')
      -- equipe falou nos últimos 10 min (aviso "Seu pedido #N" do painel não conta)
      and not exists (
        select 1 from cw_messages m
        where m.conversation_id = c.id and m.direction = 'out'
          and m.author in ('external', 'human')
          and coalesce(m.text, '') !~ 'Seu pedido \*#[0-9]+\*'
          and m.created_at >= now() - interval '10 minutes')
      -- não atropela mensagem ainda saindo (ex.: "estou confirmando a taxa")
      and not exists (
        select 1 from cw_messages m
        where m.conversation_id = c.id and m.status in ('pending', 'sending', 'unknown'))
      and (
        h.reason_code = 'external_reply'            -- pausa por celular sem fala recente, ou só aviso do painel
        or h.reason_detail like 'TAXA DE ENTREGA%'  -- taxa não pausava no agente original
        or h.created_at < now() - interval '10 minutes')
    for update of c skip locked
  loop
    update cw_conversations
       set state = 'ai', assignee_id = null, control_epoch = control_epoch + 1, updated_at = now()
     where id = r.cid;
    update cw_handoffs set status = 'resolved', resolved_at = now() where id = r.hid;
    insert into cw_activity_log(restaurant_id, instance_id, conversation_id, actor_id, action, details)
    values (r.restaurant_id, r.instance_id, r.cid, null, 'pause_expired',
            jsonb_build_object('fonte', 'cron', 'motivo', r.reason_code));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function cw_private.expirar_pausas() from public;

select cron.schedule('cw-expirar-pausas', '30 seconds', 'select cw_private.expirar_pausas()');
