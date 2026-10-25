import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { expect, it } from "vitest";
import { renderPublicOpenApi } from "../../apps/gateway/dev/openapi.ts";
import { publicContracts, publicSchemas } from "../../apps/gateway/src/public-contracts.ts";

it.each([
  { name: "ignored-output-name" },
  { attempt: "ignored-output-attempt" },
  { createdBy: 42 },
  { error: "ignored-output-error" },
])("CreateRun ignores recognized non-null output-only field values: %j", (outputOnly) => {
  expect(
    publicContracts.CreateRun.schema.body.safeParse({ input: {}, ...outputOnly }).success,
  ).toBe(true);
});
it("retains strict unknown/null/input checks and accepts correctly shaped output-only fields", () => {
  const body = publicContracts.CreateRun.schema.body;
  expect(body.safeParse({ input: {} }).success).toBe(true);
  expect(body.safeParse({ input: {}, attempt: 7 }).success).toBe(true);
  expect(body.safeParse({ input: {}, accidental: "unknown" }).success).toBe(false);
  expect(body.safeParse({ input: null }).success).toBe(false);
  expect(body.safeParse({ input: {}, priority: 10 }).success).toBe(false);
  expect(body.safeParse({ input: {}, callback: { url: null } }).success).toBe(false);
});
it("all generated components compile independently and preserve future response enum values", async () => {
  const document = await renderPublicOpenApi();
  const defs = JSON.parse(
    JSON.stringify(document.components?.schemas).replaceAll("#/components/schemas/", "#/$defs/"),
  );
  const ajv = new Ajv2020({
    strict: true,
    strictTuples: false,
    ownProperties: true,
    logger: false,
  });
  formatsPlugin.default(ajv);
  ajv.addKeyword("x-field-behavior");
  for (const name of Object.keys(defs))
    expect(ajv.compile({ $defs: defs, $ref: `#/$defs/${name}` })).toBeTypeOf("function");
  const value = {
    name: "functions/echo/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
    state: "FUTURE_STATE",
    attempt: 0,
    priority: 0,
    createdBy: "review",
    createTime: "2026-10-25T00:00:00.000Z",
    input: { nested: [null, false] },
    result: 0,
    error: { source: "FUTURE_ORIGIN", message: "", details: { value: null } },
    failureReason: "FUTURE_FAILURE",
  };
  expect(publicSchemas.Run.safeParse(value).success).toBe(true);
  expect(ajv.compile({ $defs: defs, $ref: "#/$defs/Run" })(value)).toBe(true);
  expect(ajv.compile({ $defs: defs, $ref: "#/$defs/Run" })({ ...value, result: null })).toBe(false);
});
it("concurrent render scopes produce equal documents without global component registration", async () => {
  const documents = await Promise.all([
    renderPublicOpenApi(),
    renderPublicOpenApi(),
    renderPublicOpenApi(),
  ]);
  expect(documents[1]).toEqual(documents[0]);
  expect(documents[2]).toEqual(documents[0]);
  for (const schema of Object.values(publicSchemas)) expect(schema.meta()?.id).toBeUndefined();
});
it("generated request schemas match ignored output-only non-null values", async () => {
  const document = await renderPublicOpenApi();
  const operation = document.paths?.["/v1/functions/{function}/runs"]?.post;
  const request = operation?.requestBody;
  if (!request || "$ref" in request) throw new Error("Expected generated CreateRun request body");
  const schema = request.content?.["application/json"]?.schema;
  const defs = JSON.parse(
    JSON.stringify(document.components?.schemas).replaceAll("#/components/schemas/", "#/$defs/"),
  );
  const body = JSON.parse(JSON.stringify(schema).replaceAll("#/components/schemas/", "#/$defs/"));
  const ajv = new Ajv2020({
    strict: true,
    strictTuples: false,
    ownProperties: true,
    logger: false,
  });
  formatsPlugin.default(ajv);
  ajv.addKeyword("x-field-behavior");
  const validate = ajv.compile({ $defs: defs, ...body });
  for (const value of [
    { input: {}, name: 42 },
    { input: {}, error: ["ignored"] },
    { input: {}, createdBy: false },
  ])
    expect(validate(value)).toBe(true);
  for (const value of [
    { input: null },
    { input: {}, name: null },
    { input: {}, unknown: 1 },
    { input: {}, priority: 10 },
  ])
    expect(validate(value)).toBe(false);
});
