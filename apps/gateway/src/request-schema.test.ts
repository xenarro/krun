import { expect, it } from "vitest";
import { z } from "zod";
import { strictRequestRoot } from "./request-schema.js";

const wrappers = [
  ["optional", (schema: z.ZodType) => schema.optional()],
  ["exact optional", (schema: z.ZodType) => z.exactOptional(schema)],
  ["default", (schema: z.ZodType) => schema.default({ value: "default" })],
  ["prefault", (schema: z.ZodType) => schema.prefault({ value: "default" })],
  ["readonly", (schema: z.ZodType) => schema.readonly()],
  ["nonoptional", (schema: z.ZodType) => schema.optional().nonoptional()],
  ["combined", (schema: z.ZodType) => schema.optional().default({ value: "default" }).readonly()],
] as const;
it.each(wrappers)(
  "makes %s root objects strict without mutating the authored schema",
  (_name, wrap) => {
    const object = z.object({ value: z.string().optional() });
    const original = wrap(object);
    const before = original.safeParse({ value: "ok", unexpected: "private" });
    expect(before.success).toBe(true);
    const strict = strictRequestRoot(original);
    expect(strict.safeParse({ value: "ok", unexpected: "private" }).success).toBe(false);
    expect(strict.safeParse({ value: "ok" }).success).toBe(true);
    expect(strict.safeParse(null).success).toBe(false);
    expect(original.safeParse({ unexpected: "private" }).success).toBe(true);
    expect(strict.safeParse(undefined)).toEqual(original.safeParse(undefined));
  },
);
it("retains dynamic default/prefault getters and metadata without executing them at registration", () => {
  for (const kind of ["default", "prefault"] as const) {
    let calls = 0;
    const original = z
      .object({ value: z.string() })
      [kind](() => ({ value: String(++calls) }))
      .meta({ title: "Owned request" });
    const strict = strictRequestRoot(original);
    expect(calls).toBe(0);
    expect(strict.meta()).toEqual({ title: "Owned request" });
    expect(strict.parse(undefined)).toEqual({ value: "1" });
    expect(strict.parse(undefined)).toEqual({ value: "2" });
    expect(original.parse(undefined)).toEqual({ value: "3" });
  }
});
it("retains object refinements and nested opaque-data schemas", () => {
  const opaque = z.custom<object>((input) => input !== null && typeof input === "object");
  const original = z
    .object({ value: z.string(), input: opaque })
    .refine((value) => value.value === "ok")
    .optional();
  const strict = strictRequestRoot(original);
  const input = JSON.parse('{"unexpected":null,"__proto__":{"own":true}}');
  const parsed = strict.parse({ value: "ok", input });
  expect(z.object({ input: z.unknown() }).parse(parsed).input).toBe(input);
  expect(strict.safeParse({ value: "bad", input }).success).toBe(false);
  expect(strict.safeParse({ value: "ok", input, unexpected: "private" }).success).toBe(false);
});
it.each([
  z.object({}).catch({}),
  z.object({}).nullable(),
  z.object({}).nullish(),
  z.object({}).transform((value) => value),
  z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
  z.intersection(z.object({}), z.object({})),
  z.lazy(() => z.object({})),
  z.record(z.string(), z.unknown()),
  z.unknown(),
  z.string(),
])(
  "rejects unsupported or validation-bypassing root forms instead of accepting them implicitly",
  (schema) => {
    expect(() => strictRequestRoot(schema)).toThrow();
  },
);
