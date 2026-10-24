import { readFile } from "node:fs/promises";
import { Context, Data, Duration, Effect, Layer } from "effect";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { durationStringSchema, durationToMilliseconds } from "./duration.js";

type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly variable: string;
}> {
  override get message(): string {
    return `Invalid configuration: ${this.variable}`;
  }
}

const field = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);
const integer = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const size = integer.pipe(z.number().max(1048576));
const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const duration = durationStringSchema.transform((value, ctx) => {
  const millis = durationToMilliseconds(value);
  if (millis === undefined) {
    ctx.addIssue({ code: "custom", message: "duration is not representable" });
    return z.NEVER;
  }
  return Duration.millis(millis);
});
const cidrs = z.string().transform((value, ctx) => {
  try {
    return value.split(",").map((item) => ipaddr.parseCIDR(item.trim()));
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid CIDR" });
    return z.NEVER;
  }
});

// SPEC section 12 order fixes field-error precedence. Unknown process/OS fields
// are stripped; each process selects only the fields it actually consumes.
const fields = {
  KRUN_DB_MODE: field(z.enum(["postgres", "embedded"]).default("postgres")),
  KRUN_DB_DSN: field(z.string().optional()),
  KRUN_DB_PATH: field(z.string().default("/data/krun.db")),
  KRUN_API_KEYS_PATH: field(z.string().default("/etc/krun/keys.yaml")),
  KRUN_LISTEN_ADDR: field(z.string().default(":8080")),
  KRUN_INTERNAL_LISTEN_ADDR: field(z.string().default(":8081")),
  KRUN_ADMIN_LISTEN_ADDR: field(z.string().default(":9090")),
  KRUN_GATEWAY_INTERNAL_URL: field(z.string().optional()),
  KRUN_JOBS_NAMESPACE: field(z.string().default("krun-jobs")),
  KRUN_NAMESPACE: field(z.string()),
  KRUN_MAX_RUNNING: field(integer.prefault("100")),
  KRUN_MAX_QUEUED: field(integer.prefault("1000")),
  KRUN_MAX_INPUT_BYTES: field(size.prefault("262144")),
  KRUN_MAX_RESULT_BYTES: field(size.prefault("262144")),
  KRUN_MAX_WAIT: field(duration.prefault("60s")),
  KRUN_SHUTDOWN_DELAY: field(duration.prefault("5s")),
  KRUN_RATE_LIMIT_RPS: field(integer.prefault("10")),
  KRUN_RATE_LIMIT_BURST: field(integer.prefault("50")),
  KRUN_MAX_ACTIVE_DEADLINE: field(integer.prefault("86400")),
  KRUN_ALLOWED_SERVICE_ACCOUNTS: field(csv.prefault("krun-job-default")),
  KRUN_K8S_CONCURRENCY: field(integer.prefault("8")),
  KRUN_JOB_HOST_USERS: field(
    z
      .enum(["true", "false"])
      .prefault("true")
      .transform((value) => value === "true"),
  ),
  KRUN_TTL_AFTER_FINISHED: field(integer.prefault("86400")),
  KRUN_RETENTION: field(duration.prefault("720h")),
  KRUN_ALLOWED_REGISTRIES: field(csv.default([])),
  KRUN_S3_ENDPOINT: field(z.string().optional()),
  KRUN_S3_BUCKET: field(z.string().optional()),
  KRUN_S3_REGION: field(z.string().optional()),
  KRUN_S3_ACCESS_KEY: field(z.string().optional()),
  KRUN_S3_SECRET_KEY: field(z.string().optional()),
  // Undefined deliberately means the individual Function's deadline, not a
  // fixed process default. The gateway's GET presign is fixed elsewhere.
  KRUN_S3_PRESIGN_TTL: field(duration.optional()),
  KRUN_WEBHOOK_ALLOWED_HOSTS: field(csv.default([])),
  KRUN_WEBHOOK_ALLOWED_CIDRS: field(cidrs.default([])),
  KRUN_WEBHOOK_SECRET: field(csv.default([])),
  KRUN_LOG_LEVEL: field(
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: field(z.string().optional()),
  OTEL_SERVICE_NAME: field(z.string().default("krun-gateway")),
  OTEL_TRACES_SAMPLER: field(z.string().default("parentbased_traceidratio")),
  // OTEL validates its own sampler policy later; P0.5 must not reject it.
  OTEL_TRACES_SAMPLER_ARG: field(z.string().default("0.1")),
};
const all = z.object(fields);
const validateDatabase = (
  config: { KRUN_DB_MODE: "postgres" | "embedded"; KRUN_DB_DSN?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (config.KRUN_DB_MODE === "postgres" && config.KRUN_DB_DSN === undefined) {
    ctx.addIssue({ code: "custom", path: ["KRUN_DB_DSN"], message: "required in postgres mode" });
  }
};

export const GatewayEnv = all
  .omit({
    KRUN_GATEWAY_INTERNAL_URL: true,
    KRUN_JOBS_NAMESPACE: true,
    KRUN_MAX_RUNNING: true,
    KRUN_K8S_CONCURRENCY: true,
    KRUN_JOB_HOST_USERS: true,
    KRUN_TTL_AFTER_FINISHED: true,
    KRUN_RETENTION: true,
    KRUN_S3_PRESIGN_TTL: true,
    KRUN_WEBHOOK_SECRET: true,
  })
  .superRefine(validateDatabase);

export const SchedulerEnv = all
  .omit({
    KRUN_API_KEYS_PATH: true,
    KRUN_LISTEN_ADDR: true,
    KRUN_INTERNAL_LISTEN_ADDR: true,
    KRUN_MAX_INPUT_BYTES: true,
    KRUN_MAX_WAIT: true,
    KRUN_SHUTDOWN_DELAY: true,
    KRUN_RATE_LIMIT_RPS: true,
    KRUN_RATE_LIMIT_BURST: true,
  })
  .extend({ OTEL_SERVICE_NAME: field(z.string().default("krun-scheduler")) })
  .superRefine((config, ctx) => {
    validateDatabase(config, ctx);
    if (config.KRUN_WEBHOOK_ALLOWED_HOSTS.length > 0 && config.KRUN_WEBHOOK_SECRET.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["KRUN_WEBHOOK_SECRET"],
        message: "required for webhook delivery",
      });
    }
  })
  .transform((config) => ({
    ...config,
    KRUN_GATEWAY_INTERNAL_URL:
      config.KRUN_GATEWAY_INTERNAL_URL ??
      `http://krun-gateway-internal.${config.KRUN_NAMESPACE}.svc:8081`,
  }));

export type GatewayConfig = z.output<typeof GatewayEnv>;
export type SchedulerConfig = z.output<typeof SchedulerEnv>;

const DatabaseEnv = all
  .pick({ KRUN_DB_MODE: true, KRUN_DB_DSN: true, KRUN_DB_PATH: true })
  .superRefine(validateDatabase);

const FunctionCeilingsEnv = all.pick({
  KRUN_MAX_QUEUED: true,
  KRUN_MAX_ACTIVE_DEADLINE: true,
  KRUN_ALLOWED_SERVICE_ACCOUNTS: true,
  KRUN_ALLOWED_REGISTRIES: true,
  KRUN_WEBHOOK_ALLOWED_HOSTS: true,
});

const parse = <S extends z.ZodType>(
  schema: S,
  env: Environment,
): Effect.Effect<z.output<S>, ConfigInvalid> =>
  Effect.suspend(() => {
    const result = schema.safeParse(env);
    if (result.success) return Effect.succeed(result.data);
    const variable = result.error.issues[0]?.path[0];
    // Every issue is field-local, including explicit cross-field refinements.
    return Effect.fail(new ConfigInvalid({ variable: String(variable) }));
  });

export const parseDatabaseConfig = (env: Environment) => parse(DatabaseEnv, env);
export const parseGatewayConfig = (env: Environment) => parse(GatewayEnv, env);
export const parseSchedulerConfig = (env: Environment) => parse(SchedulerEnv, env);
export const parseFunctionCeilings = (env: Environment) => parse(FunctionCeilingsEnv, env);

type ConfigValue =
  | { readonly role: "gateway"; readonly config: GatewayConfig }
  | { readonly role: "scheduler"; readonly config: SchedulerConfig };

export class KrunConfig extends Context.Service<KrunConfig, ConfigValue>()("krun/KrunConfig") {}

interface ConfigSources {
  readonly env?: Environment;
  readonly readNamespace?: Effect.Effect<string, unknown>;
}

const namespaceFile = Effect.tryPromise({
  try: () => readFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8"),
  catch: () => new ConfigInvalid({ variable: "KRUN_NAMESPACE" }),
});

// Acquisition, not import, snapshots env and performs the optional namespace I/O.
// Explicit sources make tests independent of the host environment/credential mount.
export const ConfigLive = (role: ConfigValue["role"], sources: ConfigSources = {}) =>
  Layer.effect(
    KrunConfig,
    Effect.gen(function* () {
      const env = yield* Effect.sync(() => ({ ...(sources.env ?? process.env) }));
      if (env.KRUN_NAMESPACE === undefined || env.KRUN_NAMESPACE === "") {
        const namespace = (yield* (sources.readNamespace ?? namespaceFile).pipe(
          Effect.mapError(() => new ConfigInvalid({ variable: "KRUN_NAMESPACE" })),
        )).trim();
        if (namespace === "")
          return yield* Effect.fail(new ConfigInvalid({ variable: "KRUN_NAMESPACE" }));
        env.KRUN_NAMESPACE = namespace;
      }
      if (role === "gateway") return { role, config: yield* parseGatewayConfig(env) };
      return { role, config: yield* parseSchedulerConfig(env) };
    }),
  );
