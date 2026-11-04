import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
it("keeps the dependency-free Node SDK beside Python with typed ESM and CommonJS artifacts", () => {
  expect(existsSync(`${root}packages/sdk-node`)).toBe(false);
  const manifest = JSON.parse(readFileSync(`${root}sdk/node/package.json`, "utf8"));
  expect(manifest.name).toBe("@krun/sdk");
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.engines.node).toBe(">=22");
  expect(manifest.main).toBe("./dist/index.cjs");
  expect(manifest.types).toBe("./dist/index.d.cts");
  expect(manifest.exports["."]).toEqual({
    import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
    require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
  });
  for (const entry of [
    manifest.main,
    manifest.types,
    ...Object.values(manifest.exports["."]).flatMap((value) =>
      Object.values(value as Record<string, string>),
    ),
  ]) {
    expect(existsSync(`${root}sdk/node/${entry}`)).toBe(true);
  }
});
it("includes only sdk/node in pnpm and carries its build inputs into the image", () => {
  const workspace = readFileSync(`${root}pnpm-workspace.yaml`, "utf8");
  expect(workspace).toContain("- sdk/node");
  expect(workspace).not.toMatch(/- sdk\/\*|- sdk\/python/);
  for (const path of [
    "pnpm-lock.yaml",
    "Dockerfile",
    "knip.json",
    "vitest.config.ts",
    "test/scaffold/scaffold.test.ts",
  ]) {
    expect(readFileSync(`${root}${path}`, "utf8")).not.toContain("packages/sdk-node");
  }
  expect(readFileSync(`${root}Dockerfile`, "utf8")).toContain("COPY sdk/node/ ./sdk/node/");
  expect(readFileSync(`${root}.dockerignore`, "utf8")).toContain("!sdk/node/**");
});
