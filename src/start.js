"use strict";
require("dotenv").config({ path: ".env.central", quiet: true });
require("dotenv").config({ quiet: true });
// O serviço existente mantém o comportamento até o corte explícito da central.
// Em modo central nenhum webhook, poller ou emissor legado é inicializado.
if (process.env.CENTRAL_ENABLED === "true") require("./central/server").start();
else require("./index").startLegacy();
