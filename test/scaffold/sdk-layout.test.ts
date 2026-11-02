import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
it("places the unchanged dependency-free Node package beside the Python SDK", () => {
  expect(existsSync(`${root}packages/sdk-node`)).toBe(false);
  const manifest = JSON.parse(readFileSync(`${root}sdk/node/package.json`, "utf8"));
  expect(manifest.name).toBe("@krun/sdk");
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.engines.node).toBe(">=22");
  expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
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
