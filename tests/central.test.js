"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { testDatabase, USERS } = require("./database");
const { Engine } = require("../src/central/engine");
const { configuration, IDS } = require("../src/central/config");
const {
  digest,
  sanitize,
  secretEqual,
  deliveryStatus,
} = require("../src/central/domain");
const {
  parseMessage,
  normalizeEvents,
  createEvolution,
} = require("../src/central/evolution");
const { createApp } = require("../src/central/server");
const payload = (
  id = "m1",
  text = "Olá",
  fromMe = false,
  jid = "554400000000@s.whatsapp.net",
) => ({
  event: "MESSAGES_UPSERT",
  data: {
    key: { id, fromMe, remoteJid: jid },
    message: { conversation: text },
    pushName: "Cliente teste",
    messageTimestamp: 1792040000,
  },
});
async function setup() {
  const { pool, db } = await testDatabase();
  const config = configuration({
    WEBHOOK_PRIMARY_SECRET: "a".repeat(64),
    WEBHOOK_SECONDARY_SECRET: "b".repeat(64),
  });
  let sends = [];
  await pool.query("update cw_instances set connection_state='open'");
  const evolution = {
    state: async () => ({ instance: { state: "open" } }),
    send: async (id, jid, text) => {
      sends.push({ id, jid, text });
      return { key: { id: "sent-" + sends.length } };
    },
    media: async () => ({
      base64: "aGVsbG8=",
      mimetype: "application/octet-stream",
    }),
  };
  const engine = new Engine({
    pool,
    config,
    evolution,
    decide: async () => ({
      action: "reply",
      text: "Olá!",
      clarification: false,
    }),
  });
  return { pool, db, engine, config, evolution, sends };
}
async function ingest(s, id = IDS.primary, data = payload().data) {
  await s.engine.ingest(id, { event: "MESSAGES_UPSERT", data });
  return (
    await s.pool.query("select * from cw_conversations where instance_id=$1", [
      id,
    ])
  ).rows[0];
}
async function due(s) {
  await s.pool.query(
    "update cw_private.jobs set run_after=now()-interval '1 second' where status='pending'",
  );
}

test("segredos, sanitização e deduplicação estável", () => {
  assert.equal(secretEqual("a".repeat(32), "a".repeat(32)), true);
  assert.equal(secretEqual("x", "short"), false);
  const clean = sanitize({
    apikey: "segredo",
    data: {
      base64: "large",
      message: { conversation: "oi" },
      url: "https://sensitive",
    },
  });
  assert.equal(JSON.stringify(clean).includes("segredo"), false);
  assert.equal(JSON.stringify(clean).includes("base64"), false);
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.equal(
    normalizeEvents({ ...payload(), event: "messages.upsert" }).length,
    1,
  );
});
test("JID LID não vira telefone; grupos, reações e histórico não geram mensagens", () => {
  const lid = parseMessage(payload("lid", "oi", false, "1234@lid").data);
  assert.equal(lid.phone, null);
  assert.equal(lid.jid, "1234@lid");
  assert.equal(
    parseMessage(payload("group", "oi", false, "123@g.us").data),
    null,
  );
  const d = payload().data;
  d.message = { reactionMessage: { text: "👍" } };
  assert.equal(parseMessage(d), null);
  assert.equal(parseMessage({ ...payload().data, isHistory: true }), null);
  assert.throws(
    () => parseMessage({}),
    (e) => e.status === 422,
  );
});
test("Evolution usa chave e nome da instância correta, com espaços escapados", async () => {
  const seen = [];
  const cfg = configuration({
    EVOLUTION_PRIMARY_KEY: "key1",
    EVOLUTION_SECONDARY_KEY: "key2",
  });
  const ev = createEvolution(cfg, async (url, options) => {
    seen.push({ url, options });
    return { ok: true, json: async () => ({ key: { id: "x" } }) };
  });
  await ev.send(IDS.primary, "123@lid", "teste");
  await ev.send(IDS.secondary, "123@s.whatsapp.net", "teste");
  assert.ok(seen[0].url.endsWith("Chapela%20-%20atendimento"));
  assert.equal(seen[0].options.headers.apikey, "key1");
  assert.ok(seen[1].url.endsWith("/chapelao"));
  assert.equal(seen[1].options.headers.apikey, "key2");
});
test("mesmo cliente/ID nos dois números tem dois históricos e escopo SQL composto", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await ingest(s);
  await ingest(s, IDS.secondary);
  assert.equal(
    (await s.pool.query("select * from cw_conversations")).rows.length,
    2,
  );
  assert.equal(
    (await s.pool.query("select * from cw_messages")).rows.length,
    2,
  );
  const c = (
    await s.pool.query("select * from cw_conversations where instance_id=$1", [
      IDS.primary,
    ])
  ).rows[0];
  await assert.rejects(
    () =>
      s.pool.query(
        "insert into cw_messages(restaurant_id,instance_id,conversation_id,cycle,direction,author,text,status) values($1,$2,$3,1,'in','customer','erro','received')",
        [IDS.restaurant, IDS.secondary, c.id],
      ),
    (e) => e.code === "23503",
  );
});
test("cinco repetições geram uma mensagem, uma sequência e um handoff", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  for (let n = 0; n < 5; n++) await ingest(s);
  const c = (await s.pool.query("select * from cw_conversations")).rows[0];
  assert.equal(Number(c.inbound_seq), 1);
  assert.equal(
    (await s.pool.query("select * from cw_messages")).rows.length,
    1,
  );
  assert.equal(
    (await s.pool.query("select * from cw_handoffs")).rows.length,
    1,
  );
});
test("assunção é exclusiva, persistente, idempotente e revalida membership", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const c = await ingest(s),
    key = randomUUID();
  const results = await Promise.allSettled([
    s.engine.command(USERS.alice, c.id, "claim", {}, key),
    s.engine.command(USERS.bob, c.id, "claim", {}, randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const same = await s.engine.command(USERS.alice, c.id, "claim", {}, key);
  assert.equal(same.body.assignee_id, USERS.alice);
  await assert.rejects(
    () => s.engine.command(USERS.alice, c.id, "close", {}, key),
    (e) => e.status === 409,
  );
  await s.pool.query("update cw_members set active=false where user_id=$1", [
    USERS.alice,
  ]);
  await assert.rejects(
    () => s.engine.command(USERS.alice, c.id, "claim", {}, key),
    (e) => e.status === 403,
  );
});
test("assumir enquanto IA gera descarta decisão antiga e não envia", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await s.engine.setAI(USERS.admin, IDS.primary, true, randomUUID());
  const c = await ingest(s);
  await due(s);
  const job = await s.engine.lease();
  s.engine.decide = async () => {
    await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
    return { action: "reply", text: "Resposta velha", clarification: false };
  };
  await s.engine.runAI(job);
  assert.equal(
    (await s.pool.query("select * from cw_messages where direction='out'")).rows
      .length,
    0,
  );
  assert.equal(s.sends.length, 0);
});
test("três mensagens rápidas invalidam os trabalhos antigos; pausa afeta só uma instância", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await s.engine.setAI(USERS.admin, IDS.primary, true, randomUUID());
  await s.engine.setAI(USERS.admin, IDS.secondary, true, randomUUID());
  for (let n = 0; n < 3; n++)
    await ingest(s, IDS.primary, payload("m" + n, "parte " + n).data);
  await due(s);
  for (let n = 0; n < 3; n++) await s.engine.tick();
  assert.equal(
    (await s.pool.query("select * from cw_messages where author='ai'")).rows
      .length,
    1,
  );
  await s.engine.setAI(USERS.admin, IDS.primary, false, randomUUID());
  assert.equal(
    (
      await s.pool.query("select ai_enabled from cw_instances where id=$1", [
        IDS.secondary,
      ])
    ).rows[0].ai_enabled,
    true,
  );
  assert.equal(
    (await s.pool.query("select * from cw_messages where author='ai'")).rows[0]
      .status,
    "cancelled",
  );
});
test("envio humano usa apenas a origem e timeout não repete POST", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const c = await ingest(s, IDS.secondary);
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  await s.engine.command(
    USERS.alice,
    c.id,
    "messages",
    { text: "Olá cliente" },
    randomUUID(),
  );
  await s.engine.tick();
  assert.deepEqual(
    s.sends.map((x) => x.id),
    [IDS.secondary],
  );
  s.evolution.send = async () => {
    s.sends.push({ id: IDS.secondary });
    throw new Error("timeout");
  };
  const result = await s.engine.command(
    USERS.alice,
    c.id,
    "messages",
    { text: "Resposta incerta" },
    randomUUID(),
  );
  await s.engine.tick();
  assert.equal(
    (
      await s.pool.query("select status from cw_messages where id=$1", [
        result.body.id,
      ])
    ).rows[0].status,
    "unknown",
  );
  await due(s);
  await s.engine.tick();
  assert.equal(s.sends.length, 2);
  await assert.rejects(
    () => s.engine.command(USERS.alice, c.id, "close", {}, randomUUID()),
    (e) => e.status === 409,
  );
});
test("envio sending após queda vira unknown; não é reenviado", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const c = await ingest(s);
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  const r = await s.engine.command(
    USERS.alice,
    c.id,
    "messages",
    { text: "teste" },
    randomUUID(),
  );
  await s.pool.query("update cw_messages set status='sending' where id=$1", [
    r.body.id,
  ]);
  await s.engine.tick();
  assert.equal(
    (
      await s.pool.query("select status from cw_messages where id=$1", [
        r.body.id,
      ])
    ).rows[0].status,
    "unknown",
  );
  assert.equal(s.sends.length, 0);
});
test("modo humano não agenda IA; fechar e reabrir incrementa ciclo só uma vez", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const c = await ingest(s);
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  await ingest(s, IDS.primary, payload("nova").data);
  assert.equal(
    (await s.pool.query("select * from cw_private.jobs where type='ai'")).rows
      .length,
    0,
  );
  await s.engine.command(USERS.alice, c.id, "close", {}, randomUUID());
  await ingest(s, IDS.primary, payload("reabertura").data);
  await ingest(s, IDS.primary, payload("reabertura").data);
  const fresh = await s.engine.context(s.pool, c.id);
  assert.equal(fresh.cycle, 2);
  assert.equal(fresh.state, "waiting_human");
});
test("RLS: membro lê escopo, visitante/externo não leem; browser não escreve", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await ingest(s);
  async function as(role, user, sql) {
    const q = await s.pool.connect();
    try {
      await q.query("begin");
      await q.query("set local role " + role);
      if (user)
        await q.query("select set_config('request.jwt.claim.sub',$1,true)", [
          user,
        ]);
      const r = await q.query(sql);
      await q.query("rollback");
      return r;
    } catch (e) {
      await q.query("rollback");
      throw e;
    } finally {
      q.release();
    }
  }
  assert.equal(
    (await as("authenticated", USERS.alice, "select * from cw_conversations"))
      .rows.length,
    1,
  );
  assert.equal(
    (
      await as(
        "authenticated",
        USERS.outsider,
        "select * from cw_conversations",
      )
    ).rows.length,
    0,
  );
  for (const table of [
    "cw_restaurants",
    "cw_members",
    "cw_settings",
    "cw_instances",
    "cw_conversations",
    "cw_messages",
    "cw_handoffs",
    "cw_activity_log",
  ]) {
    await assert.rejects(
      () => as("anon", null, "select * from " + table),
      (e) => e.code === "42501",
    );
    for (const op of [
      "delete from " + table,
      "update " + table + " set restaurant_id=restaurant_id",
    ]) {
      if (table === "cw_restaurants" && op.startsWith("update")) continue;
      await assert.rejects(
        () => as("authenticated", USERS.alice, op),
        (e) => e.code === "42501",
      );
    }
  }
  await assert.rejects(
    () => as("authenticated", USERS.alice, "select * from cw_private.jobs"),
    (e) => e.code === "42501",
  );
});
test("API: auth, origem, segredo, corpo e idempotência são exigidos", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const { app } = createApp({
    ...s,
    mediaStore: {
      retrieve: async () => ({
        bytes: Buffer.from("attachment"),
        mime: "image/png",
      }),
    },
    authenticate: async (token) => ({
      id: token === "admin" ? USERS.admin : USERS.alice,
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/conversations")).status, 401);
  assert.equal(
    (await fetch(base + "/webhook", { method: "POST" })).status,
    410,
  );
  assert.equal(
    (
      await fetch(base + "/api/webhooks/evolution/" + IDS.primary, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      })
    ).status,
    401,
  );
  const good = { ...payload(), instance: "Chapela - atendimento" };
  const h = {
    "Content-Type": "application/json",
    "X-Webhook-Secret": "a".repeat(64),
  };
  assert.equal(
    (
      await fetch(base + "/api/webhooks/evolution/" + IDS.primary, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ ...good, instance: "chapelao" }),
      })
    ).status,
    403,
  );
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await fetch(base + "/api/webhooks/evolution/" + IDS.primary, {
          method: "POST",
          headers: h,
          body: JSON.stringify(good),
        })
      ).status,
      200,
    );
  assert.equal(
    (await s.pool.query("select * from cw_private.jobs")).rows.length,
    1,
  );
  await s.engine.tick();
  const c = await s.engine.context(
    s.pool,
    (await s.pool.query("select id from cw_conversations")).rows[0].id,
  );
  const route = base + "/api/conversations/" + c.id + "/claim";
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: {
          Authorization: "Bearer admin",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: {
          Authorization: "Bearer admin",
          "Content-Type": "application/json",
          Origin: s.config.origin,
        },
        body: "{}",
      })
    ).status,
    400,
  );
  const deniedDestination = await fetch(
    base + "/api/conversations/" + c.id + "/messages",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
        Origin: s.config.origin,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ text: "oi", instanceId: IDS.secondary }),
    },
  );
  assert.equal(deniedDestination.status, 400);
  const ok = await fetch(route, {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "Content-Type": "application/json",
      Origin: s.config.origin,
      "Idempotency-Key": randomUUID(),
    },
    body: "{}",
  });
  assert.equal(ok.status, 200);
  const image = payload("image-api").data;
  image.message = { imageMessage: { caption: "foto" } };
  await ingest(s, IDS.primary, image);
  const imageId = (
    await s.pool.query(
      "select id from cw_messages where provider_id='image-api'",
    )
  ).rows[0].id;
  assert.equal(
    (await fetch(base + "/api/messages/" + imageId + "/media")).status,
    401,
  );
  const media = await fetch(base + "/api/messages/" + imageId + "/media", {
    headers: { Authorization: "Bearer admin" },
  });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/png");
});
test("status fora de ordem não rebaixa leitura", () => {
  assert.equal(deliveryStatus("read", "delivered"), "read");
  assert.equal(deliveryStatus("read", "failed"), "read");
  assert.equal(deliveryStatus("unknown", "delivered"), "delivered");
});

test("desativar membro devolve conversas, cancela fila e impede novas ações", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  const c = await ingest(s);
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  const message = await s.engine.command(
    USERS.alice,
    c.id,
    "messages",
    { text: "ainda não enviada" },
    randomUUID(),
  );
  await s.engine.setMemberActive(USERS.admin, USERS.alice, false, randomUUID());
  const fresh = await s.engine.context(s.pool, c.id);
  assert.equal(fresh.state, "waiting_human");
  assert.equal(fresh.assignee_id, null);
  assert.equal(
    (
      await s.pool.query("select status from cw_messages where id=$1", [
        message.body.id,
      ])
    ).rows[0].status,
    "cancelled",
  );
  await assert.rejects(
    () => s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID()),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () =>
      s.engine.setMemberActive(USERS.admin, USERS.admin, false, randomUUID()),
    (e) => e.status === 409,
  );
});
test("perder lease impede gravação de decisão e início de envio", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await s.engine.setAI(USERS.admin, IDS.primary, true, randomUUID());
  await ingest(s);
  await due(s);
  const job = await s.engine.lease();
  await s.pool.query("update cw_private.jobs set lease_token=$2 where id=$1", [
    job.id,
    randomUUID(),
  ]);
  await assert.rejects(
    () => s.engine.runAI(job),
    (e) => e.status === 409,
  );
  assert.equal(
    (await s.pool.query("select id from cw_messages where direction='out'"))
      .rows.length,
    0,
  );
});
test("mídia encaminha e resposta externa mantém controle humano persistente", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await s.engine.setAI(USERS.admin, IDS.primary, true, randomUUID());
  const p = payload().data;
  p.message = { imageMessage: { caption: "comprovante" } };
  const c = await ingest(s, IDS.primary, p);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "waiting_human");
  assert.equal(
    (
      await s.pool.query(
        "select reason_code from cw_handoffs where conversation_id=$1",
        [c.id],
      )
    ).rows[0].reason_code,
    "unsupported_media",
  );
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  await s.engine.command(USERS.alice, c.id, "resume-ai", {}, randomUUID());
  await ingest(
    s,
    IDS.primary,
    payload("externa", "Vou ajudar por aqui", true).data,
  );
  assert.equal((await s.engine.context(s.pool, c.id)).state, "waiting_human");
  assert.equal(
    (
      await s.pool.query(
        "select author from cw_messages where provider_id='externa'",
      )
    ).rows[0].author,
    "external",
  );
});
test("coordenador libera conexão ao falhar e adquire instância antes da conversa", async () => {
  const { withLocks } = require("../src/central/database");
  const calls = [];
  let released = false;
  const pool = {
    connect: async () => ({
      query: async (sql, args) => {
        calls.push({ sql, args });
        return { rows: [{ locked: true }] };
      },
      release: () => {
        released = true;
      },
    }),
  };
  await assert.rejects(() =>
    withLocks(pool, IDS.primary, "123@lid", async () => {
      throw new Error("rede caiu");
    }),
  );
  assert.ok(calls[0].args[0].includes("instance"));
  assert.ok(calls[1].args[0].includes("conversation"));
  assert.ok(calls.at(-1).sql.includes("unlock_all"));
  assert.equal(released, true);
});

test("replay após commit da decisão não cria segunda resposta ou job de envio", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  await s.engine.setAI(USERS.admin, IDS.primary, true, randomUUID());
  await ingest(s);
  await due(s);
  const job = await s.engine.lease();
  let calls = 0;
  s.engine.decide = async () => {
    calls++;
    return { action: "reply", text: "Uma resposta só", clarification: false };
  };
  await s.engine.runAI(job);
  await s.engine.runAI(job);
  assert.equal(calls, 1);
  assert.equal(
    (await s.pool.query("select id from cw_messages where author='ai'")).rows
      .length,
    1,
  );
  assert.equal(
    (await s.pool.query("select id from cw_private.jobs where type='send'"))
      .rows.length,
    1,
  );
});
