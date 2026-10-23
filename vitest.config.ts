import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      {
        test: {
          name: "tooling",
          root: fileURLToPath(new URL(".", import.meta.url)),
          environment: "node",
          include: ["test/scaffold/**/*.test.ts"],
        },
      },
    ],
  },
});
