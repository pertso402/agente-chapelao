"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
const { createDatabase } = require("./database");
const { configuration } = require("./config");
const { createEvolution } = require("./evolution");
const { Engine } = require("./engine");
const { decide } = require("./agent");
const pool = createDatabase(),
  config = configuration(),
  engine = new Engine({
    pool,
    config,
    evolution: createEvolution(config),
    decide,
  });
let stopped = false,
  refreshing = false;
const refresh = async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const i of config.instances) await engine.refreshConnection(i.id);
  } catch {
    console.error('{"event":"worker.connection_refresh_failed"}');
  } finally {
    refreshing = false;
  }
};
const timer = setInterval(refresh, 30000);
const loop = async () => {
  while (!stopped) {
    try {
      if (!(await engine.tick())) await new Promise((r) => setTimeout(r, 400));
    } catch {
      console.error('{"event":"worker.tick_failed"}');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};
async function stop() {
  stopped = true;
  clearInterval(timer);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
(async () => {
  await refresh();
  await Promise.all([loop(), loop()]);
  await pool.end();
})().catch(() => {
  console.error('{"event":"worker.start_failed"}');
  process.exitCode = 1;
});
