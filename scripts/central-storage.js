"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
const { createClient } = require("@supabase/supabase-js");
const { configuration } = require("../src/central/config");
const { BUCKET } = require("../src/central/storage");
(async () => {
  const c = configuration();
  if (!process.env.SUPA_SERVICE_KEY)
    throw new Error("SUPA_SERVICE_KEY ausente.");
  const sb = createClient(c.supabaseUrl, process.env.SUPA_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const existing = await sb.storage.getBucket(BUCKET);
  if (existing.data) {
    if (existing.data.public)
      throw new Error("Bucket existente é público: corrigir antes do uso.");
    console.log("Bucket privado já existe.");
    return;
  }
  const result = await sb.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error("Não foi possível criar o bucket privado.");
  console.log(
    "Bucket privado cw-media criado. Sem policies de acesso público.",
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
