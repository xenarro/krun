import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Test harness only. Every fixture/mount belongs to this invocation; no cluster/network.
const image = process.argv[2] ?? "krun:local";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "krun-test-validate-"));
const groups: Array<{ id: string; exitCode: number; lines: number }> = [];
const hardening = [
  "--rm",
  "--read-only",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
];
const resource = (name: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: "krun.io/v1alpha1",
  kind: "Function",
  metadata: { name },
  spec: { image: "example.invalid/job@sha256:abc", inputSchema: { type: "object" }, ...spec },
});
const run = (
  id: string,
  file: string,
  expected: number,
  rows: number,
  env: Record<string, string> = {},
) => {
  const result = spawnSync(
    "docker",
    [
      "run",
      ...hardening,
      "--volume",
      `${directory}:/f:ro`,
      "--env",
      "KRUN_DB_MODE=not-a-database-mode",
      "--env",
      "KRUN_NAMESPACE=not a namespace",
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      image,
      "validate",
      file,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.error, undefined, `${id}: docker invocation failed`);
  assert.equal(result.status, expected, `${id}: exit code`);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, rows, `${id}: stdout rows`);
  assert.ok(result.stderr.startsWith("krun validate ceilings: "), `${id}: ceiling display`);
  groups.push({ id, exitCode: expected, lines: rows });
  return { ...result, lines };
};
try {
  chmodSync(directory, 0o755); // Nonroot 65532 reads only these nonsecret test fixtures.
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o644 },
    );
  save("valid.yaml", resource("valid"));
  save("tag-image.yaml", resource("tagged", { image: "example.invalid/job:latest" }));
  save(
    "mixed.yaml",
    `${JSON.stringify(resource("first"))}\n---\n${JSON.stringify(resource("second", { image: "example.invalid/job:latest" }))}\n`,
  );
  save(
    "callback.yaml",
    resource("callback", { callback: { url: "https://hooks.example.invalid/result" } }),
  );
  assert.ok(run("valid", "/f/valid.yaml", 0, 1).lines[0]?.startsWith("OK "));
  assert.ok(
    run("tag-image", "/f/tag-image.yaml", 1, 1).stdout.includes("spec.image must contain @sha256:"),
  );
  const mixed = run("mixed", "/f/mixed.yaml", 1, 2);
  assert.ok(mixed.lines[0]?.startsWith("OK "));
  assert.ok(mixed.lines[1]?.startsWith("FAIL "));
  assert.ok(run("callback-denied", "/f/callback.yaml", 1, 1).stdout.includes("CallbackNotAllowed"));
  assert.ok(
    run("callback-allowed", "/f/callback.yaml", 0, 1, {
      KRUN_WEBHOOK_ALLOWED_HOSTS: "hooks.example.invalid",
    }).stdout.startsWith("OK "),
  );
  const referenceSchemas = [
    { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"] },
    { type: "object", properties: { $dynamicRef: { type: "string" } }, required: ["$dynamicRef"] },
    { $defs: { $ref: { type: "string" } }, $ref: "#/$defs/$ref" },
    { type: "object", default: { $ref: "https://literal.example.invalid/data" } },
    { type: "object", enum: [{ $dynamicRef: "https://literal.example.invalid/data" }] },
  ];
  save(
    "reference-context.yaml",
    referenceSchemas
      .map((inputSchema, index) => JSON.stringify(resource(`reference-${index}`, { inputSchema })))
      .join("\n---\n"),
  );
  assert.ok(
    run("reference-context", "/f/reference-context.yaml", 0, referenceSchemas.length).lines.every(
      (line) => line.startsWith("OK "),
    ),
  );
  save(
    "remote-reference.yaml",
    resource("remote-reference", {
      inputSchema: { $defs: { unused: { $ref: "https://json-schema.org/draft/2020-12/schema" } } },
    }),
  );
  assert.ok(
    run("remote-reference", "/f/remote-reference.yaml", 1, 1).stdout.includes(
      "SchemaInvalid: spec.inputSchema must contain only local references",
    ),
  );
  const modules = ["packages/cli/dist/validate.js", "packages/cli/dist/validate-functions.js"];
  const expected = Object.fromEntries(
    modules.map((module) => [
      module,
      createHash("sha256")
        .update(readFileSync(join(root, module)))
        .digest("hex"),
    ]),
  );
  const probe = `const fs=require('node:fs'),c=require('node:crypto'),a=require('node:assert/strict');a.equal(process.getuid(),65532);a.equal(process.getgid(),65532);const paths=${JSON.stringify(modules)};const hashes=Object.fromEntries(paths.map(p=>[p,c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]));require.resolve('@krun/shared/dist/functions/schema.js',{paths:['/app/packages/cli']});require.resolve('yaml',{paths:['/app/packages/cli']});console.log(JSON.stringify(hashes));`;
  const identity = spawnSync(
    "docker",
    ["run", ...hardening, "--entrypoint", "/nodejs/bin/node", image, "-e", probe],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(identity.error, undefined);
  assert.equal(identity.status, 0);
  assert.deepEqual(JSON.parse(identity.stdout), expected);
  console.log(JSON.stringify({ image, uid: 65532, gid: 65532, cliModuleHashes: expected, groups }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
