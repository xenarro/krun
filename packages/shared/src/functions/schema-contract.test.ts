import { expect, it } from "vitest";
import { z } from "zod";
import { durationToMilliseconds } from "../config/duration.ts";
import {
  type FunctionResource,
  type FunctionResourceInput,
  type FunctionSpec,
  type FunctionSpecInput,
  functionHeartbeatTimeoutSchema,
  functionInputSchemaProjection,
  functionQueueTimeoutSchema,
  functionResourceSchema,
  functionSpecSchema,
  functionStatusSchema,
} from "./schema.ts";

const image = `example.invalid/krun-test/function@sha256:${"0".repeat(64)}`;
const minimal = { image, inputSchema: { type: "object" } } satisfies FunctionSpecInput;

it("applies only SPEC defaults and distinguishes input from parsed output", () => {
  const parsed: FunctionSpec = functionSpecSchema.parse(minimal);
  expect(parsed).toEqual({
    ...minimal,
    serviceAccountName: "krun-job-default",
    runAsUser: 65532,
    runAsGroup: 65532,
    activeDeadlineSeconds: 3600,
    maxConcurrency: 10,
    maxQueued: 1000,
    queueTimeout: "1h",
  });
  expect(parsed).not.toHaveProperty("heartbeatTimeout");
  expect(parsed).not.toHaveProperty("callback");
  for (const value of [
    {},
    { image },
    { inputSchema: {} },
    { image, inputSchema: true },
    { image, inputSchema: [] },
  ])
    expect(functionSpecSchema.safeParse(value).success).toBe(false);
  const json = z.toJSONSchema(functionSpecSchema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: functionInputSchemaProjection,
  });
  expect(json.required).toEqual(["image", "inputSchema"]);
});

it("keeps inputSchema data opaque and spec/nested settings strict", () => {
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { Thing: { type: "string" } },
    properties: { item: { $ref: "#/$defs/Thing" } },
    anyOf: [{ required: ["item"] }, { additionalProperties: false }],
  };
  expect(functionSpecSchema.parse({ ...minimal, inputSchema }).inputSchema).toEqual(inputSchema);
  for (const extra of [
    { unknown: true },
    { env: [{ name: "TEST", valueFrom: { secretKeyRef: {} } }] },
    { callback: { url: "https://example.invalid/krun-test", headers: {} } },
    { resources: { requests: { gpu: "1" } } },
    { imagePullSecrets: ["secret"] },
  ])
    expect(functionSpecSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
  expect(
    functionSpecSchema.parse({
      ...minimal,
      resources: { requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "1Gi" } },
      imagePullSecrets: [{ name: "pull" }],
      env: [{ name: "TEST", value: "value" }],
      nodeSelector: { "example.invalid/pool": "test" },
      secretRefs: ["krun-test-ref"],
      callback: { url: "http://example.invalid/krun-test" },
    }),
  ).toMatchObject({ imagePullSecrets: [{ name: "pull" }] });
});

it("preserves opaque own JSON keys without mutating prototypes", () => {
  const inputSchema = JSON.parse(
    '{"type":"object","__proto__":{"sentinel":"krun-test-opaque"},"constructor":{"prototype":{"sentinel":"nested"}},"properties":{"__proto__":{"type":"string"}}}',
  );
  const before = JSON.stringify(inputSchema);
  const prototype = Object.getPrototypeOf(inputSchema);
  const parsed = functionSpecSchema.parse({ ...minimal, inputSchema }).inputSchema;
  expect(Object.getOwnPropertyNames(parsed)).toEqual(Object.getOwnPropertyNames(inputSchema));
  expect(JSON.stringify(parsed)).toBe(before);
  expect(JSON.stringify(inputSchema)).toBe(before);
  expect(Object.getPrototypeOf(parsed)).toBe(prototype);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(Object.hasOwn(Object.prototype, "sentinel")).toBe(false);
  const dictionary = Object.create(null);
  Object.defineProperty(dictionary, "__proto__", { value: { type: "string" }, enumerable: true });
  const parsedDictionary = functionSpecSchema.parse({
    ...minimal,
    inputSchema: dictionary,
  }).inputSchema;
  expect(Object.getPrototypeOf(parsedDictionary)).toBeNull();
  expect(Object.hasOwn(parsedDictionary, "__proto__")).toBe(true);
});

it("validates raw callback URI strings without normalization", () => {
  for (const url of [
    "https://example.invalid/path",
    "http://127.0.0.1:8080/a%20b?x=1#fragment",
    "HTTPS://EXAMPLE.invalid/%2f",
    "https://[::1]/path",
    "mailto:team@example.invalid",
    "urn:example:krun-test",
  ]) {
    const parsed = functionSpecSchema.parse({ ...minimal, callback: { url } });
    expect(parsed.callback?.url).toBe(url);
  }
  for (const url of [
    " https://example.invalid/path",
    "https://example.invalid/path ",
    "https://example.invalid/path\n",
    "https://exa\nmple.invalid/",
    "https://example.invalid/a b",
    "https://example.invalid/%ZZ",
    "https://example.invalid/%",
    "https://example.invalid/\\path",
    "https://",
    "https://?query",
    "https://[]/",
    "//example.invalid/path",
  ])
    expect(functionSpecSchema.safeParse({ ...minimal, callback: { url } }).success, url).toBe(
      false,
    );
});

it("fails closed for custom schemas other than the exact opaque boundary", () => {
  expect(() =>
    z.toJSONSchema(
      z.custom(() => true),
      {
        target: "draft-2020-12",
        unrepresentable: functionInputSchemaProjection,
      },
    ),
  ).toThrow("Custom types cannot be represented");
  const json = z.toJSONSchema(functionSpecSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: functionInputSchemaProjection,
  });
  expect(json.properties?.inputSchema).toEqual({ type: "object", additionalProperties: {} });
});

it("enforces agreed numeric floors, not installation-specific ceilings", () => {
  for (const bad of [
    { activeDeadlineSeconds: 0 },
    { activeDeadlineSeconds: 1.5 },
    { maxConcurrency: 0 },
    { maxQueued: -1 },
    { runAsUser: 0 },
    { runAsGroup: 0 },
  ])
    expect(functionSpecSchema.safeParse({ ...minimal, ...bad }).success).toBe(false);
  expect(
    functionSpecSchema.parse({
      ...minimal,
      activeDeadlineSeconds: 1,
      maxConcurrency: 1,
      maxQueued: 0,
    }),
  ).toMatchObject({ activeDeadlineSeconds: 1, maxQueued: 0 });
  expect(
    functionSpecSchema.safeParse({ ...minimal, activeDeadlineSeconds: 1000000, maxQueued: 1000000 })
      .success,
  ).toBe(true);
});

it("permits standard Kubernetes metadata without requiring server-managed fields", () => {
  const metadata = {
    name: "1-krun-test",
    namespace: "krun-test",
    uid: "server-value",
    resourceVersion: "42",
    labels: { team: "test" },
    annotations: { example: "preserved" },
    ownerReferences: [],
  };
  const resource = {
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata,
    spec: minimal,
  } satisfies FunctionResourceInput;
  const parsed: FunctionResource = functionResourceSchema.parse(resource);
  expect(parsed.spec.runAsUser).toBe(65532);
  expect(parsed.metadata).toEqual(metadata);
  expect(functionResourceSchema.parse(resource)).not.toHaveProperty("status");
  for (const name of ["", "A", "a.b", "-bad", "bad-", "a".repeat(64), "bad\n"])
    expect(functionResourceSchema.safeParse({ ...resource, metadata: { name } }).success).toBe(
      false,
    );
  for (const patch of [
    { apiVersion: "v1" },
    { kind: "Pod" },
    { metadata: {} },
    { spec: undefined },
  ])
    expect(functionResourceSchema.safeParse({ ...resource, ...patch }).success).toBe(false);
});

it("does not invent readiness and rejects duplicate Ready conditions", () => {
  expect(functionStatusSchema.parse({})).toEqual({});
  const condition = { type: "Ready", status: "Unknown", reason: "SchemaInvalid" };
  expect(functionStatusSchema.parse({ observedGeneration: 0, conditions: [condition] })).toEqual({
    observedGeneration: 0,
    conditions: [{ ...condition, message: "" }],
  });
  for (const value of [
    { observedGeneration: -1 },
    { conditions: [condition, condition] },
    { conditions: [{ type: "Ready", status: "True" }] },
    { conditions: [{ ...condition, type: "Other" }] },
    { conditions: [{ ...condition, status: true }] },
  ])
    expect(functionStatusSchema.safeParse(value).success).toBe(false);
});

it("shares exact duration floors, leading-zero and overflow behavior with editor schemas", () => {
  for (const [schema, minimum] of [
    [functionQueueTimeoutSchema, 1],
    [functionHeartbeatTimeoutSchema, 30000],
  ] as const) {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
    expect(json.pattern).toBe("^\\d+(ms|s|m|h)$");
    expect(json.allOf).toHaveLength(1);
    const cases = [
      "0ms",
      "00s",
      "000m",
      "000h",
      "1ms",
      "29999ms",
      "30000ms",
      "00030000ms",
      "29s",
      "00030s",
      "1m",
      "1h",
      "9007199254740991ms",
      "9007199254740992ms",
      "9007199254740s",
      "9007199254741s",
      "99999999999999999999999999999999h",
      "1.5m",
      "1d",
      " 30s",
      "30s\n",
    ];
    for (const [unit, scale] of [
      ["ms", 1],
      ["s", 1000],
      ["m", 60000],
      ["h", 3600000],
    ] as const) {
      for (let amount = 0; amount <= 600; amount++)
        cases.push(`${amount}${unit}`, `000${amount}${unit}`);
      const maximum = BigInt(Number.MAX_SAFE_INTEGER) / BigInt(scale);
      for (const amount of [maximum - 1n, maximum, maximum + 1n])
        cases.push(`${amount}${unit}`, `000${amount}${unit}`);
    }
    for (const value of cases) {
      const millis = durationToMilliseconds(value);
      const expected = millis !== undefined && millis >= minimum;
      expect(schema.safeParse(value).success, value).toBe(expected);
    }
  }
});
