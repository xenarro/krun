import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const directory = new URL("../../../test/sdk-conformance/", import.meta.url);
const table: { name: string }[] = JSON.parse(
  readFileSync(new URL("scenarios.json", directory), "utf8"),
);
const runner = fileURLToPath(new URL("runner.ts", directory));
function exercise(name: string, mutation = "none") {
  const result = spawnSync(process.execPath, [runner, "node", name, "", mutation], {
    encoding: "utf8",
    timeout: 55_000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
      ),
    ),
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout.trim(), error: result.stderr };
}
for (const scenario of table)
  it(`shared wire table: ${scenario.name}`, () => {
    const result = exercise(scenario.name);
    expect(result.code, result.output || result.error).toBe(0);
    expect(JSON.parse(result.output).ok).toBe(true);
  }, 60_000);
it("shared oracle rejects real Node status calls in reverse body order", () => {
  const result = exercise("two-immediate-statuses", "swap-statuses");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({
    ok: false,
    failure: "body mismatch at request 1",
  });
}, 60_000);
for (const name of ["success", "two-immediate-statuses", "thrown-error"]) {
  it(`rejects invalid internal write media: ${name}`, () => {
    const result = exercise(name, "media-writes");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      failure: "content type mismatch at 1",
    });
  }, 60_000);
  it(`accepts normalized JSON media with parameters: ${name}`, () => {
    const result = exercise(name, "media-parameters");
    expect(result.code, result.output || result.error).toBe(0);
  }, 60_000);
}
it("rejects a present unsupported GET media type", () => {
  const result = exercise("success", "media-get");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({
    ok: false,
    failure: "content type mismatch at 0",
  });
}, 60_000);
it("rejects a present empty GET media type rather than treating it as absent", () => {
  const result = exercise("success", "media-empty-get");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({
    ok: false,
    failure: "content type mismatch at 0",
  });
}, 60_000);
it("allows absent GET media but rejects missing JSON media on a write", () => {
  const result = exercise("success", "media-omit");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({
    ok: false,
    failure: "content type mismatch at 1",
  });
}, 60_000);
it("shared matcher rejects malformed, missing, extra and reordered observations", () => {
  const result = exercise("--self-test");
  expect(result.code, result.output || result.error).toBe(0);
  expect(JSON.parse(result.output).ok).toBe(true);
});
