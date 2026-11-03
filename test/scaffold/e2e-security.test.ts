import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  securityFailure,
  securityKey,
  securityPrincipals,
  securityProbe,
} from "../e2e/lib/security.js";

const reasons = {
  TOKEN_INVALID: [401, "UNAUTHENTICATED", "Token invalid"],
  FUNCTION_NOT_FOUND: [404, "NOT_FOUND", "Function not found"],
  RUN_NOT_FOUND: [404, "NOT_FOUND", "Run not found"],
  CALLBACK_NOT_ALLOWED: [400, "INVALID_ARGUMENT", "Callback is not allowed"],
} as const;
for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
  const [code, status, message] = reasons[reason];
  const reply = () => ({
    status: code,
    body: {
      error: {
        code,
        status,
        message,
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "krun.io" },
          ...(reason === "CALLBACK_NOT_ALLOWED"
            ? [
                {
                  "@type": "type.googleapis.com/google.rpc.BadRequest",
                  fieldViolations: [
                    { field: "callback.url", description: "Callback is not allowed" },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  });
  it(`accepts only the canonical native ${reason} boundary`, () => {
    expect(() => securityFailure(reply(), reason)).not.toThrow();
    expect(() => securityFailure({ ...reply(), status: 503 }, reason)).toThrow();
    const wrong = reply();
    wrong.body.error.message = "private diagnostic" as typeof message;
    expect(() => securityFailure(wrong, reason)).toThrow();
  });
  it(`rejects leaked validation detail and extra fields for ${reason}`, () => {
    const extra = {
      ...reply().body.error.details[0],
      metadata: { validationReason: "SchemaInvalid" },
    };
    expect(() =>
      securityFailure(
        { ...reply(), body: { error: { ...reply().body.error, details: [extra] } } },
        reason,
      ),
    ).toThrow();
    expect(() =>
      securityFailure({ ...reply(), body: { ...reply().body, input: "not permitted" } }, reason),
    ).toThrow();
  });
}
it("derives distinct non-admin principals without storing static test credentials", () => {
  const root = randomBytes(32).toString("hex");
  const owner = securityKey(root, "owner");
  expect(owner === securityKey(root, "owner")).toBe(true);
  expect(owner === root || owner === securityKey(root, "other")).toBe(false);
  expect(/^[a-f0-9]{64}$/.test(owner)).toBe(true);
});
it("requires a real TCP connection for the positive Job probe", () => {
  expect(securityProbe("krun-security-probe:0:0.001234")).toBe("open");
  expect(securityProbe("krun-security-probe:52:0.001234")).toBe("open");
  expect(securityProbe("krun-security-probe:28:0.000000")).toBe("blocked");
});
for (const output of [
  "krun-security-probe:7:0.000000",
  "krun-security-probe:6:0.000000",
  "krun-security-probe:127:0.000000",
  "krun-security-probe:0:0.000000",
  "krun-security-probe:28:NaN",
  "unrelated failure",
])
  it("never calls refusal, DNS, missing binary or malformed output a policy denial", () => {
    expect(() => securityProbe(output)).toThrow();
  });

it("gives the two actual chart security principals only scoped non-admin Run permissions", () => {
  const key = randomBytes(32).toString("hex");
  const principals = securityPrincipals(key);
  expect(principals.map((p) => p.name)).toEqual(["e2e-security-owner", "e2e-security-other"]);
  expect(
    principals.every(
      (p) =>
        p.scopes.join(",") === "runs:read,runs:write" &&
        p.functions.join(",") === "krun-test-security-*",
    ),
  ).toBe(true);
  expect(new Set(principals.map((p) => p.key)).size).toBe(2);
  expect(principals.some((p) => p.key === key)).toBe(false);
});
