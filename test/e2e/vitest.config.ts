import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    name: "e2e",
    reporters: ["verbose"],
    include: ["test/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    retry: 1,
    passWithNoTests: false,
  },
});
