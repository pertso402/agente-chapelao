"use strict";
const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs/promises");
const path = require("node:path");
const { IDS } = require("../src/central/config");
const USERS = {
  admin: "92883f6b-80ce-4bde-aa42-7cb5eb541f15",
  alice: "9e1d5558-d145-474c-9fab-4cd13222ec63",
  bob: "408c2f66-37b2-4922-a9da-55dad3ab628d",
  outsider: "1db959de-5035-4652-991e-dbd5f77b3004",
};
async function testDatabase() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text);create table auth.sessions(id uuid primary key,user_id uuid);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant usage on schema public to authenticated,anon;",
  );
  const sql = await fs.readFile(
    path.join(
      __dirname,
      "../supabase/migrations/20261015064518_central_whatsapp.sql",
    ),
    "utf8",
  );
  await db.exec(sql);
  await db.exec(await fs.readFile(path.join(__dirname,"../supabase/migrations/20261015084000_full_agent.sql"),"utf8"));
  for (const [name, id] of Object.entries(USERS))
    await db.query("insert into auth.users values($1,$2)", [
      id,
      name + "@example.invalid",
    ]);
  for (const name of ["admin", "alice", "bob"])
    await db.query(
      "insert into cw_members(restaurant_id,user_id,display_name,role) values($1,$2,$3,$4)",
      [
        IDS.restaurant,
        USERS[name],
        name === "admin"
          ? "Denise · demonstração"
          : name === "alice"
            ? "Ana · demonstração"
            : "Bruna · demonstração",
        name === "admin" ? "admin" : "attendant",
      ],
    );
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      let release;
      const next = new Promise((r) => {
        release = r;
      });
      const prior = tail;
      tail = next;
      await prior;
      return {
        async query(sql, args) {
          // PGlite não implementa advisory locks de sessão. A fila deste adapter
          // serializa conexões só para teste funcional; não prova a barreira de rede.
          if (/pg_try_advisory_lock/.test(sql))
            return { rows: [{ locked: true }] };
          if (/pg_advisory_(unlock_all|xact_lock)/.test(sql))
            return { rows: [{}] };
          const r = await db.query(sql, args);
          return { ...r, rowCount: r.affectedRows };
        },
        release() {
          release();
        },
      };
    },
    async query(sql, args) {
      const q = await this.connect();
      try {
        return await q.query(sql, args);
      } finally {
        q.release();
      }
    },
    async end() {
      await tail;
      await db.close();
    },
  };
  return { pool, db, USERS };
}
module.exports = { testDatabase, USERS };
