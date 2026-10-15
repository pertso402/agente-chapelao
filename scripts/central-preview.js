"use strict";
// Preview isolado, sem ler .env, conectar serviços reais ou enviar mensagens.
const { testDatabase, USERS } = require("../tests/database");
const { configuration, IDS } = require("../src/central/config");
const { createApp } = require("../src/central/server");
(async () => {
  const { pool } = await testDatabase();
  const config = configuration({});
  config.origin = "http://localhost:3000";
  const evolution = {
    state: async () => ({ instance: { state: "open" } }),
    send: async () => ({ key: { id: "demo" } }),
    media: async () => {
      throw new Error("Anexo demonstrativo.");
    },
  };
  const { app, engine } = createApp({
    pool,
    config,
    evolution,
    authenticate: async (token) =>
      token === "demo" ? { id: USERS.admin } : null,
    demo: true,
  });
  await pool.query(
    "update cw_instances set connection_state='open',checked_at=now()",
  );
  const examples = [
    [
      "Maria Oliveira",
      "Quero alterar meu pedido. Pode tirar a cebola?",
      IDS.secondary,
      "order_change",
      "Cliente quer alterar um pedido já enviado. Alteração ainda não confirmada.",
    ],
    [
      "João Santos",
      "Gostaria de falar com uma pessoa da equipe.",
      IDS.primary,
      "customer_request",
      "Cliente pediu atendimento humano.",
    ],
    [
      "Camila Costa",
      "Enviei o comprovante, mas o pagamento não aparece.",
      IDS.primary,
      "payment_issue",
      "Cliente relata divergência de pagamento. Conferência pendente.",
    ],
  ];
  let n = 0;
  for (const [name, text, id, reason, summary] of examples) {
    const jid = "55440000000" + n + "@s.whatsapp.net";
    await engine.ingest(id, {
      event: "MESSAGES_UPSERT",
      data: {
        key: { id: "demo-" + n, fromMe: false, remoteJid: jid },
        message: { conversation: text },
        pushName: name,
        messageTimestamp: Math.floor(Date.now() / 1000) - (9 - n * 2) * 60,
      },
    });
    const c = (
      await pool.query(
        "select id from cw_conversations where instance_id=$1 and chat_jid=$2",
        [id, jid],
      )
    ).rows[0];
    await pool.query(
      "update cw_handoffs set reason_code=$2,reason_detail=$3,summary=$4,created_at=now()-($5*interval '1 minute') where conversation_id=$1",
      [c.id, reason, summary, summary, 9 - n * 2],
    );
    n++;
  }
  const server = app.listen(3000, "127.0.0.1", () =>
    console.log(
      "Demonstração local: http://localhost:3000 · dados fictícios · sem serviços reais",
    ),
  );
  process.on("SIGTERM", () => server.close(() => pool.end()));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
