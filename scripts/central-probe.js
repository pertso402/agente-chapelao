"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
const { configuration } = require("../src/central/config");
const { createEvolution } = require("../src/central/evolution");
(async () => {
  const config = configuration(),
    api = createEvolution(config),
    report = { evolutionVersion: "2.3.7", instances: [], supabase: {} };
  for (const i of config.instances) {
    const item = { name: i.name, id: i.id };
    for (const [field, fn] of [
      ["connection", () => api.state(i.id)],
      ["webhook", () => api.webhook(i.id)],
    ]) {
      try {
        const data = await fn();
        item[field] =
          field === "connection"
            ? { state: data.instance?.state || data.state || "unknown" }
            : {
                enabled: !!(data.enabled ?? data.webhook?.enabled),
                configured: !!(data.url || data.webhook?.url),
                events: data.events || data.webhook?.events || [],
                byEvents: data.webhookByEvents ?? data.byEvents,
                headersSupportedInResponse: !!data.headers,
              };
      } catch (e) {
        item[field] = { error: e.httpStatus ? "HTTP " + e.httpStatus : e.name };
      }
    }
    report.instances.push(item);
  }
  try {
    const r = await fetch(config.supabaseUrl + "/rest/v1/", {
      headers: { apikey: config.publishableKey },
      signal: AbortSignal.timeout(15000),
    });
    report.supabase.httpStatus = r.status;
    if (r.ok) {
      const d = await r.json();
      report.supabase.visibleTables = Object.keys(d.definitions || {});
    }
  } catch (e) {
    report.supabase.error = e.name;
  }
  console.log(JSON.stringify(report, null, 2));
})().catch(() => {
  console.error("Falha de diagnóstico.");
  process.exitCode = 1;
});
