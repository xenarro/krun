import { expect, it } from "vitest";
import { functionSpecSchema } from "./schema.js";
import { type FunctionCeilings, validateFunction } from "./validation.js";

const ceilings: FunctionCeilings = {
  maxActiveDeadline: 86400,
  maxQueued: 1000,
  allowedRegistries: [],
  allowedServiceAccounts: ["krun-job-default"],
  webhookAllowedHosts: [],
};
const own = (name: string, value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify({ [name]: value }));
const compile = (schema: Record<string, unknown>) => {
  const result = validateFunction(
    functionSpecSchema.parse({
      image: `ghcr.io/krun-test/worker@sha256:${"a".repeat(64)}`,
      inputSchema: schema,
    }),
    ceilings,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected faithfully compiled schema");
  return result.validate;
};

for (const name of ["__proto__", "constructor", "prototype", "ordinary"]) {
  for (const required of [false, true]) {
    for (const nested of [false, true]) {
      it(`enforces ${name} value/presence,required=${required},nested=${nested}`, () => {
        const object = {
          type: "object",
          properties: own(name, { type: "integer" }),
          ...(required ? { required: [name] } : {}),
          additionalProperties: false,
        };
        const schema = nested
          ? {
              type: "object",
              properties: { child: object },
              required: ["child"],
              additionalProperties: false,
            }
          : object;
        const validate = compile(schema);
        const wrap = (value: unknown) => (nested ? { child: value } : value);
        expect(validate(wrap(own(name, 1)))).toBe(true);
        expect(validate(wrap(own(name, "wrong")))).toBe(false);
        expect(validate(wrap({}))).toBe(!required);
        expect(validate(wrap(Object.create(own(name, 1))))).toBe(!required);
      });
    }
  }
}

it("keeps boolean and empty own-property schemas with additionalProperties false", () => {
  for (const constraint of [true, {}, false]) {
    const validate = compile({
      type: "object",
      properties: own("__proto__", constraint),
      additionalProperties: false,
    });
    expect(validate(own("__proto__", 1))).toBe(constraint !== false);
    expect(validate({ other: 1 })).toBe(false);
  }
});

it("enforces an own regex named __proto__ in patternProperties", () => {
  const validate = compile({
    type: "object",
    patternProperties: own("__proto__", { type: "integer" }),
    additionalProperties: false,
  });
  expect(validate(own("__proto__", 1))).toBe(true);
  expect(validate(own("__proto__", "wrong"))).toBe(false);
  expect(validate({ other: 1 })).toBe(false);
});

it("preserves additional schema semantics and the large property-map code path", () => {
  const properties = {
    ...own("__proto__", { type: "integer" }),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, { type: "integer" }])),
  };
  const validate = compile({
    type: "object",
    properties,
    additionalProperties: { type: "string" },
  });
  expect(validate({ ...own("__proto__", 1), other: "allowed" })).toBe(true);
  expect(validate({ ...own("__proto__", "wrong"), other: "allowed" })).toBe(false);
  expect(validate({ other: 1 })).toBe(false);
});

it("keeps static evaluated maps faithful for special own JSON names", () => {
  const validate = compile({
    type: "object",
    properties: own("__proto__", { type: "integer" }),
    unevaluatedProperties: false,
  });
  expect(validate(own("__proto__", 1))).toBe(true);
  expect(validate(own("__proto__", "wrong"))).toBe(false);
  expect(validate({ constructor: 1 })).toBe(false);
});

it("keeps dynamic evaluated maps free of inherited property exemptions", () => {
  const validate = compile({
    type: "object",
    anyOf: [
      { properties: own("__proto__", { type: "integer" }), required: ["__proto__"] },
      { properties: { ordinary: { type: "integer" } }, required: ["ordinary"] },
    ],
    unevaluatedProperties: false,
  });
  expect(validate(own("__proto__", 1))).toBe(true);
  expect(validate(own("__proto__", "wrong"))).toBe(false);
  for (const name of [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
  ])
    expect(validate({ ordinary: 1, ...own(name, "not-evaluated") })).toBe(false);
  expect(validate({ ordinary: 1 })).toBe(true);
});

it("merges dynamic branch evaluations without losing own __proto__ marks", () => {
  const validate = compile({
    type: "object",
    allOf: [
      {
        anyOf: [
          { properties: own("__proto__", { type: "integer" }), required: ["__proto__"] },
          { properties: { first: { type: "integer" } }, required: ["first"] },
        ],
      },
      {
        anyOf: [
          { properties: { second: { type: "integer" } }, required: ["second"] },
          { properties: { third: { type: "integer" } }, required: ["third"] },
        ],
      },
    ],
    unevaluatedProperties: false,
  });
  expect(validate({ ...own("__proto__", 1), second: 2 })).toBe(true);
  expect(validate({ ...own("__proto__", "wrong"), second: 2 })).toBe(false);
  expect(validate({ first: 1, third: 3, constructor: 4 })).toBe(false);
});

it("resolves special own-key definitions through unchanged local JSON pointers", () => {
  const schema = {
    type: "object",
    properties: own("__proto__", { $ref: "#/$defs/__proto__" }),
    $defs: own("__proto__", { type: "integer" }),
    additionalProperties: false,
  };
  const before = JSON.stringify(schema);
  const validate = compile(schema);
  expect(validate(own("__proto__", 1))).toBe(true);
  expect(validate(own("__proto__", "wrong"))).toBe(false);
  expect(JSON.stringify(schema)).toBe(before);
});

for (const keyword of ["dependentSchemas", "dependentRequired", "dependencies"]) {
  it(`enforces ${keyword} maps with an own __proto__ trigger`, () => {
    const constraint =
      keyword === "dependentSchemas" ? { properties: { n: { const: 1 } }, required: ["n"] } : ["n"];
    const validate = compile({
      type: "object",
      properties: { ...own("__proto__", { type: "integer" }), n: { type: "integer" } },
      [keyword]: own("__proto__", constraint),
    });
    expect(validate(own("__proto__", 1))).toBe(false);
    expect(validate({ ...own("__proto__", 1), n: 1 })).toBe(true);
    expect(validate({})).toBe(true);
    if (keyword === "dependentSchemas")
      expect(validate({ ...own("__proto__", 1), n: 2 })).toBe(false);
  });
}

it("enforces legacy schema dependencies as well as array dependencies", () => {
  const validate = compile({
    type: "object",
    properties: { ...own("__proto__", { type: "integer" }), n: { type: "integer" } },
    dependencies: own("__proto__", { properties: { n: { const: 1 } }, required: ["n"] }),
  });
  expect(validate(own("__proto__", 1))).toBe(false);
  expect(validate({ ...own("__proto__", 1), n: 1 })).toBe(true);
  expect(validate({ ...own("__proto__", 1), n: 2 })).toBe(false);
});

for (const [keyword, good, bad, equal] of [
  ["formatMinimum", "2026-01-02", "2025-12-31", true],
  ["formatMaximum", "2025-12-31", "2026-01-02", true],
  ["formatExclusiveMinimum", "2026-01-02", "2025-12-31", false],
  ["formatExclusiveMaximum", "2025-12-31", "2026-01-02", false],
] as const) {
  it(`registers the complete default formats plugin and ${keyword} boundary`, () => {
    const validate = compile({
      type: "object",
      properties: { when: { type: "string", format: "date", [keyword]: "2026-01-01" } },
      required: ["when"],
    });
    expect(validate({ when: good })).toBe(true);
    expect(validate({ when: bad })).toBe(false);
    expect(validate({ when: "2026-01-01" })).toBe(equal);
    expect(validate({ when: "2026-02-30" })).toBe(false);
  });
}

it("does not modify Object.prototype during compilation or validation", () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const validate = compile({
    type: "object",
    anyOf: [
      {
        properties: own("__proto__", { type: "object", additionalProperties: { type: "integer" } }),
        required: ["__proto__"],
      },
    ],
    unevaluatedProperties: false,
  });
  expect(validate(own("__proto__", { ownedMarker: 1 }))).toBe(true);
  expect(validate(own("__proto__", { ownedMarker: "wrong" }))).toBe(false);
  expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
});
