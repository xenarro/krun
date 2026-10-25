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

// Ajv2020's standard schema locations, plus its supported legacy dependencies/items.
// Map keys and annotations/instance data are not schema keywords (SPEC D51).
const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const schemaData = new Set([
  "default",
  "const",
  "enum",
  "examples",
  "required",
  "dependentRequired",
]);
const schemaObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
interface SchemaLocation {
  readonly node: unknown;
  readonly resource: Record<string, unknown>;
}
const resourceAt = (node: Record<string, unknown>, current: Record<string, unknown>) =>
  Object.hasOwn(node, "$id") && typeof node.$id === "string" && node.$id !== "" && node.$id !== "#"
    ? node
    : current;

// A local pointer can turn otherwise opaque data into an actual schema. Resolve only
// own JSON members, decoding each pointer segment separately; never fetch anything.
const localPointer = (
  resource: Record<string, unknown>,
  ref: string,
): SchemaLocation | undefined => {
  if (ref === "#") return { node: resource, resource };
  if (!ref.startsWith("#/")) return undefined; // Anchors remain the strict compiler's job.
  let node: unknown = resource;
  let current = resource;
  try {
    for (const part of ref.slice(2).split("/")) {
      const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
      if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
      node = Reflect.get(node, key);
      if (schemaObject(node)) current = resourceAt(node, current);
    }
    return { node, resource: current };
  } catch {
    return undefined;
  } // Malformed/unresolvable fragments fail native compilation.
};

// Inspect only the owned JSON snapshot; iteration and identity tracking handle local
// recursive references without recursive JS calls or schema/instance-data rewriting.
const localReferencesOnly = (schema: unknown): boolean => {
  if (!schemaObject(schema)) return true;
  const stack: SchemaLocation[] = [{ node: schema, resource: schema }];
  const seen = new Map<object, Set<object>>();
  while (stack.length > 0) {
    const location = stack.pop();
    if (location === undefined || !schemaObject(location.node)) continue;
    const value = location.node;
    const resource = resourceAt(value, location.resource);
    const scopes = seen.get(value) ?? new Set<object>();
    if (scopes.has(resource)) continue;
    scopes.add(resource);
    seen.set(value, scopes);
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" || key === "$dynamicRef") {
        if (typeof item !== "string" || !item.startsWith("#")) return false;
        const target = localPointer(resource, item);
        if (target !== undefined) stack.push(target);
      } else if (schemaData.has(key)) continue;
      else if (schemaMaps.has(key) && schemaObject(item)) {
        for (const child of Object.values(item)) stack.push({ node: child, resource });
      } else if (Array.isArray(item)) {
        for (const child of item) stack.push({ node: child, resource });
      } else if (schemaObject(item)) {
        // Preserve conservative inspection of unknown object keywords: Ajv's
        // reference index may register their anchors before strict compilation.
        stack.push({ node: item, resource });
      }
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
