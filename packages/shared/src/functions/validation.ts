import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { Duration } from "effect";
import { z } from "zod";
import { durationToMilliseconds } from "../config/duration.js";
import { compileHostAllowlist } from "../webhook/index.js";
import { type FunctionSpec, type functionReadyReasonSchema, functionSpecSchema } from "./schema.js";

export interface FunctionCeilings {
  readonly maxActiveDeadline: number;
  readonly maxQueued: number;
  readonly allowedRegistries: readonly string[];
  readonly allowedServiceAccounts: readonly string[];
  readonly webhookAllowedHosts: readonly string[];
}

type FailureReason = Exclude<z.infer<typeof functionReadyReasonSchema>, "Valid">;
export type FunctionValidation =
  | {
      readonly ok: true;
      readonly reason: "Valid";
      readonly message: "";
      readonly validate: ValidateFunction<unknown>;
      readonly queueTimeout: Duration.Duration;
      readonly heartbeatTimeout?: Duration.Duration;
    }
  | {
      readonly ok: false;
      readonly reason: FailureReason;
      readonly message: string;
      readonly queueTimeout?: Duration.Duration;
    };

const ceilingsSchema = z.strictObject({
  maxActiveDeadline: z.int().nonnegative(),
  maxQueued: z.int().nonnegative(),
  allowedRegistries: z.array(z.string()),
  allowedServiceAccounts: z.array(z.string()),
  webhookAllowedHosts: z.array(z.string()),
});

// Inspect only the owned JSON snapshot. Iteration avoids recursion in the reference walk.
const localReferencesOnly = (schema: unknown): boolean => {
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") continue;
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === "$ref" || key === "$dynamicRef") &&
        (typeof item !== "string" || !item.startsWith("#"))
      )
        return false;
      if (item !== null && typeof item === "object") stack.push(item);
    }
  }
  return true;
};

/** Pure second layer: callers own wire parsing, informer caching and all I/O. */
export const validateFunction = (
  spec: FunctionSpec,
  ceilings: FunctionCeilings,
): FunctionValidation => {
  let queueTimeout: Duration.Duration | undefined;
  const failure = (reason: FailureReason, message: string): FunctionValidation => ({
    ok: false,
    reason,
    message,
    ...(queueTimeout === undefined ? {} : { queueTimeout }),
  });
  try {
    const raw = { ...spec };
    const queueMillis = durationToMilliseconds(raw.queueTimeout);
    if (queueMillis === undefined || queueMillis < 1)
      return failure(
        "InvalidDuration",
        "spec.queueTimeout must be a representable duration of at least 1ms",
      );
    queueTimeout = Duration.millis(queueMillis);
    const heartbeatMillis =
      raw.heartbeatTimeout === undefined ? undefined : durationToMilliseconds(raw.heartbeatTimeout);
    if (
      raw.heartbeatTimeout !== undefined &&
      (heartbeatMillis === undefined || heartbeatMillis < 30000)
    )
      return failure(
        "InvalidDuration",
        "spec.heartbeatTimeout must be a representable duration of at least 30s",
      );
    const parsed = functionSpecSchema.safeParse(raw);
    if (!parsed.success)
      return failure("SchemaInvalid", "Function spec does not satisfy the wire schema");
    const limits = ceilingsSchema.safeParse(ceilings);
    if (!limits.success)
      return failure("SchemaInvalid", "Function validation settings are invalid");
    const value = parsed.data;
    if (
      limits.data.allowedRegistries.length > 0 &&
      !limits.data.allowedRegistries.some((prefix) => value.image.startsWith(prefix))
    )
      return failure("RegistryNotAllowed", "spec.image is outside the allowed registry prefixes");
    if (!limits.data.allowedServiceAccounts.includes(value.serviceAccountName))
      return failure("ServiceAccountNotAllowed", "spec.serviceAccountName is not allowed");
    if (value.secretRefs?.some((name) => name.startsWith("krun-")))
      return failure("SecretRefNotAllowed", "spec.secretRefs contains a reserved name");
    if (value.activeDeadlineSeconds > limits.data.maxActiveDeadline)
      return failure(
        "DeadlineAboveCeiling",
        "spec.activeDeadlineSeconds exceeds the installation ceiling",
      );
    if (value.maxQueued > limits.data.maxQueued)
      return failure("QueuedAboveCeiling", "spec.maxQueued exceeds the installation ceiling");
    if (value.callback !== undefined) {
      const matches = compileHostAllowlist(limits.data.webhookAllowedHosts);
      let host: string;
      try {
        host = new URL(value.callback.url).hostname.replace(/^\[|\]$/g, "");
      } catch {
        return failure("CallbackNotAllowed", "spec.callback.url does not have an allowed host");
      }
      if (!host || !matches?.(host))
        return failure("CallbackNotAllowed", "spec.callback.url does not have an allowed host");
    }
    // Serialization, size, reference checks and compilation all see the same owned JSON values.
    const serialized = JSON.stringify(value.inputSchema);
    if (Buffer.byteLength(serialized, "utf8") > 65536)
      return failure("SchemaTooLarge", "spec.inputSchema exceeds 65536 serialized UTF-8 bytes");
    const schema = functionSpecSchema.shape.inputSchema.safeParse(JSON.parse(serialized));
    if (!schema.success || !localReferencesOnly(schema.data))
      return failure("SchemaInvalid", "spec.inputSchema must contain only local references");
    // Fresh instances isolate duplicate IDs across Functions/generations. No loader/async compile exists.
    const ajv = new Ajv2020({ strict: true, ownProperties: true, logger: false });
    // The published CommonJS entrypoint exports this typed default plugin.
    // Register it completely, including its default format-comparison keywords.
    formatsPlugin.default(ajv);
    const validate = ajv.compile<unknown>(schema.data);
    if ("$async" in validate && validate.$async === true)
      return failure("SchemaInvalid", "spec.inputSchema must compile to a synchronous validator");
    return {
      ok: true,
      reason: "Valid",
      message: "",
      validate,
      queueTimeout,
      ...(heartbeatMillis === undefined
        ? {}
        : { heartbeatTimeout: Duration.millis(heartbeatMillis) }),
    };
  } catch {
    // Never retain compiler errors, schemas, Function environment values or callback URLs.
    return failure("SchemaInvalid", "spec.inputSchema could not be serialized or compiled");
  }
};
