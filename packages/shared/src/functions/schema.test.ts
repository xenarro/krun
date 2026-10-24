import { expect, it } from "vitest";
import { z } from "zod";
import { durationStringSchema } from "../config/duration.ts";
import {
  functionDurationSchema,
  functionIdentitySchema,
  functionImageSchema,
  functionImageValidation,
  functionReadyReasonSchema,
} from "./schema.ts";

it("requires the explicitly specified digest marker without a registry allowlist", () => {
  const image = `example.invalid/krun-test/function@sha256:${"0".repeat(64)}`;
  expect(functionImageSchema.parse(image)).toBe(image);
  for (const value of [
    "example.invalid/krun-test/function:latest",
    "example.invalid/krun-test/function",
    "example.invalid/krun-test/function@sha512:abc",
  ]) {
    expect(functionImageSchema.safeParse(value).success).toBe(false);
  }
  expect(functionImageValidation).toEqual({
    rule: "self.image.contains('@sha256:')",
    message: "image must contain @sha256:",
  });
});

it("keeps positive integer identities and the normative 65532 default on the wire", () => {
  expect(functionIdentitySchema.parse(undefined)).toBe(65532);
  expect(functionIdentitySchema.parse(1)).toBe(1);
  for (const value of [0, -1, 1.5, "65532", null])
    expect(functionIdentitySchema.safeParse(value).success).toBe(false);
  const fields = z.strictObject({
    runAsUser: functionIdentitySchema,
    runAsGroup: functionIdentitySchema,
  });
  expect(fields.parse({})).toEqual({ runAsUser: 65532, runAsGroup: 65532 });
  const json = z.toJSONSchema(fields, { target: "openapi-3.0", io: "input" });
  expect(json.properties?.runAsUser).toMatchObject({ type: "integer", minimum: 1, default: 65532 });
  expect(json.required ?? []).toEqual([]);
});

it("reuses the config duration wire schema without transforms or heartbeat policy", () => {
  expect(functionDurationSchema).toBe(durationStringSchema);
  for (const value of ["0ms", "1s", "5m", "12h"])
    expect(functionDurationSchema.parse(value)).toBe(value);
  for (const value of ["1d", "1.5s", "-1s", "5M", "1 h", "", 1000])
    expect(functionDurationSchema.safeParse(value).success).toBe(false);
  expect(
    z.toJSONSchema(functionDurationSchema, { target: "openapi-3.0", io: "input" }),
  ).toMatchObject({
    type: "string",
    pattern: "^\\d+(ms|s|m|h)$",
  });
});

it("enumerates only the SPEC Ready reasons, not a condition required-field policy", () => {
  const reasons = [
    "Valid",
    "SchemaInvalid",
    "SchemaTooLarge",
    "DeadlineAboveCeiling",
    "QueuedAboveCeiling",
    "RegistryNotAllowed",
    "ServiceAccountNotAllowed",
    "SecretRefNotAllowed",
    "CallbackNotAllowed",
    "InvalidDuration",
  ];
  expect(functionReadyReasonSchema.options).toEqual(reasons);
  for (const reason of reasons) expect(functionReadyReasonSchema.parse(reason)).toBe(reason);
  expect(functionReadyReasonSchema.safeParse("krun-test-unknown").success).toBe(false);
});
