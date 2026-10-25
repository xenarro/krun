import { randomBytes } from "node:crypto";
import { Duration } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type FunctionSpec, functionSpecSchema } from "./schema.js";
import { type FunctionCeilings, type FunctionValidation, validateFunction } from "./validation.js";

const ceilings: FunctionCeilings = {
  maxActiveDeadline: 86400,
  maxQueued: 1000,
  allowedRegistries: [],
  allowedServiceAccounts: ["krun-job-default"],
  webhookAllowedHosts: [],
};
const spec = (patch: Partial<FunctionSpec> = {}): FunctionSpec => ({
  ...functionSpecSchema.parse({
    image: `ghcr.io/acme/worker@sha256:${"a".repeat(64)}`,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", format: "date" },
        to: { type: "string", format: "date" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  }),
  ...patch,
});
const invalidCases: {
  name: string;
  patch: Partial<FunctionSpec>;
  limits?: Partial<FunctionCeilings>;
  reason: string;
}[] = [
  { name: "queue duration grammar", patch: { queueTimeout: "1 hour" }, reason: "InvalidDuration" },
  { name: "queue floor", patch: { queueTimeout: "0ms" }, reason: "InvalidDuration" },
  {
    name: "queue safe-integer overflow",
    patch: { queueTimeout: "9007199254740992ms" },
    reason: "InvalidDuration",
  },
  {
    name: "heartbeat duration grammar",
    patch: { heartbeatTimeout: "soon" },
    reason: "InvalidDuration",
  },
  { name: "heartbeat floor", patch: { heartbeatTimeout: "5s" }, reason: "InvalidDuration" },
  {
    name: "heartbeat overflow",
    patch: { heartbeatTimeout: "9007199254740992ms" },
    reason: "InvalidDuration",
  },
  {
    name: "unpinned image remains a structural failure",
    patch: { image: "ghcr.io/acme/worker:latest" },
    reason: "SchemaInvalid",
  },
  {
    name: "image prefix",
    patch: { image: `docker.io/other/worker@sha256:${"a".repeat(64)}` },
    limits: { allowedRegistries: ["ghcr.io/acme/"] },
    reason: "RegistryNotAllowed",
  },
  {
    name: "service account",
    patch: { serviceAccountName: "default" },
    reason: "ServiceAccountNotAllowed",
  },
  {
    name: "reserved secret reference",
    patch: { secretRefs: ["application", "krun-keys"] },
    reason: "SecretRefNotAllowed",
  },
  {
    name: "deadline ceiling",
    patch: { activeDeadlineSeconds: 86401 },
    reason: "DeadlineAboveCeiling",
  },
  { name: "queue ceiling", patch: { maxQueued: 1001 }, reason: "QueuedAboveCeiling" },
  {
    name: "concurrency floor remains structural",
    patch: { maxConcurrency: 0 },
    reason: "SchemaInvalid",
  },
  {
    name: "callback disabled",
    patch: { callback: { url: "https://hooks.example.com/" } },
    reason: "CallbackNotAllowed",
  },
  {
    name: "callback forbidden host",
    patch: { callback: { url: "https://evil.example/" } },
    limits: { webhookAllowedHosts: ["*.example.com"] },
    reason: "CallbackNotAllowed",
  },
  {
    name: "callback has no host",
    patch: { callback: { url: "mailto:operator@example.com" } },
    limits: { webhookAllowedHosts: ["*"] },
    reason: "CallbackNotAllowed",
  },
  {
    name: "65 KiB schema",
    patch: { inputSchema: { type: "object", description: "x".repeat(65 * 1024) } },
    reason: "SchemaTooLarge",
  },
  {
    name: "schema does not compile",
    patch: { inputSchema: { type: "objekt" } },
    reason: "SchemaInvalid",
  },
  {
    name: "strict unknown keyword",
    patch: { inputSchema: { type: "object", unknownKeyword: true } },
    reason: "SchemaInvalid",
  },
  {
    name: "strict unknown format",
    patch: { inputSchema: { type: "string", format: "unknown-format" } },
    reason: "SchemaInvalid",
  },
  {
    name: "remote reference",
    patch: { inputSchema: { $ref: "https://schema.krun-test.invalid/input" } },
    reason: "SchemaInvalid",
  },
  {
    name: "relative external reference",
    patch: { inputSchema: { $ref: "input.json" } },
    reason: "SchemaInvalid",
  },
  {
    name: "remote dynamic reference",
    patch: { inputSchema: { $dynamicRef: "https://schema.krun-test.invalid/input" } },
    reason: "SchemaInvalid",
  },
  {
    name: "missing local reference",
    patch: { inputSchema: { $ref: "#/$defs/missing" } },
    reason: "SchemaInvalid",
  },
  {
    name: "async validator",
    patch: { inputSchema: { $async: true, type: "object" } },
    reason: "SchemaInvalid",
  },
];

const freeze = (value: unknown): void => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
};

describe("pure second-layer Function validation", () => {
  it.each(invalidCases)("rejects $name with $reason", ({ patch, limits, reason }) => {
    const result: FunctionValidation = validateFunction(spec(patch), { ...ceilings, ...limits });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    expect(typeof result.message).toBe("string");
    if (!result.ok && patch.queueTimeout === undefined)
      expect(Duration.toMillis(result.queueTimeout ?? Duration.zero)).toBe(3600000);
  });

  it("returns a real synchronous date-format validator and parsed durations", () => {
    const result = validateFunction(
      spec({ heartbeatTimeout: "00030s", queueTimeout: "0001h" }),
      ceilings,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected valid Function");
    expect(result.reason).toBe("Valid");
    expect(result.message).toBe("");
    expect(Duration.toMillis(result.queueTimeout)).toBe(3600000);
    expect(Duration.toMillis(result.heartbeatTimeout ?? Duration.zero)).toBe(30000);
    expect(result.validate({ from: "2026-01-01", to: "2026-01-02" })).toBe(true);
    expect(result.validate({})).toBe(false);
    expect(result.validate({ from: "2026-02-30", to: "2026-01-02" })).toBe(false);
    expect(result.validate({ from: "2026-01-01", to: "2026-01-02", extra: 1 })).toBe(false);
  });

  it("accepts exact ceilings and zero backlog, with no invented minimum queue ceiling", () => {
    expect(
      validateFunction(spec({ activeDeadlineSeconds: 86400, maxQueued: 1000 }), ceilings).ok,
    ).toBe(true);
    expect(validateFunction(spec({ maxQueued: 0 }), { ...ceilings, maxQueued: 0 }).ok).toBe(true);
    expect(
      validateFunction(spec({ activeDeadlineSeconds: 1 }), { ...ceilings, maxActiveDeadline: 0 })
        .reason,
    ).toBe("DeadlineAboveCeiling");
    expect(validateFunction(spec(), { ...ceilings, allowedServiceAccounts: [] }).reason).toBe(
      "ServiceAccountNotAllowed",
    );
  });

  it("uses literal registry prefixes and only the specified secretRefs restriction", () => {
    expect(
      validateFunction(
        spec({
          secretRefs: ["application", "other-secret"],
          imagePullSecrets: [{ name: "krun-pull" }],
        }),
        { ...ceilings, allowedRegistries: ["ghcr.io/acme/"] },
      ).ok,
    ).toBe(true);
    expect(
      validateFunction(spec({ image: `ghcr.io/acme-evil/worker@sha256:${"a".repeat(64)}` }), {
        ...ceilings,
        allowedRegistries: ["ghcr.io/acme/"],
      }).reason,
    ).toBe("RegistryNotAllowed");
  });

  it("reuses P2.1 glob case/dot semantics and checks only host, never DNS or addresses", () => {
    const limits = { ...ceilings, webhookAllowedHosts: ["*.EXAMPLE.com", "127.0.0.1"] };
    for (const url of [
      "https://API.example.com/raw?x=%41",
      "https://.hidden.example.com/",
      "http://127.0.0.1/",
      "ftp://hooks.example.com/path",
    ]) {
      expect(validateFunction(spec({ callback: { url } }), limits).ok).toBe(true);
    }
    expect(
      validateFunction(spec({ callback: { url: "https://example.com.evil/" } }), limits).reason,
    ).toBe("CallbackNotAllowed");
    expect(
      validateFunction(spec({ callback: { url: "https://api.example.com/" } }), {
        ...ceilings,
        webhookAllowedHosts: ["x".repeat(70000)],
      }).reason,
    ).toBe("CallbackNotAllowed");
  });

  it("enforces UTF-8 byte size at exactly 64 KiB rather than JavaScript string length", () => {
    const empty = { type: "object", description: "" };
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const atLimit = { ...empty, description: "x".repeat(65536 - overhead) };
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(65536);
    expect(validateFunction(spec({ inputSchema: atLimit }), ceilings).ok).toBe(true);
    expect(
      validateFunction(
        spec({ inputSchema: { ...atLimit, description: `${atLimit.description}x` } }),
        ceilings,
      ).reason,
    ).toBe("SchemaTooLarge");
    expect(
      validateFunction(
        spec({ inputSchema: { ...empty, description: "é".repeat(33000) } }),
        ceilings,
      ).reason,
    ).toBe("SchemaTooLarge");
  });

  it("accepts local recursive 2020-12 references and tuple/unevaluated constraints", () => {
    const result = validateFunction(
      spec({
        inputSchema: {
          type: "object",
          properties: { count: { $ref: "#/$defs/count" }, next: { $ref: "#" } },
          required: ["count"],
          additionalProperties: false,
          $defs: { count: { type: "integer", minimum: 0 } },
        },
      }),
      ceilings,
    );
    if (!result.ok) throw new Error("Expected local reference compilation");
    expect(result.validate({ count: 1, next: { count: 0 } })).toBe(true);
    expect(result.validate({ count: -1 })).toBe(false);
    const tuple = validateFunction(
      spec({
        inputSchema: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "integer" }],
          minItems: 2,
          maxItems: 2,
          items: false,
        },
      }),
      ceilings,
    );
    if (!tuple.ok) throw new Error("Expected 2020-12 tuple compilation");
    expect(tuple.validate(["x", 1])).toBe(true);
    expect(tuple.validate(["x", "1"])).toBe(false);
  });

  it("walks nested reference keywords before compilation without consulting the network", () => {
    for (const ref of [
      "https://schema.krun-test.invalid/x",
      "file:///owned/schema",
      "other.json",
      "//schema.krun-test.invalid/x",
      "",
    ]) {
      const schema = {
        type: "object",
        $defs: { nested: { anyOf: [{ type: "string" }, { $ref: ref }] } },
      };
      expect(validateFunction(spec({ inputSchema: schema }), ceilings).reason).toBe(
        "SchemaInvalid",
      );
    }
  }, 1000);

  it("is repeatable with frozen arguments and independently repeated schema IDs", () => {
    const input = spec({
      inputSchema: {
        $id: "https://schemas.krun-test.invalid/owned",
        type: "object",
        properties: { count: { type: "integer", default: 1 } },
      },
    });
    const limits = { ...ceilings };
    freeze(input);
    freeze(limits);
    const before = JSON.stringify(input);
    const first = validateFunction(input, limits);
    const second = validateFunction(input, limits);
    expect(first.ok && second.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    if (!first.ok || !second.ok) throw new Error("Expected repeated compilation");
    expect(first.reason).toBe(second.reason);
    expect(first.message).toBe(second.message);
    expect(first.queueTimeout).toEqual(second.queueTimeout);
    const value = {};
    expect(first.validate(value)).toBe(true);
    expect(value).toEqual({});
    expect(second.validate({ count: "1" })).toBe(false);
  });

  it("returns an owned input-schema snapshot and never mutates caller data", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const result = validateFunction(spec({ inputSchema: schema }), ceilings);
    if (!result.ok) throw new Error("Expected valid Function");
    schema.properties.count.type = "string";
    expect(result.validate({ count: 1 })).toBe(true);
    expect(result.validate({ count: "1" })).toBe(false);
  });

  it("requires own input properties rather than inherited constructor values", () => {
    const result = validateFunction(
      spec({
        inputSchema: {
          type: "object",
          properties: { constructor: { type: "string" } },
          required: ["constructor"],
        },
      }),
      ceilings,
    );
    if (!result.ok) throw new Error("Expected valid constructor property schema");
    expect(result.validate({})).toBe(false);
    expect(result.validate(Object.create({ constructor: "inherited" }))).toBe(false);
    expect(result.validate(JSON.parse('{"constructor":"own"}'))).toBe(true);
  });

  it("bounds errors without logging schema,env,callback or native exception details", () => {
    const marker = randomBytes(24).toString("hex");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      for (const input of [
        spec({ inputSchema: { [marker]: true } }),
        spec({ callback: { url: `https://forbidden.example/${marker}` } }),
        spec({ env: [{ name: "VALUE", value: marker }], inputSchema: { type: "invalid" } }),
      ]) {
        const result = validateFunction(input, ceilings);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result).includes(marker)).toBe(false);
      }
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("fails non-serializable schemas as bounded SchemaInvalid and retains a valid queue duration", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const schema of [cycle, { constant: 1n }]) {
      const result = validateFunction(spec({ inputSchema: schema }), ceilings);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("SchemaInvalid");
      expect(Duration.toMillis(result.queueTimeout ?? Duration.zero)).toBe(3600000);
    }
  });
});
