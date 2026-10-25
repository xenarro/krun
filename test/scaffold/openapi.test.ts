import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { describe, expect, it } from "vitest";
import { renderPublicOpenApi } from "../../apps/gateway/dev/openapi.ts";
import { publicContracts, publicSchemas } from "../../apps/gateway/src/public-contracts.ts";

const api = readFileSync(fileURLToPath(new URL("../../docs/API.md", import.meta.url)), "utf8");
const methods = [...api.matchAll(/\| `([A-Za-z]+)` \| `(GET|POST) ([^`]+)` \| `([^`]+)`/g)].map(
  (match) => ({ id: match[1], method: match[2]?.toLowerCase(), path: match[3], scope: match[4] }),
);
type ObjectNode = Record<string, unknown>;
const object = (value: unknown): value is ObjectNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const visit = (value: unknown, fn: (node: ObjectNode) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn);
  } else if (object(value)) {
    fn(value);
    for (const item of Object.values(value)) visit(item, fn);
  }
};

describe("public OpenAPI contract generation", () => {
  it("uses real Swagger and every normative method/path/scope,not production placeholders", async () => {
    const document = await renderPublicOpenApi();
    expect(document.openapi).toBe("3.1.0");
    expect(methods).toHaveLength(9);
    for (const method of methods) {
      const operation = document.paths?.[method.path ?? ""]?.[method.method as "get" | "post"];
      expect(operation?.operationId).toBe(method.id);
      expect(operation?.["x-krun-scope" as keyof typeof operation]).toBe(method.scope);
      expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    }
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      [path?.get, path?.post].filter(Boolean),
    );
    expect(operations).toHaveLength(methods.length);
    expect(document.paths).not.toHaveProperty("/documentation");
    expect(Object.keys(publicContracts)).toHaveLength(methods.length);
  });
  it("renders byte-identical independent scopes without timestamps or IDs", async () => {
    const first = JSON.stringify(await renderPublicOpenApi());
    const second = JSON.stringify(await renderPublicOpenApi());
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });
  it("has no explicit nullable nodes or closed response enums", async () => {
    const document = await renderPublicOpenApi();
    visit(document, (node) => {
      expect(node.nullable).not.toBe(true);
      expect(node.type).not.toBe("null");
      if (Array.isArray(node.type)) expect(node.type).not.toContain("null");
    });
    for (const schema of Object.values(publicSchemas)) {
      expect(schema).toBeDefined();
    }
    const serialized = JSON.stringify(document);
    expect(serialized).toContain("QUEUED");
    expect(serialized).toContain("QUEUE_TIMEOUT");
    expect(serialized).toContain("FUNCTION");
    for (const path of Object.values(document.paths ?? {}))
      for (const op of [path?.get, path?.post]) {
        visit(op?.responses, (node) => expect(node).not.toHaveProperty("enum"));
      }
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {}))
      if (!name.endsWith("Input")) visit(schema, (node) => expect(node).not.toHaveProperty("enum"));
  });
  it("keeps CreateRun query/body shape and closed request views", async () => {
    const document = await renderPublicOpenApi();
    const create = document.paths?.["/v1/functions/{function}/runs"]?.post;
    expect(create?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "requestId",
          in: "query",
          schema: expect.objectContaining({ type: "string", maxLength: 128 }),
        }),
      ]),
    );
    expect(
      publicContracts.CreateRun.schema.body.safeParse({ input: {}, requestId: "wrong-body" })
        .success,
    ).toBe(false);
    expect(
      publicContracts.CreateRun.schema.body.safeParse({ input: { nested: null }, priority: 0 })
        .success,
    ).toBe(true);
    expect(publicContracts.CreateRun.schema.body.safeParse({ input: null }).success).toBe(false);
    expect(publicContracts.GetRun.schema.querystring.safeParse({ view: "BASIC" }).success).toBe(
      true,
    );
    expect(publicContracts.GetRun.schema.querystring.safeParse({ view: "NEW_VIEW" }).success).toBe(
      false,
    );
  });
  it("models full/basic views,opaque non-null result and optional fields", () => {
    const basic = {
      name: "functions/echo/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
      state: "FUTURE_STATE",
      attempt: 0,
      priority: 0,
      createdBy: "test",
      createTime: "2026-10-25T00:00:00.000Z",
    };
    expect(publicSchemas.RunSummary.safeParse(basic).success).toBe(true);
    expect(publicSchemas.Run.safeParse({ ...basic, input: {}, result: false }).success).toBe(true);
    expect(publicSchemas.Run.safeParse({ ...basic, input: {}, result: null }).success).toBe(false);
    expect(publicSchemas.RunSummary.safeParse({ ...basic, input: {} }).success).toBe(false);
    expect(publicSchemas.Run.safeParse({ ...basic, input: {}, callback: null }).success).toBe(
      false,
    );
  });
  it("declares JSON result/307,SSE and Retry-After/correlation response headers", async () => {
    const document = await renderPublicOpenApi();
    const result = document.paths?.["/v1/functions/{function}/runs/{run}:getResult"]?.get;
    expect(result?.responses?.["200"]).toHaveProperty("content.application/json");
    expect(result?.responses?.["307"]).toHaveProperty("headers.Location");
    expect(result?.responses?.["307"]).not.toHaveProperty("content");
    expect(
      document.paths?.["/v1/functions/{function}/runs/{run}:watch"]?.get?.responses?.["200"],
    ).toHaveProperty("content.text/event-stream");
    const create = document.paths?.["/v1/functions/{function}/runs"]?.post;
    expect(create?.responses?.["201"]).toHaveProperty("headers.Location");
    expect(create?.responses?.["201"]).toHaveProperty("headers.Idempotent-Replay");
    expect(create?.responses?.["429"]).toHaveProperty("headers.Retry-After");
    expect(create?.responses?.["201"]).toHaveProperty("headers.X-Request-Id");
  });
  it("preserves authored nested output metadata and all local component references", async () => {
    const document = await renderPublicOpenApi();
    const schemas = document.components?.schemas ?? {};
    const summary = schemas.RunSummary;
    expect(summary).toHaveProperty("properties.state.type", "string");
    expect(summary).toHaveProperty(
      "properties.state.description",
      expect.stringContaining("QUEUED"),
    );
    expect(summary).toHaveProperty(
      "properties.failureReason.description",
      expect.stringContaining("QUEUE_TIMEOUT"),
    );
    expect(summary).toHaveProperty("properties.state.readOnly", true);
    expect(schemas.RunError).toHaveProperty(
      "properties.source.description",
      expect.stringContaining("KUBERNETES"),
    );
    visit(document, (node) => {
      if (typeof node.$ref !== "string") return;
      expect(node.$ref.startsWith("#/components/schemas/")).toBe(true);
      expect(schemas).toHaveProperty(node.$ref.slice("#/components/schemas/".length));
    });
  });
  it("checked-in document matches independently rendered canonical JSON", async () => {
    const expected = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../docs/api/openapi-public.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(await renderPublicOpenApi()).toEqual(expected);
  });
  it("generated JSON Schema validates real FULL/BASIC values with strict AJV2020", async () => {
    const document = await renderPublicOpenApi();
    const defs = JSON.parse(
      JSON.stringify(document.components?.schemas).replaceAll("#/components/schemas/", "#/$defs/"),
    );
    const ajv = new Ajv2020({ strict: true, ownProperties: true, logger: false });
    formatsPlugin.default(ajv);
    ajv.addKeyword("x-field-behavior");
    const validate = ajv.compile({ $defs: defs, $ref: "#/$defs/Run" });
    const basic = {
      name: "functions/echo/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
      state: "FUTURE_STATE",
      attempt: 0,
      priority: 0,
      createdBy: "test",
      createTime: "2026-10-25T00:00:00.000Z",
    };
    expect(validate({ ...basic, input: { nested: null }, result: { nested: [null, false] } })).toBe(
      true,
    );
    expect(validate({ ...basic, input: {}, result: null })).toBe(false);
    expect(validate({ ...basic, input: null })).toBe(false);
    expect(validate({ ...basic, input: {}, callback: null })).toBe(false);
    expect(validate({ ...basic, input: {}, name: "functions/-/runs/not-a-uuid" })).toBe(false);
  });
});
