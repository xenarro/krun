import { serializerCompiler } from "fastify-type-provider-zod";
import { expect, it } from "vitest";
import { z } from "zod";
import { publicContractProjection, publicContracts, publicSchemas } from "./public-contracts.js";

const own = () =>
  JSON.parse(
    '{"__proto__":{"sentinel":"krun-test-own"},"constructor":{"prototype":"opaque"},"prototype":false,"nested":{"__proto__":null}}',
  );
const basic = {
  name: "functions/echo/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  state: "FUTURE_STATE",
  attempt: 0,
  priority: 0,
  createdBy: "krun-test",
  createTime: "2026-10-25T00:00:00.000Z",
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const select = (value: unknown, field?: string) => {
  if (!record(value)) throw new Error("Expected JSON object fixture");
  const selected = field === undefined ? value : value[field];
  if (!record(selected)) throw new Error("Expected opaque JSON object fixture");
  return selected;
};
const cases: { id: string; schema: z.ZodType; value: () => unknown; field?: string }[] = [
  {
    id: "request input",
    schema: publicContracts.CreateRun.schema.body,
    value: () => ({ input: own(), priority: 0 }),
    field: "input",
  },
  {
    id: "FULL input",
    schema: publicSchemas.Run,
    value: () => ({ ...basic, input: own() }),
    field: "input",
  },
  { id: "result object", schema: publicSchemas.Result, value: own },
  {
    id: "error details",
    schema: publicSchemas.RunError,
    value: () => ({ source: "FUNCTION", message: "test", details: own() }),
    field: "details",
  },
  {
    id: "status data",
    schema: publicSchemas.RuntimeStatus,
    value: () => ({ message: "test", reportTime: basic.createTime, data: own() }),
    field: "data",
  },
];
it.each(cases)(
  "preserves every own key through $id parse and actual provider encoding",
  ({ schema, value, field }) => {
    const input = value();
    const original = JSON.stringify(select(input, field));
    const parsed = schema.parse(input);
    const serializer = serializerCompiler({
      schema,
      method: "GET",
      url: "/krun-test",
      httpStatus: "200",
    });
    const encoded: unknown = JSON.parse(serializer(input));
    expect(JSON.stringify(select(parsed, field))).toBe(original);
    expect(JSON.stringify(select(encoded, field))).toBe(original);
    expect(Object.hasOwn(select(encoded, field), "__proto__")).toBe(true);
    expect(Object.hasOwn(Object.prototype, "sentinel")).toBe(false);
  },
);
it("discards known output-only members rather than validating or forwarding their values", () => {
  const parsed = publicContracts.CreateRun.schema.body.parse({
    input: {},
    name: 42,
    state: false,
    attempt: "ignored",
    createTime: "ignored",
    error: ["ignored"],
    result: { ignored: true },
  });
  expect(JSON.parse(JSON.stringify(parsed))).toEqual({ input: {}, priority: 0 });
});
it("does not weaken null,unknown or writable input validation", () => {
  const body = publicContracts.CreateRun.schema.body;
  for (const value of [
    { input: null },
    { input: [] },
    { input: {}, unexpected: 1 },
    { input: {}, state: null },
    { input: {}, priority: 10 },
    { input: {}, callback: { url: null } },
    { input: {}, callback: { url: "https://example.invalid", unexpected: 1 } },
  ])
    expect(body.safeParse(value).success).toBe(false);
  expect(
    body.safeParse({
      input: { nested: null },
      priority: 9,
      callback: { url: "https://example.invalid" },
    }).success,
  ).toBe(true);
  expect(publicSchemas.Run.safeParse({ ...basic, input: {}, state: 42 }).success).toBe(false);
});
it.each(
  Object.keys(publicSchemas.Run.shape).filter(
    (key) => !["input", "priority", "callback"].includes(key),
  ),
)("discards output-only %s without applying output validation", (field) => {
  const parsed = publicContracts.CreateRun.schema.body.parse({
    input: {},
    [field]: "krun-test-ignored",
  });
  expect(JSON.parse(JSON.stringify(parsed))).toEqual({ input: {}, priority: 0 });
});
it("projects only the explicitly supported opaque leaves and fails closed otherwise", () => {
  expect(() =>
    z.toJSONSchema(publicSchemas.Function, { unrepresentable: publicContractProjection }),
  ).not.toThrow();
  expect(() =>
    z.toJSONSchema(
      z.custom<Record<string, unknown>>(() => true),
      { unrepresentable: publicContractProjection },
    ),
  ).toThrow("Custom types cannot be represented");
});
