import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { name: "sdk-node", environment: "node", include: ["src/**/*.test.ts"] },
});
