"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
const fs = require("node:fs/promises");
const path = require("node:path");
const { createDatabase } = require("../src/central/database");
(async () => {
  const action = process.argv[2];
  if (!["inspect", "apply"].includes(action))
    throw new Error("Use: node scripts/central-db.js inspect|apply");
  const pool = createDatabase();
  try {
    const tables = (
      await pool.query(
        "select table_schema,table_name from information_schema.tables where table_schema in ('public','cw_private') order by table_schema,table_name",
      )
    ).rows;
    if (action === "inspect") {
      console.log(JSON.stringify(tables, null, 2));
      return;
    }
    if (
      tables.some(
        (t) =>
          t.table_name.startsWith("cw_") || t.table_schema === "cw_private",
      )
    )
      throw new Error(
        "Objetos da central já existem. Inspecione a migração antes de reaplicar.",
      );
    const sql = await fs.readFile(
      path.join(
        __dirname,
        "../supabase/migrations/20261015064518_central_whatsapp.sql",
      ),
      "utf8",
    );
    await pool.query(sql);
    const result = await pool.query(
      "select provider_name,ai_enabled from cw_instances order by provider_name",
    );
    console.log(JSON.stringify(result.rows, null, 2));
  } finally {
    await pool.end();
  }
})().catch(() => {
  console.error(
    "Falha na preparação do banco. Confira DATABASE_URL, permissões e inventário. Nenhuma credencial foi registrada.",
  );
  process.exitCode = 1;
});
