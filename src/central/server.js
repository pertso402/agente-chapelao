"use strict";
const express = require("express");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { createDatabase, transaction, withLocks } = require("./database");
const { configuration } = require("./config");
const { createEvolution } = require("./evolution");
const { Engine } = require("./engine");
const { assert, uuid, secretEqual } = require("./domain");
function createApp({
  pool,
  config = configuration(),
  evolution = createEvolution(config),
  authenticate,
  demo = false,
  mediaStore,
}) {
  const app = express(),
    engine = new Engine({ pool, config, evolution });
  const supabase = authenticate
    ? null
    : createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self' " +
        config.supabaseUrl +
        " " +
        config.supabaseUrl.replace("https:", "wss:") +
        "; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    });
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.publishableKey,
      restaurantId: config.restaurantId,
      demo,
    }),
  );
  const asyncRoute = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  // Webhooks são autenticados antes de ler/gravar o corpo.
  app.post(
    "/api/webhooks/evolution/:instanceId",
    (req, res, next) => {
      const i = config.instances.find((i) => i.id === req.params.instanceId);
      if (!i || !secretEqual(req.get("X-Webhook-Secret"), i.webhookSecret))
        return res.status(401).json({ error: "Webhook não autorizado." });
      next();
    },
    express.json({ limit: "1mb", strict: true }),
    asyncRoute(async (req, res) => {
      try {
        res.json(await engine.receive(req.params.instanceId, req.body));
      } catch (e) {
        if (e.status) throw e;
        res
          .status(503)
          .json({ error: "Recebimento indisponível. Tente novamente." });
      }
    }),
  );
  app.post("/webhook", (_req, res) =>
    res.status(410).json({ error: "Use o endpoint autenticado da instância." }),
  );
  app.use("/api", (req, res, next) => {
    (async () => {
      const token = req.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
      assert(token, 401, "Entre na central.");
      let user;
      if (authenticate) user = await authenticate(token);
      else {
        const { data, error } = await supabase.auth.getUser(token);
        assert(
          !error && data.user && !data.user.is_anonymous,
          401,
          "Sessão inválida. Entre novamente.",
        );
        user = data.user;
      }
      assert(user?.id, 401, "Sessão inválida.");
      req.user = user;
      req.member = await engine.member(pool, user.id);
      if (req.method !== "GET" && req.method !== "HEAD")
        assert(
          req.get("Origin") === config.origin,
          403,
          "Origem não autorizada.",
        );
    })().then(() => next(), next);
  });
  app.use("/api", express.json({ limit: "16kb", strict: true }));
  app.get(
    "/api/me",
    asyncRoute(async (req, res) =>
      res.json({
        id: req.user.id,
        name: req.member.display_name,
        role: req.member.role,
      }),
    ),
  );
  app.get(
    "/api/team",
    asyncRoute(async (_req, res) =>
      res.json(
        (
          await pool.query(
            "select user_id,display_name,role from cw_members where restaurant_id=$1 and active order by display_name",
            [config.restaurantId],
          )
        ).rows,
      ),
    ),
  );
  app.get(
    "/api/team/access",
    asyncRoute(async (req, res) => {
      assert(req.member.role === "admin", 403, "Apenas administrador.");
      res.json(
        (
          await pool.query(
            "select user_id,display_name,role,active from cw_members where restaurant_id=$1 order by display_name",
            [config.restaurantId],
          )
        ).rows,
      );
    }),
  );
  app.post(
    "/api/team/:userId/access",
    asyncRoute(async (req, res) => {
      assert(
        req.body && Object.keys(req.body).every((k) => k === "active"),
        400,
        "Campos inválidos.",
      );
      const r = await engine.setMemberActive(
        req.user.id,
        req.params.userId,
        req.body.active,
        req.get("Idempotency-Key"),
      );
      res.status(r.status).json(r.body);
    }),
  );
  app.get(
    "/api/instances",
    asyncRoute(async (_req, res) =>
      res.json(
        (
          await pool.query(
            "select id,label,ai_enabled,connection_state,checked_at from cw_instances where restaurant_id=$1 order by provider_name",
            [config.restaurantId],
          )
        ).rows,
      ),
    ),
  );
  app.get(
    "/api/conversations",
    asyncRoute(async (req, res) => {
      const states = {
        waiting_human: "waiting_human",
        human: "human",
        ai: "ai",
        closed: "closed",
      };
      const state = states[req.query.state] || "waiting_human";
      const args = [config.restaurantId, state];
      let extra = "";
      if (req.query.mine === "true") {
        args.push(req.user.id);
        extra += " and c.assignee_id=$" + args.length;
      }
      if (req.query.instance) {
        assert(uuid(req.query.instance), 400, "Instância inválida.");
        args.push(req.query.instance);
        extra += " and c.instance_id=$" + args.length;
      }
      if (req.query.search) {
        args.push("%" + String(req.query.search).slice(0, 100) + "%");
        extra +=
          " and (c.customer_name ilike $" +
          args.length +
          " or c.phone ilike $" +
          args.length +
          ")";
      }
      if (req.query.after) {
        assert(uuid(req.query.after), 400, "Cursor inválido.");
        args.push(req.query.after);
        const n = args.length;
        extra +=
          " and (coalesce(h.created_at,c.created_at),c.id) > (select coalesce(hh.created_at,cc.created_at),cc.id from cw_conversations cc left join cw_handoffs hh on hh.conversation_id=cc.id and hh.status in ('pending','claimed') where cc.id=$" +
          n +
          " and cc.restaurant_id=$1)";
      }
      const result = await pool.query(
        "select c.*,i.label,h.reason_code,h.reason_detail,h.summary,h.created_at as waiting_since from cw_conversations c join cw_instances i on i.id=c.instance_id left join cw_handoffs h on h.conversation_id=c.id and h.status in ('pending','claimed') where c.restaurant_id=$1 and c.state=$2" +
          extra +
          " order by coalesce(h.created_at,c.created_at),c.id limit 51",
        args,
      );
      res.json({
        items: result.rows.slice(0, 50),
        hasMore: result.rows.length > 50,
      });
    }),
  );
  app.get(
    "/api/queue-count",
    asyncRoute(async (_req, res) =>
      res.json(
        (
          await pool.query(
            "select count(*)::int as count from cw_handoffs where restaurant_id=$1 and status='pending'",
            [config.restaurantId],
          )
        ).rows[0],
      ),
    ),
  );
  app.get(
    "/api/conversations/:id",
    asyncRoute(async (req, res) => {
      assert(uuid(req.params.id), 400, "Conversa inválida.");
      res.json(await engine.context(pool, req.params.id));
    }),
  );
  app.get(
    "/api/conversations/:id/messages",
    asyncRoute(async (req, res) => {
      assert(uuid(req.params.id), 400, "Conversa inválida.");
      await engine.context(pool, req.params.id);
      const args = [req.params.id, config.restaurantId];
      let cursor = "";
      if (req.query.before) {
        assert(uuid(req.query.before), 400, "Cursor inválido.");
        args.push(req.query.before);
        cursor =
          " and (coalesce(provider_at,created_at),created_at,id)<(select coalesce(provider_at,created_at),created_at,id from cw_messages where id=$3 and conversation_id=$1 and restaurant_id=$2)";
      }
      const result = await pool.query(
        "select id,conversation_id,direction,author,author_id,kind,text,status,cycle,created_at,provider_at from cw_messages where conversation_id=$1 and restaurant_id=$2" +
          cursor +
          " order by coalesce(provider_at,created_at) desc,created_at desc,id desc limit 51",
        args,
      );
      res.json({
        items: result.rows.slice(0, 50).reverse(),
        hasMore: result.rows.length > 50,
      });
    }),
  );
  app.post(
    "/api/conversations/:id/:action",
    asyncRoute(async (req, res) => {
      assert(uuid(req.params.id), 400, "Conversa inválida.");
      const action = req.params.action;
      const fields =
        action === "messages"
          ? ["text"]
          : action === "transfer"
            ? ["userId"]
            : action === "resolve-message"
              ? ["messageId", "note"]
              : [];
      assert(
        req.body && Object.keys(req.body).every((k) => fields.includes(k)),
        400,
        "Campos não permitidos.",
      );
      if (action === "transfer")
        assert(uuid(req.body.userId), 400, "Usuário inválido.");
      if (action === "resolve-message")
        assert(uuid(req.body.messageId), 400, "Mensagem inválida.");
      const r = await engine.command(
        req.user.id,
        req.params.id,
        action,
        req.body,
        req.get("Idempotency-Key"),
      );
      res.status(r.status).json(r.body);
    }),
  );
  app.post(
    "/api/instances/:id/ai",
    asyncRoute(async (req, res) => {
      assert(
        uuid(req.params.id) &&
          req.body &&
          Object.keys(req.body).every((k) => k === "enabled"),
        400,
        "Requisição inválida.",
      );
      const r = await engine.setAI(
        req.user.id,
        req.params.id,
        req.body.enabled,
        req.get("Idempotency-Key"),
      );
      res.status(r.status).json(r.body);
    }),
  );
  app.get(
    "/api/messages/:id/media",
    asyncRoute(async (req, res) => {
      assert(uuid(req.params.id), 400, "Mensagem inválida.");
      const m = (
        await pool.query(
          "select * from cw_messages where id=$1 and restaurant_id=$2",
          [req.params.id, config.restaurantId],
        )
      ).rows[0];
      assert(m?.media_key, 404, "Mídia indisponível.");
      const store = mediaStore || require("./storage").createMediaStore(config);
      const { bytes: content, mime } = await store.retrieve(m, evolution);
      const inline =
        /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|wav|webm))$/.test(
          mime,
        );
      res
        .set({
          "Content-Type": inline ? mime : "application/octet-stream",
          "Content-Disposition":
            (inline ? "inline" : "attachment") + '; filename="anexo"',
          "Content-Length": String(content.length),
        })
        .send(content);
    }),
  );
  app.get(
    "/api/operations",
    asyncRoute(async (req, res) => {
      assert(req.member.role === "admin", 403, "Apenas administrador.");
      const jobs = await pool.query(
        "select type,status,count(*)::int as count,min(created_at) as oldest from cw_private.jobs where restaurant_id=$1 and status in ('pending','running','failed','quarantine') group by type,status",
        [config.restaurantId],
      );
      const messages = await pool.query(
        "select status,count(*)::int as count from cw_messages where restaurant_id=$1 and status in ('unknown','failed') group by status",
        [config.restaurantId],
      );
      res.json({ jobs: jobs.rows, messages: messages.rows });
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Rota não encontrada." }),
  );
  app.use(
    express.static(path.resolve(__dirname, "../../central/public"), {
      index: "index.html",
      maxAge: 0,
    }),
  );
  app.get("*", (_req, res) =>
    res.sendFile(path.resolve(__dirname, "../../central/public/index.html")),
  );
  app.use((error, _req, res, _next) => {
    const status =
      error.status || (error.type === "entity.too.large" ? 413 : 500);
    res
      .status(status)
      .json({
        error:
          status < 500
            ? error.type === "entity.parse.failed"
              ? "JSON inválido."
              : error.message
            : "Serviço indisponível. Tente novamente.",
      });
  });
  return { app, engine };
}
function start() {
  const pool = createDatabase();
  const { app } = createApp({ pool });
  const server = app.listen(process.env.PORT || 3000, () =>
    console.log('{"event":"central.started"}'),
  );
  process.on("SIGTERM", () => server.close(() => pool.end()));
}
module.exports = { createApp, start };
