"use strict";
const { Pool } = require("pg");
const { HttpError } = require("./domain");
function createDatabase(url = process.env.DATABASE_URL) {
  if (!url)
    throw new Error(
      "Configure DATABASE_URL com conexão direta ou pool de sessão.",
    );
  if (new URL(url).port === "6543")
    throw new Error(
      "Locks de sessão não podem usar o pool transacional (6543).",
    );
  const pool = new Pool({
    connectionString: url,
    max: 6,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    ...(process.env.DATABASE_CA_CERT
      ? { ssl: { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true } }
      : {}),
  });
  pool.on("error", () =>
    console.error(JSON.stringify({ event: "database.pool_error" })),
  );
  return pool;
}
async function transaction(client, fn) {
  await client.query("begin");
  try {
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
async function withLocks(pool, instanceId, jid, fn, exclusive = false) {
  const client = await pool.connect();
  let broken = false;
  const acquire = async (key, shared) => {
    const start = Date.now();
    while (true) {
      const result = await client.query(
        "select pg_try_advisory_lock" +
          (shared ? "_shared" : "") +
          "(hashtextextended($1,0)) as locked",
        [key],
      );
      if (result.rows[0].locked) return;
      if (Date.now() - start > 12000)
        throw new HttpError(
          409,
          "Finalizando envio em andamento. Aguarde e tente novamente.",
        );
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    for (const id of Array.isArray(instanceId)
      ? [...instanceId].sort()
      : [instanceId])
      await acquire("cw:instance:" + id, !exclusive);
    if (jid) await acquire("cw:conversation:" + instanceId + ":" + jid, false);
    return await fn(client);
  } finally {
    try {
      await client.query("select pg_advisory_unlock_all()");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}
module.exports = { createDatabase, transaction, withLocks };
