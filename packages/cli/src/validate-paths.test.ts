import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dispatcher = join(root, "bin/krun.js");
const directories: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "krun-test-p2-5-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const resource = (name: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: "krun.io/v1alpha1",
  kind: "Function",
  metadata: { name },
  spec: { image: "example.invalid/job@sha256:abc", inputSchema: { type: "object" }, ...spec },
});
const save = (dir: string, name: string, value: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const execute = (paths: string[], env: Record<string, string> = {}) => {
  const base = { ...process.env };
  for (const key of [
    "KRUN_MAX_ACTIVE_DEADLINE",
    "KRUN_MAX_QUEUED",
    "KRUN_ALLOWED_REGISTRIES",
    "KRUN_ALLOWED_SERVICE_ACCOUNTS",
    "KRUN_WEBHOOK_ALLOWED_HOSTS",
  ])
    delete base[key];
  return spawnSync(process.execPath, [dispatcher, "validate", ...paths], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...base,
      KRUN_DB_MODE: "not-a-database-mode",
      KRUN_NAMESPACE: "invalid namespace",
      KUBECONFIG: "/krun-test-p2-5-not-accessed",
      ...env,
    },
  });
};
const lines = (value: string) => value.trim().split("\n").filter(Boolean);

it("prints two Function results for valid plus tag-image input and exits one", () => {
  const dir = scratch();
  const path = save(
    dir,
    "mixed.yaml",
    `${JSON.stringify(resource("valid"))}\n---\n${JSON.stringify(resource("tagged", { image: "example.invalid/job:latest" }))}\n`,
  );
  const result = execute([path]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(lines(result.stdout).length).toBe(2);
  expect(lines(result.stdout)[0]).toContain("OK ");
  expect(lines(result.stdout)[0]).toContain("valid");
  expect(lines(result.stdout)[1]).toContain("FAIL ");
  expect(lines(result.stdout)[1]).toContain("spec.image must contain @sha256:");
});

it("callback is rejected by default and accepted only with the explicit host ceiling", () => {
  const path = save(
    scratch(),
    "callback.yaml",
    resource("callback", { callback: { url: "https://hooks.example.invalid/result" } }),
  );
  const denied = execute([path]);
  expect(denied.status).toBe(1);
  expect(denied.stdout).toContain("CallbackNotAllowed");
  const allowed = execute([path], { KRUN_WEBHOOK_ALLOWED_HOSTS: "hooks.example.invalid" });
  expect(allowed.status).toBe(0);
  expect(lines(allowed.stdout).length).toBe(1);
  expect(allowed.stdout.startsWith("OK ")).toBe(true);
  expect(allowed.stderr).toContain("hooks.example.invalid");
});

it("prints exactly the five parsed ceiling values and ignores unrelated production settings", () => {
  const path = save(scratch(), "valid.yaml", resource("defaulted"));
  const result = execute([path]);
  expect(result.status).toBe(0);
  const json = result.stderr.trim().replace(/^krun validate ceilings: /, "");
  expect(JSON.parse(json)).toEqual({
    KRUN_MAX_QUEUED: 1000,
    KRUN_MAX_ACTIVE_DEADLINE: 86400,
    KRUN_ALLOWED_SERVICE_ACCOUNTS: ["krun-job-default"],
    KRUN_ALLOWED_REGISTRIES: [],
    KRUN_WEBHOOK_ALLOWED_HOSTS: [],
  });
  expect(result.stderr.includes("KUBECONFIG")).toBe(false);
  expect(result.stderr.includes("KRUN_DB_MODE")).toBe(false);
});

// Each external process is one acceptance case with the unchanged default
// timeout. Aggregating four cold starts made unrelated concurrent CI load
// exhaust one shared test deadline despite correct CLI results.
const ceilingCases: ReadonlyArray<{
  spec: Record<string, unknown>;
  env: Record<string, string>;
  reason: string;
}> = [
  {
    spec: { activeDeadlineSeconds: 2 },
    env: { KRUN_MAX_ACTIVE_DEADLINE: "1" },
    reason: "DeadlineAboveCeiling",
  },
  { spec: { maxQueued: 2 }, env: { KRUN_MAX_QUEUED: "1" }, reason: "QueuedAboveCeiling" },
  {
    spec: {},
    env: { KRUN_ALLOWED_SERVICE_ACCOUNTS: "other-account" },
    reason: "ServiceAccountNotAllowed",
  },
  { spec: {}, env: { KRUN_ALLOWED_REGISTRIES: "other.invalid/" }, reason: "RegistryNotAllowed" },
];
it.each(ceilingCases)(
  "applies shared defaults and installation ceilings: $reason",
  ({ spec, env, reason }) => {
    const path = save(scratch(), "ceiling.yaml", resource("limited", spec));
    const result = execute([path], env);
    expect(result.status).toBe(1);
    expect(result.stdout.includes(reason)).toBe(true);
  },
);

it("reports invalid ceiling by variable only without echoing values or reading any files", () => {
  const marker = randomBytes(32).toString("hex");
  const result = execute(["/krun-test-p2-5-not-read"], { KRUN_MAX_QUEUED: marker });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("KRUN_MAX_QUEUED");
  expect(result.stderr.includes(marker)).toBe(false);
  expect(result.stderr.includes("ENOENT")).toBe(false);
});

it("walks immediate YAML/YML directory files in sorted order, skips unrelated kinds and deduplicates paths", () => {
  const dir = scratch();
  const b = save(dir, "b.yml", resource("second"));
  save(dir, "a.yaml", resource("first"));
  save(dir, "ignored.yaml", {
    apiVersion: "v1",
    kind: "ConfigMap",
    data: { private: randomBytes(32).toString("hex") },
  });
  save(dir, "ignored.txt", resource("not-yaml"));
  mkdirSync(join(dir, "nested"));
  save(join(dir, "nested"), "bad.yaml", resource("not-recursed", { image: "tagged" }));
  const result = execute([dir, b]);
  expect(result.status).toBe(0);
  expect(lines(result.stdout).length).toBe(2);
  expect(lines(result.stdout)[0]).toContain("first");
  expect(lines(result.stdout)[1]).toContain("second");
});

it("directory symlinks cannot make discovery recursive; regular-file links work", () => {
  const dir = scratch();
  const nested = join(dir, "nested");
  mkdirSync(nested);
  const target = save(nested, "source.json", resource("linked-file"));
  symlinkSync(target, join(dir, "file.yaml"));
  symlinkSync(nested, join(dir, "directory.yaml"));
  const result = execute([dir]);
  expect(result.status).toBe(0);
  expect(lines(result.stdout).length).toBe(1);
  expect(result.stdout).toContain("linked-file");
});

it("missing files do not stop later Function validation and retain no native diagnostics", () => {
  const dir = scratch();
  const path = save(dir, "valid.yaml", resource("after-error"));
  const result = execute([join(dir, "missing.yaml"), path]);
  expect(result.status).toBe(1);
  expect(lines(result.stdout).length).toBe(1);
  expect(result.stdout).toContain("after-error");
  expect(result.stderr.includes("ENOENT")).toBe(false);
  expect(result.stderr).toContain("cannot read input path");
});

it("malformed YAML, warning tags, duplicate map fields and invalid UTF8 never echo private source", () => {
  const dir = scratch();
  const marker = randomBytes(32).toString("hex");
  const samples = [
    `kind: Function\nspec: [${marker}`,
    `!private ${marker}`,
    `kind: Function\nkind: Function\nprivate: ${marker}\n`,
  ];
  for (const sample of samples) {
    const result = execute([save(dir, "bad.yaml", sample)]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`.includes(marker)).toBe(false);
  }
  const path = join(dir, "binary.yaml");
  writeFileSync(path, Buffer.from([0xff]));
  const result = execute([path]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("invalid YAML");
});

it("reports schema errors without printing env values, callback URLs or unknown field names", () => {
  const marker = randomBytes(32).toString("hex");
  const dir = scratch();
  for (const spec of [
    { env: [{ name: "PRIVATE", value: marker }], [marker]: true },
    { callback: { url: `not a URL ${marker}` } },
    { inputSchema: { type: marker } },
  ]) {
    const result = execute([save(dir, "private.yaml", resource("safe-name", spec))]);
    expect(result.status).toBe(1);
    expect(lines(result.stdout).length).toBe(1);
    expect(`${result.stdout}${result.stderr}`.includes(marker)).toBe(false);
  }
});

it("uses the shared pure validator for remote refs, schema size, schema compilation and reserved Secret names", () => {
  const dir = scratch();
  const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    [{ inputSchema: { $ref: "https://never-resolve.example.invalid/schema" } }, "SchemaInvalid"],
    [{ inputSchema: { description: "x".repeat(65536) } }, "SchemaTooLarge"],
    [{ inputSchema: { type: "not-a-json-type" } }, "SchemaInvalid"],
    [{ secretRefs: ["krun-private"] }, "SecretRefNotAllowed"],
  ];
  for (const [spec, reason] of cases) {
    const result = execute([save(dir, "rule.yaml", resource("rule", spec))]);
    expect(result.status).toBe(1);
    expect(result.stdout.includes(reason)).toBe(true);
  }
});

it("placeholder image is clearly actionable and unsupported Function versions fail instead of vanishing", () => {
  const dir = scratch();
  const placeholder = execute([
    save(dir, "placeholder.yaml", resource("placeholder", { image: "REPLACE_WITH_DIGEST" })),
  ]);
  expect(placeholder.status).toBe(1);
  expect(placeholder.stdout).toContain("REPLACE_WITH_DIGEST");
  const version = execute([
    save(dir, "version.yaml", { ...resource("version"), apiVersion: "krun.io/v9" }),
  ]);
  expect(version.status).toBe(1);
  expect(lines(version.stdout).length).toBe(1);
  expect(version.stdout).toContain("CRDSchema");
});

it("empty input sets fail clearly rather than silently succeeding in CI", () => {
  const dir = scratch();
  const result = execute([dir]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("no Function documents found");
});

it("paths and invalid names cannot inject extra physical output lines", () => {
  const dir = scratch();
  const resourceWithBadName = { ...resource("valid"), metadata: { name: "bad\nname" } };
  const path = save(dir, "name\nwith\u2028lines.yaml", resourceWithBadName);
  const result = execute([path]);
  expect(result.status).toBe(1);
  expect(lines(result.stdout).length).toBe(1);
  expect(result.stdout.includes("\u2028")).toBe(false);
  expect(result.stdout.includes("bad\nname")).toBe(false);
});

it("no arguments or unsupported flags fail usage; help is independent of config and files", () => {
  for (const args of [[], ["--json"], ["--unknown=private-value"]]) {
    const result = execute(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: krun validate");
    expect(result.stderr.includes("private-value")).toBe(false);
  }
  const help = execute(["--help"], { KRUN_MAX_QUEUED: "invalid" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage: krun validate");
  expect(help.stderr).toBe("");
});

it("accepts a readable explicit file regardless of extension and preserves file contents", () => {
  const dir = scratch();
  const path = save(dir, "function.json", resource("json-input"));
  chmodSync(path, 0o444);
  const result = execute([path]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("json-input");
});
