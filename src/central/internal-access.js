"use strict";
const { createHmac } = require("node:crypto");
const proxyaddr = require("proxy-addr");
const { assert, uuid, secretEqual } = require("./domain");
const COOKIE = "cw_internal_operator";
const DAYS = 180;
function createInternalAccess(config, pool) {
  const allowed = config.internalAllowedCidrs || [];
  const proxies = config.trustedProxyCidrs || [];
  for (const value of [...allowed, ...proxies])
    assert(
      !["0.0.0.0/0", "::/0", "0/0"].includes(value),
      503,
      "A restrição de rede não permite liberar toda a internet.",
    );
  const matches = allowed.length ? proxyaddr.compile(allowed) : () => false;
  const signature = (value) =>
    createHmac("sha256", config.internalSessionSecret)
      .update(value)
      .digest("hex");
  const checkNetwork = (req) => {
    assert(
      config.internalSessionSecret?.length >= 32 && allowed.length,
      503,
      "A rede interna ainda precisa ser configurada pela empresa.",
    );
    assert(
      matches(req.ip),
      403,
      "A central está disponível somente na rede do restaurante.",
    );
  };
  const read = (req) => {
    const value = (req.get("Cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    if (!value) return null;
    const [payload, mac, ...extra] = value.split(".");
    if (
      extra.length ||
      !payload ||
      !mac ||
      !secretEqual(mac, signature(payload))
    )
      return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      return uuid(data.userId) &&
        Number.isFinite(data.expiresAt) &&
        data.expiresAt > Date.now()
        ? { id: data.userId }
        : null;
    } catch {
      return null;
    }
  };
  const options =
    "; Path=/; HttpOnly; SameSite=Strict" +
    (config.origin.startsWith("https://") ? "; Secure" : "");
  return {
    trustProxy: proxies.length ? proxyaddr.compile(proxies) : false,
    checkNetwork,
    read,
    async access(req) {
      checkNetwork(req);
      const members = (
        await pool.query(
          "select user_id,display_name from cw_members where restaurant_id=$1 and active order by display_name",
          [config.restaurantId],
        )
      ).rows;
      const selected = read(req);
      return {
        members,
        selected:
          selected && members.some((m) => m.user_id === selected.id)
            ? selected.id
            : null,
      };
    },
    async select(req, res) {
      checkNetwork(req);
      assert(
        req.get("Origin") === config.origin,
        403,
        "Origem não autorizada.",
      );
      assert(
        req.body &&
          Object.keys(req.body).every((k) => k === "userId") &&
          uuid(req.body.userId),
        400,
        "Selecione uma pessoa da equipe.",
      );
      const member = (
        await pool.query(
          "select user_id from cw_members where restaurant_id=$1 and user_id=$2 and active",
          [config.restaurantId, req.body.userId],
        )
      ).rows[0];
      assert(member, 403, "Pessoa não disponível na equipe.");
      const payload = Buffer.from(
        JSON.stringify({
          userId: member.user_id,
          expiresAt: Date.now() + DAYS * 86400000,
        }),
      ).toString("base64url");
      res.setHeader(
        "Set-Cookie",
        COOKIE +
          "=" +
          payload +
          "." +
          signature(payload) +
          options +
          "; Max-Age=" +
          DAYS * 86400,
      );
      await pool.query(
        "insert into cw_activity_log(restaurant_id,actor_id,action) values($1,$2,$3)",
        [config.restaurantId, member.user_id, "internal_operator_selected"],
      );
      return { selected: member.user_id };
    },
    logout(req, res) {
      checkNetwork(req);
      assert(
        req.get("Origin") === config.origin,
        403,
        "Origem não autorizada.",
      );
      res.setHeader("Set-Cookie", COOKIE + "=" + options + "; Max-Age=0");
      return { selected: null };
    },
  };
}
module.exports = { createInternalAccess };
