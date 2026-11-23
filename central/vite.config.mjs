import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  publicDir: false,
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "public", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
