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

test("entrada interna não exige e-mail/senha e lembra a pessoa pelo cookie protegido", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  s.config.authMode = "internal_network";
  s.config.internalAllowedCidrs = ["127.0.0.1/32"];
  s.config.trustedProxyCidrs = [];
  s.config.internalSessionSecret = "s".repeat(64);
  const { app } = createApp({ ...s });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/me")).status, 401);
  const access = await (await fetch(base + "/api/internal/access")).json();
  assert.equal(access.members.length, 3);
  assert.equal(access.selected, null);
  assert.equal(
    (
      await fetch(base + "/api/internal/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: USERS.alice }),
      })
    ).status,
    403,
  );
  const choose = await fetch(base + "/api/internal/select", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: s.config.origin },
    body: JSON.stringify({ userId: USERS.alice }),
  });
  assert.equal(choose.status, 200);
  const raw = choose.headers.get("set-cookie");
  assert.ok(raw.includes("HttpOnly"));
  assert.ok(raw.includes("SameSite=Strict"));
  const cookie = raw.split(";")[0];
  for (let n = 0; n < 3; n++) {
    const r = await fetch(base + "/api/me", {
      headers: { Cookie: cookie, Authorization: "Bearer qualquer-coisa" },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, USERS.alice);
  }
  const persisted = await (
    await fetch(base + "/api/internal/access", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(persisted.selected, USERS.alice);
  const c = await ingest(s);
  const action = await fetch(base + "/api/conversations/" + c.id + "/claim", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: s.config.origin,
      "Idempotency-Key": randomUUID(),
    },
    body: "{}",
  });
  assert.equal(action.status, 200);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
  assert.equal(
    (await fetch(base + "/api/me", { headers: { Cookie: tampered } })).status,
    401,
  );
  await s.pool.query("update cw_members set active=false where user_id=$1", [
    USERS.alice,
  ]);
  assert.equal(
    (await fetch(base + "/api/me", { headers: { Cookie: cookie } })).status,
    403,
  );
  const out = await fetch(base + "/api/internal/logout", {
    method: "POST",
    headers: { Origin: s.config.origin, Cookie: cookie },
  });
  assert.equal(out.status, 200);
  assert.ok(out.headers.get("set-cookie").includes("Max-Age=0"));
});

test("modo interno bloqueia rede não autorizada e não confia em X-Forwarded-For arbitrário", async (t) => {
  const s = await setup();
  t.after(() => s.pool.end());
  s.config.authMode = "internal_network";
  s.config.internalAllowedCidrs = ["203.0.113.5/32"];
  s.config.trustedProxyCidrs = [];
  s.config.internalSessionSecret = "s".repeat(64);
  const { app } = createApp({ ...s });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const route of ["/api/internal/access", "/api/me", "/api/conversations"])
    assert.equal(
      (
        await fetch(base + route, {
          headers: {
            "X-Forwarded-For": "203.0.113.5",
            Authorization: "Bearer teste",
          },
        })
      ).status,
      403,
    );
  // O webhook mantém seu próprio segredo e pode chegar da Evolution fora da LAN.
  const body = { ...payload(), instance: "Chapela - atendimento" };
  assert.equal(
    (
      await fetch(base + "/api/webhooks/evolution/" + IDS.primary, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": "a".repeat(64),
        },
        body: JSON.stringify(body),
      })
    ).status,
    200,
  );
  const { createInternalAccess } = require("../src/central/internal-access");
  assert.throws(
    () =>
      createInternalAccess(
        { ...s.config, internalAllowedCidrs: ["0.0.0.0/0"] },
        s.pool,
      ),
    (e) => e.status === 503,
  );
  const unset = createInternalAccess(
    { ...s.config, internalAllowedCidrs: [] },
    s.pool,
  );
  assert.throws(
    () => unset.checkNetwork({ ip: "127.0.0.1" }),
    (e) => e.status === 503,
  );
});

test("aparelho ativado entra sem IP; link inválido e cookies adulterados não liberam dados", async (t) => {
  const s=await setup(); t.after(()=>s.pool.end());
  const {createHash}=require("node:crypto");
  const activation="t".repeat(48);
  Object.assign(s.config,{authMode:"trusted_device",internalSessionSecret:"s".repeat(64),deviceEnrollmentHash:createHash("sha256").update(activation).digest("hex"),deviceEnrollmentUntil:Date.now()+60000});
  const {app}=createApp({...s}); const server=app.listen(0,"127.0.0.1");
  await new Promise(r=>server.once("listening",r)); t.after(()=>new Promise(r=>server.close(r)));
  const base="http://127.0.0.1:"+server.address().port;
  for(const route of ["/api/internal/access","/api/me","/api/conversations"])
    assert.equal((await fetch(base+route)).status,403);
  const enroll=(token,origin=s.config.origin)=>fetch(base+"/api/internal/enroll",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({token})});
  assert.equal((await enroll(activation,"https://evil.example")).status,403);
  assert.equal((await enroll("x".repeat(48))).status,403);
  const result=await enroll(activation); assert.equal(result.status,200);
  const device=result.headers.get("set-cookie").split(";")[0];
  assert.ok(result.headers.get("set-cookie").includes("HttpOnly"));
  assert.equal((await (await fetch(base+"/api/internal/access",{headers:{Cookie:device}})).json()).members.length,3);
  const choice=await fetch(base+"/api/internal/select",{method:"POST",headers:{"Content-Type":"application/json",Origin:s.config.origin,Cookie:device},body:JSON.stringify({userId:USERS.alice})});
  assert.equal(choice.status,200);
  const cookie=device+"; "+choice.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base+"/api/me",{headers:{Cookie:cookie}})).status,200);
  // Knowing only an operator cookie cannot bypass device authorization.
  assert.equal((await fetch(base+"/api/me",{headers:{Cookie:choice.headers.get("set-cookie").split(";")[0]}})).status,403);
  s.config.deviceEnrollmentUntil=0; assert.equal((await enroll(activation)).status,403);
  assert.equal((await fetch(base+"/api/me",{headers:{Cookie:cookie}})).status,200);
  s.config.internalSessionSecret="z".repeat(64); assert.equal((await fetch(base+"/api/me",{headers:{Cookie:cookie}})).status,403);
});

test("oferta enviada externamente não cria chamado nem reabre conversa encerrada", async (t) => {
  const s=await setup();t.after(()=>s.pool.end());
  const initial=await ingest(s,IDS.secondary,payload("oferta1","Oferta de hoje",true).data);
  assert.equal(initial.state,"closed");
  assert.equal((await s.pool.query("select id from cw_handoffs")).rows.length,0);
  assert.equal((await s.pool.query("select id from cw_private.jobs where type='ai'")).rows.length,0);
  await ingest(s,IDS.secondary,payload("resposta1","Tenho interesse").data);
  const waiting=await s.engine.context(s.pool,initial.id);
  assert.equal(waiting.state,"waiting_human");
  assert.equal(waiting.cycle,2);
  await s.engine.command(USERS.alice,initial.id,"claim",{},randomUUID());
  await s.engine.command(USERS.alice,initial.id,"close",{},randomUUID());
  await ingest(s,IDS.secondary,payload("oferta2","Nova oferta",true).data);
  const closed=await s.engine.context(s.pool,initial.id);
  assert.equal(closed.state,"closed");
  assert.equal(closed.cycle,2);
  assert.equal((await s.pool.query("select id from cw_handoffs where status in ('pending','claimed')")).rows.length,0);
});

test("entrada direta abre sem cookie, ativação, e-mail ou senha, preservando origem e segredo do webhook", async t => {
  const s=await setup();t.after(()=>s.pool.end());s.config.authMode="open";s.config.openAccessUserId=USERS.admin;
  const {app}=createApp({...s});const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
  const base="http://127.0.0.1:"+server.address().port;
  const me=await fetch(base+"/api/me");assert.equal(me.status,200);assert.equal((await me.json()).name,"Equipe");
  assert.equal((await fetch(base+"/api/conversations")).status,200);
  assert.equal((await fetch(base+"/api/instances/"+IDS.primary+"/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:true})})).status,403);
  assert.equal((await fetch(base+"/api/webhooks/evolution/"+IDS.primary,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload(),instance:"Chapela - atendimento"})})).status,401);
  s.config.openAccessUserId=USERS.outsider;
  assert.equal((await fetch(base+"/api/me")).status,403);
});

async function fullSetup(t, processor) {
  const s=await setup();t.after(()=>s.pool.end());
  s.config.fullAgent=true;
  s.engine.processLegacy=processor;
  s.engine.loadLegacyHistory=async()=>[];
  s.engine.extractLegacy=({data})=>({telefone:"invalid",texto:data.message?.conversation||"",key:data.key,tipo:"text",pushName:"Cliente teste"});
  s.engine.recordLegacyAccepted=async()=>{};
  await s.engine.setAI(USERS.admin,IDS.primary,true,randomUUID());
  return s;
}
test("agente completo executa o fluxo original uma vez e envia pela outbox",async t=>{
 let runs=0;
 const s=await fullSetup(t,async msg=>{runs++;assert.equal(msg.telefone,"554400000000");await require("../src/central/legacy-context").current().respond(msg.telefone,"Pedido #42 confirmado pelo fluxo original.");});
 const c=await ingest(s);await due(s);const job=await s.engine.lease();
 await s.engine.runAI(job);await s.engine.runAI(job);
 assert.equal(runs,1);
 const rows=(await s.pool.query("select * from cw_messages where direction='out'")).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,"pending");
 const send=await s.engine.lease();await s.engine.dispatch(send);
 assert.equal(s.sends.length,1);
 assert.equal(s.sends[0].id,IDS.primary);assert.equal((await s.engine.context(s.pool,c.id)).state,"ai");
});
test("pedido original encaminha só quando solicitado e a confirmação para o cliente é cancelável",async t=>{
 const s=await fullSetup(t,async msg=>{const scope=require("../src/central/legacy-context").current();scope.requestHandoff("Cliente solicitou negociação.");await scope.respond(msg.telefone,"Vou chamar uma pessoa da equipe.");});
 const c=await ingest(s);await due(s);const job=await s.engine.lease();await s.engine.runAI(job);
 assert.equal((await s.engine.context(s.pool,c.id)).state,"waiting_human");
 const messages=(await s.pool.query("select * from cw_messages where direction='out'")).rows;
 assert.equal(messages[0].author,"system");
 await s.engine.command(USERS.alice,c.id,"claim",{},randomUUID());
 const send=await s.engine.lease();await s.engine.dispatch(send);
 assert.equal(s.sends.length,0);
});
test("interrupção depois de iniciar o agente completo pede conferência sem refazer pedido",async t=>{
 let calls=0;const s=await fullSetup(t,async()=>{calls++;});
 const c=await ingest(s);await due(s);const job=await s.engine.lease();
 await s.pool.query("insert into cw_private.legacy_runs(decision_key,restaurant_id,instance_id,conversation_id,status) values($1,$2,$3,$4,'running')",[job.dedup_key,IDS.restaurant,IDS.primary,c.id]);
 await s.engine.runAI(job);
 assert.equal(calls,0);
 assert.equal((await s.engine.context(s.pool,c.id)).state,"waiting_human");
 assert.equal((await s.pool.query("select status from cw_private.legacy_runs")).rows[0].status,"uncertain");
});
test("controle humano impede chamar o agente completo para tarefa antiga",async t=>{
 let calls=0;const s=await fullSetup(t,async()=>{calls++;});
 const c=await ingest(s);await due(s);const job=await s.engine.lease();
 await s.engine.command(USERS.alice,c.id,"claim",{},randomUUID());
 await s.engine.runAI(job);assert.equal(calls,0);
});
test("áudio e comprovante seguem ao fluxo original em vez de encaminhamento automático",async t=>{
 const s=await fullSetup(t,async()=>{});
 for(const [id,type]of [["audio-full","audioMessage"],["pix-full","imageMessage"]]){
  const data=payload(id).data;data.message={[type]:{caption:"comprovante"}};
  await s.engine.ingest(IDS.primary,{event:"MESSAGES_UPSERT",data});
 }
 assert.equal((await s.pool.query("select state from cw_conversations")).rows[0].state,"ai");
 const jobs=(await s.pool.query("select payload from cw_private.jobs where type='ai'")).rows;
 assert.equal(jobs.length,2);assert.equal(jobs[1].payload.providerMessage.key.id,"pix-full");
});
test("agente original entende confirmação por reação e telefone alternativo sem misturar JID",()=>{
 const p=payload("reaction").data;p.message={reactionMessage:{text:"👍"}};
 p.key.remoteJid="1234567@lid";p.key.remoteJidAlt="554400000000@s.whatsapp.net";
 const parsed=parseMessage(p,{fullAgent:true});
 assert.equal(parsed.text,"👍");assert.equal(parsed.phone,"554400000000");assert.equal(parsed.jid,"1234567@lid");
});
test("secundário continua humano sem compartilhar rascunho do principal",async t=>{
 const s=await fullSetup(t,async()=>{});
 await assert.rejects(()=>s.engine.setAI(USERS.admin,IDS.secondary,true,randomUUID()),e=>e.status===409);
});

test("worker pode rodar junto ao servidor e encerrar sem fechar o pool compartilhado",async()=>{
 const {startWorker}=require("../src/central/worker-main");
 let ticks=0,closed=false;
 const engine={async refreshConnection(){},async tick(){ticks++;return false;}};
 const worker=startWorker({pool:{end:async()=>{closed=true;}},config:{fullAgent:false,instances:[]},engine});
 await new Promise(r=>setTimeout(r,30));worker.stop();await worker.done;
 assert.ok(ticks>0);assert.equal(closed,false);
});

test("lembrete original respeita atendimento humano e retomada aguarda nova mensagem",async t=>{
 const s=await fullSetup(t,async()=>{});
 const full=require("../src/central/full-agent");
 const stop=full.configure(s.engine);t.after(stop);
 const c=await ingest(s);
 await s.engine.command(USERS.alice,c.id,"claim",{},randomUUID());
 assert.equal(await full.backgroundPaused(c.phone),true);
 assert.equal(await full.backgroundReply(c.phone,"lembrete",{requestId:"paused",etapa:"followup"}),false);
 await s.engine.command(USERS.alice,c.id,"resume-ai",{},randomUUID());
 assert.equal(await full.backgroundReply(c.phone,"lembrete",{requestId:"resumed",etapa:"followup"}),false);
 await s.engine.ingest(IDS.primary,{event:"MESSAGES_UPSERT",data:payload("next-full","Pode continuar").data});
 assert.equal(await full.backgroundReply(c.phone,"resposta",{requestId:"next",etapa:"taxa"}),true);
 assert.equal(await full.backgroundReply(c.phone,"resposta",{requestId:"next",etapa:"taxa"}),false);
});

async function backdate(s, conversationId, minutes) {
  await s.pool.query("update cw_handoffs set created_at=created_at-make_interval(mins=>$2) where conversation_id=$1", [conversationId, minutes]);
  await s.pool.query("update cw_messages set created_at=created_at-make_interval(mins=>$2) where conversation_id=$1", [conversationId, minutes]);
}
const aiJobs = async (s) => (await s.pool.query("select id from cw_private.jobs where type='ai'")).rows.length;
test("resposta da equipe pelo celular pausa a IA só por 10 minutos, como no agente original", async (t) => {
  const s = await fullSetup(t, async () => {});
  const c = await ingest(s);
  const before = await aiJobs(s);
  await ingest(s, IDS.primary, payload("celular1", "Já te respondo", true).data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "waiting_human");
  await ingest(s, IDS.primary, payload("cliente2", "Ok").data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "waiting_human");
  assert.equal(await aiJobs(s), before);
  await backdate(s, c.id, 11);
  await ingest(s, IDS.primary, payload("cliente3", "Ainda tá aí?").data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "ai");
  assert.equal(await aiJobs(s), before + 1);
  assert.equal((await s.pool.query("select status from cw_handoffs where conversation_id=$1", [c.id])).rows[0].status, "resolved");
});
test("equipe que continua falando mantém a pausa; quem clicou Assumir não perde o controle", async (t) => {
  const s = await fullSetup(t, async () => {});
  const c = await ingest(s);
  await ingest(s, IDS.primary, payload("celular1", "Já te respondo", true).data);
  await backdate(s, c.id, 11);
  await ingest(s, IDS.primary, payload("celular2", "Qual o endereço?", true).data);
  await ingest(s, IDS.primary, payload("cliente2", "Rua X, 10").data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "waiting_human");
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  await backdate(s, c.id, 30);
  await ingest(s, IDS.primary, payload("cliente3", "Oi?").data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "human");
});
test("aviso de status do painel não tira a conversa da IA", async (t) => {
  const s = await fullSetup(t, async () => {});
  const c = await ingest(s);
  await ingest(s, IDS.primary, payload("aviso1", "✅ Oi, Vandi! Seu pedido *#283* está pronto! Pode vir buscar quando quiser 😄", true).data);
  assert.equal((await s.engine.context(s.pool, c.id)).state, "ai");
  assert.equal((await s.pool.query("select id from cw_handoffs")).rows.length, 0);
});

// ── Revisão 20–26/10 ─────────────────────────────────────────────────────────
async function runAllAI(s) {
  await due(s);
  let job;
  while ((job = await s.engine.lease())) {
    if (job.type === "ai") await s.engine.runAI(job);
    await s.pool.query("update cw_private.jobs set status='done' where id=$1", [job.id]);
  }
}
test("mensagens picadas viram UMA rodada com o texto inteiro, como no agente original", async (t) => {
  const textos = [];
  const s = await fullSetup(t, async (msg) => { textos.push(msg.texto); });
  const c = await ingest(s, IDS.primary, payload("p1", "Média").data);
  await ingest(s, IDS.primary, payload("p2", "arroz, feijão, batata frita").data);
  await ingest(s, IDS.primary, payload("p3", "frango assado").data);
  await s.pool.query("update cw_messages set created_at=now()-make_interval(secs=>case provider_id when 'p1' then 6 when 'p2' then 4 else 2 end) where conversation_id=$1", [c.id]);
  await runAllAI(s);
  assert.deepEqual(textos, ["Média\narroz, feijão, batata frita\nfrango assado"]);
});
test("texto espera o cliente parar de digitar; mídia não espera", async (t) => {
  const s = await fullSetup(t, async () => {});
  assert.equal(s.engine.aiDelay("text"), 8000);
  assert.equal(s.engine.aiDelay("audio"), 1500);
});
test("áudio não é pulado quando o cliente manda texto logo depois", async (t) => {
  const tipos = [];
  const s = await fullSetup(t, async (msg) => { tipos.push(msg.key.id); });
  const audio = payload("a1").data; audio.message = { audioMessage: {} };
  const c = await ingest(s, IDS.primary, audio);
  await ingest(s, IDS.primary, payload("t1", "é isso").data);
  await s.pool.query("update cw_messages set created_at=now()-interval '5 seconds' where provider_id='a1' and conversation_id=$1", [c.id]);
  await runAllAI(s);
  assert.deepEqual(tipos.sort(), ["a1", "t1"]);
});
test("resposta pronta do agente sai mesmo se o cliente escreveu no meio (Pedido #294 sumia)", async (t) => {
  const s = await fullSetup(t, async (msg) => {
    await require("../src/central/legacy-context").current().respond(msg.telefone, "✅ Pedido *#294* confirmado!");
  });
  const c = await ingest(s);
  await due(s);
  await s.engine.runAI(await s.engine.lease());
  await s.pool.query("update cw_conversations set inbound_seq=inbound_seq+1 where id=$1", [c.id]);
  const send = await s.engine.lease();
  await s.engine.dispatch(send);
  assert.equal(s.sends.length, 1);
  assert.match(s.sends[0].text, /#294/);
});
test("tomada humana continua descartando a resposta pendente da IA", async (t) => {
  const s = await fullSetup(t, async (msg) => {
    await require("../src/central/legacy-context").current().respond(msg.telefone, "Anotei sua Média ✅");
  });
  const c = await ingest(s);
  await due(s);
  await s.engine.runAI(await s.engine.lease());
  await s.engine.command(USERS.alice, c.id, "claim", {}, randomUUID());
  const send = await s.engine.lease();
  if (send) await s.engine.dispatch(send);
  assert.equal(s.sends.length, 0);
});
