import { describe, expect, it } from "vitest";
import { functionSpecSchema } from "./schema.js";
import { validateFunction } from "./validation.js";

const ceilings = {
  maxActiveDeadline: 86400,
  maxQueued: 1000,
  allowedRegistries: [],
  allowedServiceAccounts: ["krun-job-default"],
  webhookAllowedHosts: [],
};
const check = (inputSchema: Record<string, unknown>) =>
  validateFunction(
    functionSpecSchema.parse({ image: "example.invalid/job@sha256:abc", inputSchema }),
    ceilings,
  );
const literal = {
  $ref: "https://literal.example.invalid/value",
  $dynamicRef: "ordinary instance data",
};
const ordinary: ReadonlyArray<{
  id: string;
  schema: Record<string, unknown>;
  good: unknown;
  bad: unknown;
}> = [
  {
    id: "property-ref",
    schema: { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"] },
    good: { $ref: "text" },
    bad: { $ref: 7 },
  },
  {
    id: "property-dynamic",
    schema: {
      type: "object",
      properties: { $dynamicRef: { type: "string" } },
      required: ["$dynamicRef"],
    },
    good: { $dynamicRef: "text" },
    bad: { $dynamicRef: 7 },
  },
  {
    id: "definition-ref",
    schema: { $defs: { $ref: { type: "string" } }, $ref: "#/$defs/$ref" },
    good: "text",
    bad: 7,
  },
  {
    id: "legacy-definition-dynamic",
    schema: { definitions: { $dynamicRef: { type: "string" } }, $ref: "#/definitions/$dynamicRef" },
    good: "text",
    bad: 7,
  },
  {
    id: "pattern-ref",
    schema: { type: "object", patternProperties: { "^\\$ref$": { type: "string" } } },
    good: { $ref: "text" },
    bad: { $ref: 7 },
  },
  { id: "default-data", schema: { type: "object", default: literal }, good: {}, bad: 7 },
  { id: "enum-data", schema: { type: "object", enum: [literal] }, good: literal, bad: {} },
  { id: "const-data", schema: { type: "object", const: literal }, good: literal, bad: {} },
  { id: "examples-data", schema: { type: "object", examples: [literal] }, good: {}, bad: 7 },
  {
    id: "dependent-required-data",
    schema: {
      type: "object",
      properties: { a: true, $ref: true },
      dependentRequired: { a: ["$ref"] },
    },
    good: { a: 1, $ref: 1 },
    bad: { a: 1 },
  },
  {
    id: "dependencies-data",
    schema: {
      type: "object",
      properties: { a: true, $dynamicRef: true },
      dependencies: { a: ["$dynamicRef"] },
    },
    good: { a: 1, $dynamicRef: 1 },
    bad: { a: 1 },
  },
  {
    id: "pointer-promoted-default",
    schema: { default: { type: "string" }, $ref: "#/default" },
    good: "text",
    bad: 7,
  },
  {
    id: "pointer-escaped-name",
    schema: { $defs: { "a/b~c": { type: "string" } }, $ref: "#/$defs/a~1b~0c" },
    good: "text",
    bad: 7,
  },
  {
    id: "pointer-encoded-name",
    schema: { $defs: { "a/b": { type: "string" } }, $ref: "#/$defs/a%2Fb" },
    good: "text",
    bad: 7,
  },
  {
    id: "embedded-resource",
    schema: {
      $defs: { embedded: { $id: "https://schema.example.invalid/inner", type: "string" } },
      $ref: "#/$defs/embedded",
    },
    good: "text",
    bad: 7,
  },
];
const schemaLocations: ReadonlyArray<{
  id: string;
  wrap: (value: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    id: "referenced-unknown-anchor",
    wrap: (s) => ({
      $defs: { unused: { notASchemaKeyword: { $anchor: "hidden", ...s } } },
      $ref: "#hidden",
    }),
  },
  { id: "root", wrap: (s) => s },
  ...[
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
  ].map((key) => ({
    id: key,
    wrap: (s: Record<string, unknown>) => ({ type: "object", [key]: { $ref: s } }),
  })),
  ...[
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ].map((key) => ({
    id: key,
    wrap: (s: Record<string, unknown>) => ({ type: "object", [key]: s }),
  })),
  ...["allOf", "anyOf", "oneOf", "prefixItems"].map((key) => ({
    id: key,
    wrap: (s: Record<string, unknown>) => ({ type: "array", [key]: [s] }),
  })),
  ...["items", "contains", "unevaluatedItems", "additionalItems"].map((key) => ({
    id: key,
    wrap: (s: Record<string, unknown>) => ({ type: "array", [key]: s }),
  })),
  { id: "pointer-default", wrap: (s) => ({ default: s, $ref: "#/default" }) },
  { id: "pointer-const", wrap: (s) => ({ const: s, $ref: "#/const" }) },
  { id: "pointer-enum", wrap: (s) => ({ enum: [s], $ref: "#/enum/0" }) },
  {
    id: "embedded-pointer-default",
    wrap: (s) => ({
      $defs: {
        embedded: { $id: "https://schema.example.invalid/inner", default: s, $ref: "#/default" },
      },
      $ref: "#/$defs/embedded",
    }),
  },
];

describe("P25-C1 schema-reference context", () => {
  it.each(ordinary)(
    "keeps ordinary $id semantics and actual compiled constraints",
    ({ schema, good, bad }) => {
      const before = JSON.stringify(schema);
      const result = check(schema);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ordinary schema to compile");
      expect(result.validate(good)).toBe(true);
      expect(result.validate(bad)).toBe(false);
      expect(JSON.stringify(schema)).toBe(before);
    },
  );
  for (const reference of ["$ref", "$dynamicRef"]) {
    it.each(schemaLocations)(
      `rejects active remote ${reference} at $id before native compilation`,
      ({ wrap }) => {
        // Already-registered meta-schema proves rejection is the guard, not a missing loader.
        const result = check(wrap({ [reference]: "https://json-schema.org/draft/2020-12/schema" }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("SchemaInvalid");
        expect(result.message).toBe("spec.inputSchema must contain only local references");
      },
    );
  }
  it("retains strict unknown-keyword rejection and synchronous-only compilation", () => {
    expect(check({ unknownKeyword: { $ref: "literal" } }).ok).toBe(false);
    expect(check({ $async: true, type: "string" }).ok).toBe(false);
  });
});
