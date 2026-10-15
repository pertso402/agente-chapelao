"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
const { randomUUID, randomBytes } = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { configuration } = require("../src/central/config");
const { createDatabase, transaction } = require("../src/central/database");
(async () => {
  const [name, role = "attendant"] = process.argv.slice(2);
  if (!name || name.length > 120 || !["admin", "attendant"].includes(role))
    throw new Error(
      'Use: node scripts/central-operator.js "Nome da pessoa" attendant|admin',
    );
  const config = configuration(),
    pool = createDatabase();
  let created = null,
    sb = null;
  try {
    const existing = await pool.query(
      "select user_id from cw_members where restaurant_id=$1 and lower(display_name)=lower($2)",
      [config.restaurantId, name],
    );
    if (existing.rows.length) throw new Error("Esse nome já está cadastrado.");
    if (!process.env.SUPA_SERVICE_KEY)
      throw new Error("Configure o segredo do Supabase no servidor.");
    sb = createClient(config.supabaseUrl, process.env.SUPA_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Identificador técnico aleatório. createUser não envia convite e ninguém
    // precisa conhecer e-mail/senha. Não é usado para autenticar o navegador.
    const result = await sb.auth.admin.createUser({
      email: "central-" + randomUUID() + "@internal.invalid",
      password: randomBytes(48).toString("base64url"),
      email_confirm: true,
      app_metadata: { central_internal_operator: true },
    });
    if (result.error || !result.data.user)
      throw new Error("Não foi possível criar o registro interno da equipe.");
    created = result.data.user.id;
    const q = await pool.connect();
    try {
      await transaction(q, async () => {
        await q.query(
          "insert into cw_members(restaurant_id,user_id,display_name,role) values($1,$2,$3,$4)",
          [config.restaurantId, created, name, role],
        );
        await q.query(
          "insert into cw_activity_log(restaurant_id,actor_id,action,details) values($1,$2,$3,$4)",
          [config.restaurantId, created, "internal_operator_created", { role }],
        );
      });
    } finally {
      q.release();
    }
    created = null;
    console.log(
      "Pessoa adicionada à equipe. Não é necessário e-mail ou senha.",
    );
  } catch (e) {
    if (created && sb) await sb.auth.admin.deleteUser(created).catch(() => {});
    throw e;
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
