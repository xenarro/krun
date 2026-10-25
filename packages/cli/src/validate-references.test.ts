import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const dispatcher = fileURLToPath(new URL("../../../bin/krun.js", import.meta.url));
const cases: ReadonlyArray<{ id: string; schema: Record<string, unknown> }> = [
  {
    id: "property-ref",
    schema: { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"] },
  },
  {
    id: "property-dynamic",
    schema: {
      type: "object",
      properties: { $dynamicRef: { type: "string" } },
      required: ["$dynamicRef"],
    },
  },
  { id: "definition-ref", schema: { $defs: { $ref: { type: "string" } }, $ref: "#/$defs/$ref" } },
  {
    id: "default-data",
    schema: { type: "object", default: { $ref: "https://literal.example.invalid/data" } },
  },
  {
    id: "enum-data",
    schema: { type: "object", enum: [{ $dynamicRef: "https://literal.example.invalid/data" }] },
  },
];
const invoke = (schema: Record<string, unknown>) => {
  const directory = mkdtempSync(join(tmpdir(), "krun-test-p25-reference-cli-"));
  try {
    const path = join(directory, "function.yaml");
    writeFileSync(
      path,
      JSON.stringify({
        apiVersion: "krun.io/v1alpha1",
        kind: "Function",
        metadata: { name: "reference-case" },
        spec: { image: "example.invalid/job@sha256:abc", inputSchema: schema },
      }),
    );
    const env = { ...process.env };
    for (const key of [
      "KRUN_MAX_ACTIVE_DEADLINE",
      "KRUN_MAX_QUEUED",
      "KRUN_ALLOWED_REGISTRIES",
      "KRUN_ALLOWED_SERVICE_ACCOUNTS",
      "KRUN_WEBHOOK_ALLOWED_HOSTS",
    ])
      delete env[key];
    const result = spawnSync(process.execPath, [dispatcher, "validate", path], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
it.each(cases)("P25-C1: actual dispatcher accepts ordinary $id", ({ schema }) => {
  const result = invoke(schema);
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n").length).toBe(1);
  expect(result.stdout.startsWith("OK ")).toBe(true);
});
it.each([
  { $ref: "https://json-schema.org/draft/2020-12/schema" },
  { $defs: { unused: { $dynamicRef: "https://schema.example.invalid/remote" } } },
  {
    default: { $ref: "https://json-schema.org/draft/2020-12/meta/validation#/$defs/stringArray" },
    $ref: "#/default",
  },
])("P25-C1: actual dispatcher still rejects active remote references %#", (schema) => {
  const result = invoke(schema);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    "SchemaInvalid: spec.inputSchema must contain only local references",
  );
});
