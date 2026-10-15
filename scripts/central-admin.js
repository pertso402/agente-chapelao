"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
const { createDatabase, transaction } = require("../src/central/database");
const { IDS } = require("../src/central/config");
(async () => {
  const [email, role, name] = process.argv.slice(2);
  if (
    !email ||
    !["admin", "attendant"].includes(role) ||
    !name ||
    name.length > 120
  )
    throw new Error(
      'Uso: node scripts/central-admin.js email admin|attendant "Nome da pessoa"',
    );
  const pool = createDatabase(),
    q = await pool.connect();
  try {
    await transaction(q, async () => {
      const users = await q.query(
        "select id from auth.users where lower(email)=lower($1)",
        [email],
      );
      if (users.rows.length !== 1)
        throw new Error("Convide/crie a conta no Supabase Auth primeiro.");
      await q.query(
        "insert into cw_members(restaurant_id,user_id,display_name,role) values($1,$2,$3,$4) on conflict(restaurant_id,user_id) do update set display_name=excluded.display_name,role=excluded.role,active=true",
        [IDS.restaurant, users.rows[0].id, name, role],
      );
      await q.query(
        "insert into cw_activity_log(restaurant_id,actor_id,action,details) values($1,$2,$3,$4)",
        [IDS.restaurant, users.rows[0].id, "member_bootstrap", { role }],
      );
    });
    console.log("Vínculo da equipe configurado.");
  } finally {
    q.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
