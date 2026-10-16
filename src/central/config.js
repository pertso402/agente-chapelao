"use strict";

const IDS = Object.freeze({
  restaurant: "ad48a105-9dad-4e67-8058-963082734575",
  primary: "435ce918-8d86-4d77-b14e-8cccf751bb88",
  secondary: "adcfdc9d-3bd9-46ad-b096-76fd032a919c",
});
const instances = [
  {
    id: IDS.primary,
    name: "Chapela - atendimento",
    label: "WhatsApp principal",
    keyEnv: "EVOLUTION_PRIMARY_KEY",
    secretEnv: "WEBHOOK_PRIMARY_SECRET",
  },
  {
    id: IDS.secondary,
    name: "chapelao",
    label: "WhatsApp secundário",
    keyEnv: "EVOLUTION_SECONDARY_KEY",
    secretEnv: "WEBHOOK_SECONDARY_SECRET",
  },
];
function configuration(env = process.env) {
  return {
    restaurantId: IDS.restaurant,
    authMode:
      ["internal_network", "trusted_device", "open"].includes(env.CENTRAL_AUTH_MODE)
        ? env.CENTRAL_AUTH_MODE
        : "password",
    openAccessUserId: env.CENTRAL_OPEN_USER_ID || "",
    fullAgent: env.CENTRAL_FULL_AGENT === "true",
    // Mesma pausa do agente original: a equipe respondeu pelo celular ou o
    // agente chamou alguém, e depois disso a IA volta sozinha. Sem prazo, o
    // cliente ficava sem resposta até alguém lembrar de abrir a central.
    pauseMinutes: Number(env.PAUSA_ATENDENTE_MIN || 10),
    internalAllowedCidrs: (env.CENTRAL_ALLOWED_CIDRS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    trustedProxyCidrs: (env.CENTRAL_TRUST_PROXY_CIDRS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    deviceEnrollmentHash: env.CENTRAL_ENROLLMENT_HASH || "",
    deviceEnrollmentUntil: Number(env.CENTRAL_ENROLLMENT_UNTIL || 0),
    internalSessionSecret: env.CENTRAL_SESSION_SECRET || "",
    origin: env.APP_ORIGIN || "http://localhost:3000",
    supabaseUrl: env.SUPA_URL || "https://qlswjefuinhbtlhauhgj.supabase.co",
    publishableKey: env.SUPA_KEY || "",
    evolutionUrl:
      env.EVOLUTION_URL ||
      "https://assistente-evolution-api.b1h6rm.easypanel.host",
    instances: instances.map((i) => ({
      ...i,
      key: env[i.keyEnv],
      webhookSecret: env[i.secretEnv],
    })),
  };
}
module.exports = { IDS, instances, configuration };
