"use strict";
const { randomUUID } = require("node:crypto");
const { transaction, withLocks } = require("./database");
const {
  assert,
  digest,
  isCurrent,
  deliveryStatus,
  validateDecision,
} = require("./domain");
const { normalizeEvents, parseMessage } = require("./evolution");
class Engine {
  constructor({ pool, config, evolution, decide }) {
    Object.assign(this, { pool, config, evolution, decide });
  }
  async member(q, userId, admin = false) {
    const { rows } = await q.query(
      "select * from cw_members where restaurant_id=$1 and user_id=$2 and active for share",
      [this.config.restaurantId, userId],
    );
    assert(
      rows[0] && (!admin || rows[0].role === "admin"),
      403,
      "Acesso não autorizado.",
    );
    return rows[0];
  }
  async audit(q, c, actor, action, details = {}) {
    await q.query(
      "insert into cw_activity_log(restaurant_id,instance_id,conversation_id,actor_id,action,details) values($1,$2,$3,$4,$5,$6)",
      [
        this.config.restaurantId,
        c.instance_id || c.id,
        c.chat_jid ? c.id : null,
        actor,
        action,
        details,
      ],
    );
  }
  async job(q, type, instanceId, conversationId, payload, key, delay = 0) {
    await q.query(
      "insert into cw_private.jobs(restaurant_id,instance_id,conversation_id,type,payload,dedup_key,run_after) values($1,$2,$3,$4,$5,$6,now()+($7*interval '1 millisecond')) on conflict(dedup_key) do nothing",
      [
        this.config.restaurantId,
        instanceId,
        conversationId,
        type,
        payload,
        key,
        delay,
      ],
    );
  }
  async context(q, id) {
    const { rows } = await q.query(
      "select c.*, i.ai_enabled,i.config_epoch,i.connection_state from cw_conversations c join cw_instances i on i.id=c.instance_id and i.restaurant_id=c.restaurant_id where c.id=$1 and c.restaurant_id=$2",
      [id, this.config.restaurantId],
    );
    assert(rows[0], 404, "Conversa não encontrada.");
    return rows[0];
  }
  async cancelPending(q, c, aiOnly = false) {
    await q.query(
      "update cw_messages set status='cancelled',updated_at=now() where conversation_id=$1 and status='pending'" +
        (aiOnly ? " and author='ai'" : ""),
      [c.id],
    );
  }
  async handoff(q, c, code, detail, summary = "") {
    if (c.state === "human" || c.state === "closed") return;
    if (c.state === "waiting_human") {
      const active = await q.query(
        "select id from cw_handoffs where conversation_id=$1 and status in ('pending','claimed')",
        [c.id],
      );
      if (active.rows.length) return;
    }
    await q.query(
      "update cw_conversations set state='waiting_human',assignee_id=null,control_epoch=control_epoch+1,updated_at=now() where id=$1",
      [c.id],
    );
    await q.query(
      "insert into cw_handoffs(restaurant_id,instance_id,conversation_id,status,reason_code,reason_detail,summary) values($1,$2,$3,'pending',$4,$5,$6) on conflict(conversation_id) where status in ('pending','claimed') do update set status='pending',reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,summary=excluded.summary",
      [c.restaurant_id, c.instance_id, c.id, code, detail, summary],
    );
    await this.cancelPending(q, c, true);
    await this.audit(q, c, null, "handoff", { reason_code: code });
  }
  async idempotent(q, user, key, action, body, fn) {
    assert(
      require("./domain").uuid(key),
      400,
      "Idempotency-Key UUID obrigatório.",
    );
    await this.member(q, user);
    await q.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      "cw:request:" + user + ":" + key,
    ]);
    const fingerprint = digest({ action, body });
    const { rows } = await q.query(
      "select * from cw_private.api_requests where restaurant_id=$1 and user_id=$2 and key=$3",
      [this.config.restaurantId, user, key],
    );
    if (rows[0]) {
      assert(
        rows[0].fingerprint === fingerprint,
        409,
        "Chave já utilizada em outra ação.",
      );
      return { status: rows[0].status_code, body: rows[0].response };
    }
    const result = await fn();
    await q.query(
      "insert into cw_private.api_requests(restaurant_id,user_id,key,fingerprint,response,status_code) values($1,$2,$3,$4,$5,$6)",
      [
        this.config.restaurantId,
        user,
        key,
        fingerprint,
        result.body,
        result.status,
      ],
    );
    return result;
  }
  async command(user, id, action, body, key) {
    const preliminary = await this.context(this.pool, id);
    return withLocks(
      this.pool,
      preliminary.instance_id,
      preliminary.chat_jid,
      (q) =>
        transaction(q, () =>
          this.idempotent(q, user, key, action + ":" + id, body, async () => {
            const c = await this.context(q, id),
              m = await this.member(q, user);
            const own = c.state === "human" && c.assignee_id === user;
            if (action === "claim") {
              if (own) return { status: 200, body: c };
              assert(
                ["ai", "waiting_human"].includes(c.state),
                409,
                "Conversa encerrada ou assumida por outra pessoa.",
              );
              await q.query(
                "update cw_conversations set state='human',assignee_id=$2,control_epoch=control_epoch+1,updated_at=now() where id=$1",
                [id, user],
              );
              await q.query(
                "insert into cw_handoffs(restaurant_id,instance_id,conversation_id,status,reason_code,reason_detail) values($1,$2,$3,'claimed','manual_claim','Assumido no painel') on conflict(conversation_id) where status in ('pending','claimed') do update set status='claimed'",
                [c.restaurant_id, c.instance_id, id],
              );
              await this.cancelPending(q, c, true);
            } else if (action === "messages") {
              assert(own, 403, "Assuma a conversa antes de enviar.");
              assert(
                typeof body.text === "string" &&
                  body.text.trim().length > 0 &&
                  body.text.length <= 4000,
                400,
                "Envie de 1 a 4000 caracteres.",
              );
              const count = await q.query(
                "select count(*)::int as n from cw_messages where author_id=$1 and created_at>now()-interval '1 minute'",
                [user],
              );
              assert(
                count.rows[0].n < 30,
                429,
                "Aguarde antes de enviar novas mensagens.",
              );
              const messageId = randomUUID();
              await q.query(
                "insert into cw_messages(id,restaurant_id,instance_id,conversation_id,cycle,direction,author,author_id,text,status,control_epoch) values($1,$2,$3,$4,$5,'out','human',$6,$7,'pending',$8)",
                [
                  messageId,
                  c.restaurant_id,
                  c.instance_id,
                  c.id,
                  c.cycle,
                  user,
                  body.text.trim(),
                  c.control_epoch,
                ],
              );
              await this.job(
                q,
                "send",
                c.instance_id,
                c.id,
                { messageId },
                "send:" + messageId,
              );
              await this.audit(q, c, user, "human_message_queued", {
                message_id: messageId,
              });
              return {
                status: 202,
                body: { id: messageId, status: "pending" },
              };
            } else if (action === "resolve-message") {
              assert(m.role === "admin", 403, "Apenas administrador.");
              assert(
                typeof body.note === "string" &&
                  body.note.trim().length >= 8 &&
                  body.note.length <= 500,
                400,
                "Registre a conferência realizada.",
              );
              const r = await q.query(
                "update cw_messages set status='failed',updated_at=now() where id=$1 and conversation_id=$2 and status='unknown' returning id",
                [body.messageId, id],
              );
              assert(r.rows[0], 409, "Envio não está incerto.");
              await this.audit(q, c, user, "unknown_resolved", {
                message_id: body.messageId,
                note: body.note,
              });
              return { status: 200, body: { resolved: true } };
            } else {
              assert(
                own || m.role === "admin",
                403,
                "Ação restrita ao responsável ou administrador.",
              );
              const pending = await q.query(
                "select id from cw_messages where conversation_id=$1 and author='human' and status in ('sending','unknown') limit 1",
                [id],
              );
              assert(
                !pending.rows.length,
                409,
                "Resolva o envio humano incerto antes de mudar o atendimento.",
              );
              if (action === "close" && c.state === "closed")
                return { status: 200, body: c };
              if (action === "transfer") {
                assert(
                  m.role === "admin" && c.state === "human",
                  403,
                  "Transferência exige administrador e atendimento humano.",
                );
                const target = await this.member(q, body.userId);
                await q.query(
                  "update cw_conversations set assignee_id=$2,control_epoch=control_epoch+1,updated_at=now() where id=$1",
                  [id, target.user_id],
                );
              } else if (action === "release") {
                assert(
                  c.state === "human",
                  409,
                  "A conversa não está em atendimento humano.",
                );
                await q.query(
                  "update cw_conversations set state='waiting_human',assignee_id=null,control_epoch=control_epoch+1,updated_at=now() where id=$1",
                  [id],
                );
                await q.query(
                  "update cw_handoffs set status='pending' where conversation_id=$1 and status='claimed'",
                  [id],
                );
              } else if (action === "resume-ai" || action === "close") {
                if (action === "resume-ai")
                  assert(
                    c.state === "human" && c.ai_enabled,
                    409,
                    "A IA deve estar habilitada e a conversa assumida.",
                  );
                await q.query(
                  "update cw_conversations set state=$2,assignee_id=null,control_epoch=control_epoch+1,closed_at=case when $2='closed' then now() else null end,updated_at=now() where id=$1",
                  [id, action === "close" ? "closed" : "ai"],
                );
                await q.query(
                  "update cw_handoffs set status='resolved',resolved_at=now() where conversation_id=$1 and status in ('pending','claimed')",
                  [id],
                );
                // Retomada aguarda a próxima mensagem: não responde perguntas antigas automaticamente.
              } else assert(false, 404, "Ação não encontrada.");
              await this.cancelPending(q, c);
            }
            await this.audit(
              q,
              c,
              user,
              action,
              action === "transfer" ? { to: body.userId } : {},
            );
            return { status: 200, body: await this.context(q, id) };
          }),
        ),
    );
  }
  async setAI(user, id, enabled, key) {
    assert(typeof enabled === "boolean", 400, "Informe enabled booleano.");
    assert(
      this.config.instances.some((i) => i.id === id),
      404,
      "Instância inválida.",
    );
    return withLocks(
      this.pool,
      id,
      null,
      (q) =>
        transaction(q, () =>
          this.idempotent(
            q,
            user,
            key,
            "instance-ai:" + id,
            { enabled },
            async () => {
              await this.member(q, user, true);
              const { rows } = await q.query(
                "select * from cw_instances where id=$1 and restaurant_id=$2",
                [id, this.config.restaurantId],
              );
              const i = rows[0];
              assert(i, 404, "Instância não encontrada.");
              if (i.ai_enabled !== enabled) {
                await q.query(
                  "update cw_instances set ai_enabled=$2,config_epoch=config_epoch+1 where id=$1",
                  [id, enabled],
                );
                await q.query(
                  "update cw_messages set status='cancelled',updated_at=now() where instance_id=$1 and author='ai' and status='pending'",
                  [id],
                );
                if (!enabled) {
                  const cs = await q.query(
                    "select * from cw_conversations where instance_id=$1 and state='ai'",
                    [id],
                  );
                  for (const c of cs.rows)
                    await this.handoff(
                      q,
                      c,
                      "instance_paused",
                      "IA pausada pelo administrador.",
                    );
                }
                await this.audit(q, i, user, "instance_ai_changed", {
                  enabled,
                });
              }
              return { status: 200, body: { enabled } };
            },
          ),
        ),
      true,
    );
  }
  async setMemberActive(user, target, active, key) {
    assert(
      require("./domain").uuid(target) && typeof active === "boolean",
      400,
      "Membro inválido.",
    );
    assert(
      target !== user,
      409,
      "Uma administradora não pode remover seu próprio acesso.",
    );
    const ids = this.config.instances.map((i) => i.id).sort();
    return withLocks(
      this.pool,
      ids,
      null,
      (q) =>
        transaction(q, () =>
          this.idempotent(
            q,
            user,
            key,
            "member-access:" + target,
            { active },
            async () => {
              await this.member(q, user, true);
              const member = (
                await q.query(
                  "select * from cw_members where restaurant_id=$1 and user_id=$2",
                  [this.config.restaurantId, target],
                )
              ).rows[0];
              assert(member, 404, "Membro não encontrado.");
              if (member.active !== active) {
                const conversations = (
                  await q.query(
                    "select * from cw_conversations where restaurant_id=$1 and assignee_id=$2 and state='human'",
                    [this.config.restaurantId, target],
                  )
                ).rows;
                for (const c of conversations) {
                  const uncertain = await q.query(
                    "select id from cw_messages where conversation_id=$1 and author='human' and status in ('sending','unknown') limit 1",
                    [c.id],
                  );
                  assert(
                    !uncertain.rows.length,
                    409,
                    "Resolva os envios incertos antes de desativar o responsável.",
                  );
                  await q.query(
                    "update cw_conversations set state='waiting_human',assignee_id=null,control_epoch=control_epoch+1,updated_at=now() where id=$1",
                    [c.id],
                  );
                  await q.query(
                    "update cw_handoffs set status='pending' where conversation_id=$1 and status='claimed'",
                    [c.id],
                  );
                  await this.cancelPending(q, c);
                  await this.audit(q, c, user, "member_conversation_released", {
                    member_id: target,
                  });
                }
                await q.query(
                  "update cw_members set active=$3 where restaurant_id=$1 and user_id=$2",
                  [this.config.restaurantId, target, active],
                );
                if (!active)
                  await q.query("delete from auth.sessions where user_id=$1", [
                    target,
                  ]);
                await q.query(
                  "insert into cw_activity_log(restaurant_id,actor_id,action,details) values($1,$2,$3,$4)",
                  [
                    this.config.restaurantId,
                    user,
                    "member_access_changed",
                    { member_id: target, active },
                  ],
                );
              }
              return { status: 200, body: { userId: target, active } };
            },
          ),
        ),
      true,
    );
  }
  async receive(instanceId, body) {
    const i = this.config.instances.find((i) => i.id === instanceId);
    assert(
      i && body.instance === i.name,
      403,
      "Instância não corresponde ao endpoint.",
    );
    const events = normalizeEvents(body),
      q = await this.pool.connect();
    try {
      await transaction(q, async () => {
        for (const e of events)
          await this.job(
            q,
            "webhook",
            i.id,
            null,
            e,
            "webhook:" + i.id + ":" + e.dedup,
          );
      });
    } finally {
      q.release();
    }
    return { accepted: true, events: events.length };
  }
  async ingest(instanceId, event) {
    if (event.event === "CONNECTION_UPDATE") {
      const value = event.data?.state;
      assert(
        ["open", "close", "connecting"].includes(value),
        422,
        "Estado de conexão inválido.",
      );
      // Atualização consultada pelo próprio worker prevalece sobre um webhook atrasado.
      await this.refreshConnection(instanceId);
      return;
    }
    if (event.event === "MESSAGES_UPDATE")
      return this.updateStatus(instanceId, event.data);
    if (event.event === "SEND_MESSAGE")
      assert(
        event.data?.key?.fromMe === true,
        422,
        "Evento de saída inválido.",
      );
    const msg = parseMessage(event.data);
    if (!msg) return { discarded: true };
    return withLocks(this.pool, instanceId, msg.jid, (q) =>
      transaction(q, async () => {
        const inst = (
          await q.query(
            "select * from cw_instances where id=$1 and restaurant_id=$2",
            [instanceId, this.config.restaurantId],
          )
        ).rows[0];
        assert(inst, 404, "Instância não cadastrada.");
        await q.query(
          "insert into cw_conversations(restaurant_id,instance_id,chat_jid,customer_name,phone,state,closed_at) values($1,$2,$3,$4,$5,$6,case when $6='closed' then now() else null end) on conflict(instance_id,chat_jid) do nothing",
          [
            inst.restaurant_id,
            inst.id,
            msg.jid,
            msg.name,
            msg.phone,
            msg.fromMe ? "closed" : inst.ai_enabled ? "ai" : "waiting_human",
          ],
        );
        let c = (
          await q.query(
            "select * from cw_conversations where instance_id=$1 and chat_jid=$2",
            [instanceId, msg.jid],
          )
        ).rows[0];
        if (msg.fromMe) {
          const known = await q.query(
            "select id,status from cw_messages where conversation_id=$1 and direction='out' and provider_id=$2",
            [c.id, msg.providerId],
          );
          if (known.rows[0]) return;
          // Nunca atribuir pelo texto/horário: um POST incerto pode ter produzido este eco.
          const uncertain = await q.query(
            "select id from cw_messages where conversation_id=$1 and status in ('sending','unknown') limit 1",
            [c.id],
          );
          if (uncertain.rows.length)
            throw Object.assign(
              new Error("Eco aguardando reconciliação por ID."),
              { quarantine: true },
            );
        }
        const newCycle =
          c.state === "closed" && !msg.fromMe ? c.cycle + 1 : c.cycle;
        const inserted = await q.query(
          "insert into cw_messages(restaurant_id,instance_id,conversation_id,cycle,direction,author,provider_id,kind,text,media_key,status,provider_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(instance_id,conversation_id,direction,provider_id) do nothing returning id",
          [
            inst.restaurant_id,
            inst.id,
            c.id,
            newCycle,
            msg.fromMe ? "out" : "in",
            msg.fromMe ? "external" : "customer",
            msg.providerId,
            msg.kind,
            msg.text,
            msg.mediaKey,
            msg.fromMe ? "accepted" : "received",
            msg.providerAt,
          ],
        );
        if (!inserted.rows.length) return { duplicate: true };
        if (msg.fromMe) {
          if (c.state === "human") {
            await this.audit(q, c, null, "external_reply_during_human");
            return;
          }
          if (c.state === "closed") {
            await this.audit(q, c, null, "external_outbound_while_closed");
            return; // Disparos de oferta não representam um pedido de ajuda do cliente.
          }
          c = await this.context(q, c.id);
          await this.handoff(
            q,
            c,
            "external_reply",
            "Resposta externa pelo WhatsApp. Conferir antes de retomar.",
          );
          return;
        }
        await q.query(
          "update cw_conversations set customer_name=$2,phone=coalesce($3,phone),inbound_seq=inbound_seq+1,updated_at=now(),cycle=$4,ai_clarification_count=case when state='closed' then 0 else ai_clarification_count end,control_epoch=control_epoch+case when state='closed' then 1 else 0 end,state=case when state='closed' then $5 else state end,closed_at=null where id=$1",
          [
            c.id,
            msg.name,
            msg.phone,
            newCycle,
            inst.ai_enabled ? "ai" : "waiting_human",
          ],
        );
        c = await this.context(q, c.id);
        if (msg.kind !== "text" && c.state === "ai")
          await this.handoff(
            q,
            c,
            "unsupported_media",
            "Mídia recebida: " + msg.kind,
            "A mídia está disponível para conferência humana.",
          );
        else if (c.state === "waiting_human")
          await this.handoff(
            q,
            c,
            "human_queue",
            "Aguardando atendimento humano.",
          );
        else if (c.state === "ai" && !inst.ai_enabled)
          await this.handoff(
            q,
            c,
            "instance_paused",
            "IA pausada nesta instância.",
          );
        else if (c.state === "ai")
          await this.job(
            q,
            "ai",
            inst.id,
            c.id,
            {
              control_epoch: c.control_epoch,
              inbound_seq: c.inbound_seq,
              config_epoch: inst.config_epoch,
            },
            "ai:" +
              c.id +
              ":" +
              c.control_epoch +
              ":" +
              c.inbound_seq +
              ":" +
              inst.config_epoch,
            1500,
          );
        return { inserted: true };
      }),
    );
  }
  async updateStatus(instanceId, data) {
    const id = data?.key?.id || data?.keyId,
      jid = data?.key?.remoteJid || data?.remoteJid;
    const map = {
      SERVER_ACK: "accepted",
      DELIVERY_ACK: "delivered",
      READ: "read",
      PLAYED: "read",
      ERROR: "failed",
      2: "accepted",
      3: "delivered",
      4: "read",
      5: "read",
      0: "failed",
    };
    const status = map[data?.status ?? data?.update?.status];
    assert(id && jid && status, 422, "Atualização de entrega incompleta.");
    return withLocks(this.pool, instanceId, jid, (q) =>
      transaction(q, async () => {
        const result = await q.query(
          "select m.* from cw_messages m join cw_conversations c on c.id=m.conversation_id where m.instance_id=$1 and c.chat_jid=$2 and m.provider_id=$3 and m.direction='out'",
          [instanceId, jid, id],
        );
        for (const m of result.rows)
          await q.query(
            "update cw_messages set status=$2,updated_at=now() where id=$1",
            [m.id, deliveryStatus(m.status, status)],
          );
      }),
    );
  }
  async refreshConnection(id) {
    let state = "unknown";
    try {
      const r = await this.evolution.state(id);
      const s = r.instance?.state || r.state;
      if (["open", "close", "connecting"].includes(s)) state = s;
    } catch {}
    await this.pool.query(
      "update cw_instances set connection_state=$2,checked_at=now() where id=$1 and restaurant_id=$3",
      [id, state, this.config.restaurantId],
    );
  }
  async runAI(job) {
    const completed = await this.pool.query(
      "select decision_key from cw_private.ai_decisions where decision_key=$1",
      [job.dedup_key],
    );
    if (completed.rows.length) return;
    const c = await this.context(this.pool, job.conversation_id);
    if (!isCurrent(c, c, job.payload)) return;
    const history = (
      await this.pool.query(
        "select direction,author,text,kind from cw_messages where conversation_id=$1 and cycle=$2 order by coalesce(provider_at,created_at) desc,created_at desc,id desc limit 50",
        [c.id, c.cycle],
      )
    ).rows.reverse();
    let decision;
    try {
      decision = validateDecision(
        await this.decide({
          restaurantId: c.restaurant_id,
          instanceId: c.instance_id,
          conversationId: c.id,
          controlEpoch: c.control_epoch,
          inboundSeq: c.inbound_seq,
          history,
          clarificationCount: c.ai_clarification_count,
        }),
      );
    } catch {
      decision = {
        action: "handoff",
        reason_code: "ai_error",
        reason_detail: "O agente não conseguiu concluir com segurança.",
        summary: "Verifique o histórico e responda ao cliente.",
      };
    }
    return withLocks(this.pool, c.instance_id, c.chat_jid, (q) =>
      transaction(q, async () => {
        await this.checkLease(q, job);
        const fresh = await this.context(q, c.id);
        if (!isCurrent(fresh, fresh, job.payload)) return;
        if (
          decision.action === "reply" &&
          decision.clarification &&
          fresh.ai_clarification_count >= 2
        )
          decision = {
            action: "handoff",
            reason_code: "clarification_limit",
            reason_detail: "Limite de esclarecimentos atingido.",
            summary: "Conferir dúvidas ainda pendentes no histórico.",
          };
        const recorded = await q.query(
          "insert into cw_private.ai_decisions(decision_key,restaurant_id,instance_id,conversation_id,action) values($1,$2,$3,$4,$5) on conflict(decision_key) do nothing returning decision_key",
          [
            job.dedup_key,
            c.restaurant_id,
            c.instance_id,
            c.id,
            decision.action,
          ],
        );
        if (!recorded.rows.length) return;
        await this.audit(q, fresh, null, "ai_decision", {
          action: decision.action,
          prompt_version: "central-v1",
          knowledge_version: "legacy-catalog",
        });
        if (decision.action === "handoff")
          return this.handoff(
            q,
            fresh,
            decision.reason_code,
            decision.reason_detail,
            decision.summary,
          );
        if (decision.action !== "reply") return;
        const messageId = randomUUID();
        await q.query(
          "insert into cw_messages(id,restaurant_id,instance_id,conversation_id,cycle,direction,author,text,status,control_epoch,inbound_seq,config_epoch) values($1,$2,$3,$4,$5,'out','ai',$6,'pending',$7,$8,$9)",
          [
            messageId,
            c.restaurant_id,
            c.instance_id,
            c.id,
            c.cycle,
            decision.text,
            fresh.control_epoch,
            fresh.inbound_seq,
            fresh.config_epoch,
          ],
        );
        if (decision.clarification)
          await q.query(
            "update cw_conversations set ai_clarification_count=ai_clarification_count+1 where id=$1",
            [c.id],
          );
        await this.job(
          q,
          "send",
          c.instance_id,
          c.id,
          { messageId },
          "send:" + messageId,
        );
      }),
    );
  }
  async checkLease(q, job) {
    const { rows } = await q.query(
      "select id from cw_private.jobs where id=$1 and lease_token=$2 and status='running' and lease_until>now() for update",
      [job.id, job.lease_token],
    );
    assert(rows.length, 409, "Lease de trabalho perdido.");
  }
  async dispatch(job) {
    const c = await this.context(this.pool, job.conversation_id);
    return withLocks(this.pool, c.instance_id, c.chat_jid, async (q) => {
      let message;
      await transaction(q, async () => {
        await this.checkLease(q, job);
        const fresh = await this.context(q, c.id);
        message = (
          await q.query(
            "select * from cw_messages where id=$1 and conversation_id=$2",
            [job.payload.messageId, c.id],
          )
        ).rows[0];
        if (!message) return;
        if (message.status === "sending") {
          await q.query(
            "update cw_messages set status='unknown',updated_at=now() where id=$1",
            [message.id],
          );
          message = null;
          return;
        }
        if (message.status !== "pending") {
          message = null;
          return;
        }
        let valid =
          message.author === "ai"
            ? isCurrent(fresh, fresh, message)
            : fresh.state === "human" &&
              fresh.assignee_id === message.author_id &&
              String(fresh.control_epoch) === String(message.control_epoch);
        if (message.author === "human") {
          const m = await q.query(
            "select active from cw_members where restaurant_id=$1 and user_id=$2 for share",
            [c.restaurant_id, message.author_id],
          );
          valid = valid && m.rows[0]?.active;
        }
        if (!valid) {
          await q.query(
            "update cw_messages set status='cancelled' where id=$1",
            [message.id],
          );
          message = null;
          return;
        }
        // Falha de conexão conhecida ocorre ANTES do POST e pode voltar à fila.
        assert(
          fresh.connection_state === "open",
          503,
          "Instância desconectada.",
        );
        await q.query(
          "update cw_messages set status='sending',updated_at=now() where id=$1",
          [message.id],
        );
      });
      if (!message) return;
      let status = "unknown",
        providerId = null;
      try {
        const result = await this.evolution.send(
          c.instance_id,
          c.chat_jid,
          message.text,
        );
        providerId = result.key?.id || null;
        status = providerId ? "accepted" : "unknown";
      } catch (e) {
        // Toda resposta ambígua fica unknown, inclusive 5xx. Não reenvia POST automaticamente.
        if ([400, 401, 403, 404, 422].includes(e.httpStatus)) status = "failed";
      }
      await transaction(q, async () => {
        await q.query(
          "update cw_messages set status=$2,provider_id=$3,updated_at=now() where id=$1",
          [message.id, status, providerId],
        );
        await this.audit(q, c, null, "dispatch_result", {
          message_id: message.id,
          status,
        });
      });
    });
  }
  async lease() {
    const q = await this.pool.connect();
    try {
      return await transaction(q, async () => {
        const r = await q.query(
          "select * from cw_private.jobs where (status='pending' and run_after<=now()) or (status='running' and lease_until<now()) order by run_after,created_at for update skip locked limit 1",
        );
        const job = r.rows[0];
        if (!job) return null;
        const token = randomUUID();
        await q.query(
          "update cw_private.jobs set status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '90 seconds',updated_at=now() where id=$1",
          [job.id, token],
        );
        return { ...job, attempts: job.attempts + 1, lease_token: token };
      });
    } finally {
      q.release();
    }
  }
  async tick() {
    const job = await this.lease();
    if (!job) return false;
    const timer = setInterval(
      () =>
        this.pool
          .query(
            "update cw_private.jobs set lease_until=now()+interval '90 seconds' where id=$1 and lease_token=$2 and status='running' and lease_until>now()",
            [job.id, job.lease_token],
          )
          .catch(() => {}),
      20000,
    );
    try {
      if (job.type === "webhook")
        await this.ingest(job.instance_id, job.payload);
      if (job.type === "ai") await this.runAI(job);
      if (job.type === "send") await this.dispatch(job);
      await this.pool.query(
        "update cw_private.jobs set status='done',lease_token=null,lease_until=null,updated_at=now() where id=$1 and lease_token=$2",
        [job.id, job.lease_token],
      );
    } catch (e) {
      const quarantine = e.status === 422 || e.quarantine;
      const status = quarantine
        ? "quarantine"
        : job.attempts >= 5
          ? "failed"
          : "pending";
      const delay =
        [2, 5, 15, 60, 180][Math.min(job.attempts - 1, 4)] + Math.random();
      await this.pool.query(
        "update cw_private.jobs set status=$3,run_after=now()+($4*interval '1 second'),last_error=$5,lease_token=null,lease_until=null,updated_at=now() where id=$1 and lease_token=$2",
        [
          job.id,
          job.lease_token,
          status,
          delay,
          quarantine
            ? "Contrato do evento requer revisão."
            : "Falha no processamento.",
        ],
      );
    } finally {
      clearInterval(timer);
    }
    return true;
  }
}
module.exports = { Engine };
