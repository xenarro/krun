import { defineConfig } from "vitest/config";

// The site has no Vitest suite of its own: test/scaffold/site.test.ts covers its
// scripts and workflow in the tooling project. Without this file the recursive
// `pnpm -r exec vitest run` in `make test` would fail here with "No test files".
export default defineConfig({
  test: { include: [], passWithNoTests: true },
});
