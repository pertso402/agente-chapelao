"use strict";
const { createClient } = require("@supabase/supabase-js");
const { assert } = require("./domain");
const BUCKET = "cw-media";
function createMediaStore(config, serviceKey = process.env.SUPA_SERVICE_KEY) {
  assert(serviceKey, 503, "Armazenamento privado não configurado.");
  const sb = createClient(config.supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = sb.storage.from(BUCKET);
  return {
    async retrieve(message, evolution) {
      const objectPath = [
        message.restaurant_id,
        message.instance_id,
        message.conversation_id,
        message.id,
      ].join("/");
      const cached = await bucket.download(objectPath);
      if (cached.data) {
        const bytes = Buffer.from(await cached.data.arrayBuffer());
        assert(bytes.length <= 8 * 1024 * 1024, 413, "Anexo grande demais.");
        return { bytes, mime: cached.data.type };
      }
      // Apenas ausência de objeto permite buscar no provedor; falha de bucket/auth não é cache miss.
      assert(
        !/bucket/i.test(cached.error?.message || "") &&
          (String(cached.error?.statusCode) === "404" ||
            (String(cached.error?.statusCode) === "400" &&
              /object.*not found|not_found/i.test(
                cached.error?.message || "",
              ))),
        503,
        "Não foi possível acessar o armazenamento privado.",
      );
      const media = await evolution.media(
        message.instance_id,
        message.media_key,
      );
      assert(
        typeof media.base64 === "string" &&
          media.base64.length < 12 * 1024 * 1024,
        413,
        "Anexo excede o limite de 8 MB.",
      );
      const bytes = Buffer.from(
        media.base64.replace(/^data:[^;]+;base64,/, ""),
        "base64",
      );
      assert(
        bytes.length <= 8 * 1024 * 1024,
        413,
        "Anexo excede o limite de 8 MB.",
      );
      const mime = String(
        media.mimetype || media.mediaType || "application/octet-stream",
      ).split(";")[0];
      assert(
        /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime),
        422,
        "Tipo do anexo inválido.",
      );
      const result = await bucket.upload(objectPath, bytes, {
        contentType: mime,
        upsert: false,
        cacheControl: "0",
      });
      assert(
        !result.error ||
          ["409", "Duplicate"].includes(String(result.error.statusCode)),
        503,
        "Não foi possível preservar o anexo.",
      );
      return { bytes, mime };
    },
  };
}
module.exports = { createMediaStore, BUCKET };
