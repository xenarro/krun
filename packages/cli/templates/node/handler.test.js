import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the real SDK runs the handler locally and separates result from status", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS"));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("handler.js", import.meta.url))], {
    input: JSON.stringify({ name: "world" }), env, encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rows: 42 });
  assert.ok(result.stderr.includes("loading"));
});
