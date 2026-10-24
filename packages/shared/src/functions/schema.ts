import { z } from "zod";
import { durationPattern, durationRangePattern, durationStringSchema } from "../config/duration.ts";

// Raw wire strings and parsed output types remain distinct: defaults do not
// become required create inputs in the generated schemas.
export const functionImageSchema = z.string().regex(/@sha256:/);
export const functionIdentitySchema = z.int().min(1).default(65532);
export const functionDurationSchema = durationStringSchema;
export const functionImageValidation = {
  rule: "self.image.contains('@sha256:')",
  message: "image must contain @sha256:",
} as const;

export const functionReadyReasonSchema = z.enum([
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
]);

const boundedDuration = (minimum: number) => {
  const pattern = durationRangePattern(minimum);
  return durationStringSchema.regex(new RegExp(pattern)).meta({
    pattern: durationPattern,
    allOf: [{ pattern }],
  });
};
export const functionQueueTimeoutSchema = boundedDuration(1).default("1h");
export const functionHeartbeatTimeoutSchema = boundedDuration(30000);

// RFC 3986 components, using only syntax shared by ECMAScript and RE2.
// A wire URI is not a WHATWG URL normalization operation or an allowlist.
const uriAtom = "(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})";
const pchar = `(?:${uriAtom}|[:@])`;
const h16 = "[0-9A-Fa-f]{1,4}";
const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ipv4 = `${octet}(?:\\.${octet}){3}`;
const ls32 = `(?:${h16}:${h16}|${ipv4})`;
const ipv6 = [
  `(?:${h16}:){6}${ls32}`,
  `::(?:${h16}:){5}${ls32}`,
  `(?:${h16})?::(?:${h16}:){4}${ls32}`,
  `(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
  `(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
  `(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
  `(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
  `(?:(?:${h16}:){0,5}${h16})?::${h16}`,
  `(?:(?:${h16}:){0,6}${h16})?::`,
].join("|");
const ipLiteral = `\\[(?:${ipv6}|[vV][0-9A-Fa-f]+\\.[A-Za-z0-9._~!$&'()*+,;=:-]+)\\]`;
const authority = `(?:(?:${uriAtom}|:)*@)?(?:${ipLiteral}|${uriAtom}+)(?::[0-9]*)?`;
const hierarchy = `(?://${authority}(?:/${pchar}*)*|/(?:${pchar}+(?:/${pchar}*)*)?|${pchar}+(?:/${pchar}*)*)`;
const callbackPattern = `^[A-Za-z][A-Za-z0-9+.-]*:${hierarchy}(?:\\?(?:${pchar}|[/?])*)?(?:#(?:${pchar}|[/?])*)?$`;
const callbackUrl = z.string().regex(new RegExp(callbackPattern)).meta({ format: "uri" });

// A record parser rebuilds the dictionary and deliberately drops __proto__.
// Keep this opaque boundary identity-preserving; no assignment/copy is needed.
const functionInputSchemaJson = { type: "object", additionalProperties: {} } as const;
const functionInputSchema = z.custom<Record<string, unknown>>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
);
// Do not generalize this to unrepresentable:"any": only this exact opaque
// leaf has an explicitly supported representation; every other leaf throws.
export const functionInputSchemaProjection = ({ zodSchema }: { zodSchema: z.core.$ZodType }) =>
  zodSchema === functionInputSchema ? functionInputSchemaJson : ("throw" as const);

const quantities = z.strictObject({
  cpu: z.string().optional(),
  memory: z.string().optional(),
  "ephemeral-storage": z.string().optional(),
});
export const functionSpecSchema = z.strictObject({
  image: functionImageSchema,
  inputSchema: functionInputSchema,
  serviceAccountName: z.string().default("krun-job-default"),
  runAsUser: functionIdentitySchema,
  runAsGroup: functionIdentitySchema,
  resources: z
    .strictObject({ requests: quantities.optional(), limits: quantities.optional() })
    .optional(),
  env: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
  secretRefs: z.array(z.string()).optional(),
  activeDeadlineSeconds: z.int().min(1).default(3600),
  maxConcurrency: z.int().min(1).default(10),
  maxQueued: z.int().min(0).default(1000),
  queueTimeout: functionQueueTimeoutSchema,
  heartbeatTimeout: functionHeartbeatTimeoutSchema.optional(),
  nodeSelector: z.record(z.string(), z.string()).optional(),
  imagePullSecrets: z.array(z.strictObject({ name: z.string() })).optional(),
  callback: z.strictObject({ url: callbackUrl }).optional(),
});
const condition = z.strictObject({
  type: z.literal("Ready"),
  status: z.enum(["True", "False", "Unknown"]),
  reason: functionReadyReasonSchema,
  message: z.string().default(""),
});
export const functionStatusSchema = z.strictObject({
  observedGeneration: z.int().min(0).optional(),
  // Only Ready exists in v1alpha1, so maxItems:1 also rejects duplicate keys
  // in plain JSON Schema; CRD projection adds native map-list semantics.
  conditions: z.array(condition).max(1).optional(),
});
export const functionMetadataSchema = z.looseObject({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/),
});
export const createFunctionResourceSchema = <Spec extends z.ZodType, Status extends z.ZodType>(
  spec: Spec,
  status: Status,
) =>
  z.strictObject({
    apiVersion: z.literal("krun.io/v1alpha1"),
    kind: z.literal("Function"),
    metadata: functionMetadataSchema,
    spec,
    status: status.optional(),
  });
export const functionResourceSchema = createFunctionResourceSchema(
  functionSpecSchema,
  functionStatusSchema,
);
export type FunctionSpecInput = z.input<typeof functionSpecSchema>;
export type FunctionSpec = z.output<typeof functionSpecSchema>;
export type FunctionResourceInput = z.input<typeof functionResourceSchema>;
export type FunctionResource = z.output<typeof functionResourceSchema>;
