import { createHmac } from "node:crypto";
import { z } from "zod";

export const securityKey = (key: string, principal: "owner" | "other") =>
  createHmac("sha256", key).update(`krun-test-security-${principal}`).digest("hex");

export const securityPrincipals = (key: string) =>
  (["owner", "other"] as const).map((principal) => ({
    name: `e2e-security-${principal}`,
    key: securityKey(key, principal),
    scopes: ["runs:read", "runs:write"],
    functions: ["krun-test-security-*"],
  }));

const errors = {
  TOKEN_INVALID: [401, "UNAUTHENTICATED", "Token invalid"],
  FUNCTION_NOT_FOUND: [404, "NOT_FOUND", "Function not found"],
  RUN_NOT_FOUND: [404, "NOT_FOUND", "Run not found"],
  CALLBACK_NOT_ALLOWED: [400, "INVALID_ARGUMENT", "Callback is not allowed"],
} as const;
export const securityFailure = (value: unknown, reason: keyof typeof errors) => {
  const [code, status, message] = errors[reason];
  const info = z.strictObject({
    "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
    reason: z.literal(reason),
    domain: z.literal("krun.io"),
  });
  const details =
    reason === "CALLBACK_NOT_ALLOWED"
      ? z.tuple([
          info,
          z.strictObject({
            "@type": z.literal("type.googleapis.com/google.rpc.BadRequest"),
            fieldViolations: z.tuple([
              z.strictObject({
                field: z.literal("callback.url"),
                description: z.literal("Callback is not allowed"),
              }),
            ]),
          }),
        ])
      : z.tuple([info]);
  const parsed = z
    .strictObject({
      status: z.literal(code),
      body: z.strictObject({
        error: z.strictObject({
          code: z.literal(code),
          status: z.literal(status),
          message: z.literal(message),
          details,
        }),
      }),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new Error("Native security response violates its opaque error boundary");
};

// Only connect-timeout without a TCP connection is a denial. Refusal, DNS,
// missing executables and kubectl/transport failures are never negative proof.
export const securityProbe = (output: string): "open" | "blocked" => {
  const match = /^krun-security-probe:(\d+):(\d+(?:\.\d+)?)$/.exec(output.trim());
  if (match) {
    const code = Number(match[1]);
    const connected = Number(match[2]);
    if ([0, 28, 52, 56].includes(code) && connected > 0) return "open";
    if (code === 28 && connected === 0) return "blocked";
  }
  throw new Error("Job network probe lacks a valid TCP outcome");
};
