import { expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import {
  ConfigInvalid,
  type GatewayConfig,
  GatewayEnv,
  parseFunctionCeilings,
  parseGatewayConfig,
  parseSchedulerConfig,
  type SchedulerConfig,
  SchedulerEnv,
} from "./index.js";

const base = { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "config-tests" };
const sharedDefaults = {
  KRUN_DB_MODE: "embedded",
  KRUN_DB_DSN: undefined,
  KRUN_DB_PATH: "/data/krun.db",
  KRUN_ADMIN_LISTEN_ADDR: ":9090",
  KRUN_NAMESPACE: "config-tests",
  KRUN_MAX_QUEUED: 1000,
  KRUN_MAX_RESULT_BYTES: 262144,
  KRUN_MAX_ACTIVE_DEADLINE: 86400,
  KRUN_ALLOWED_SERVICE_ACCOUNTS: ["krun-job-default"],
  KRUN_ALLOWED_REGISTRIES: [],
  KRUN_S3_ENDPOINT: undefined,
  KRUN_S3_BUCKET: undefined,
  KRUN_S3_REGION: undefined,
  KRUN_S3_ACCESS_KEY: undefined,
  KRUN_S3_SECRET_KEY: undefined,
  KRUN_WEBHOOK_ALLOWED_HOSTS: [],
  KRUN_WEBHOOK_ALLOWED_CIDRS: [],
  KRUN_LOG_LEVEL: "info",
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
  OTEL_TRACES_SAMPLER_ARG: "0.1",
};

const invalid = (effect: Effect.Effect<unknown, ConfigInvalid>, variable: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    expect(error).toBeInstanceOf(ConfigInvalid);
    expect(error.variable).toBe(variable);
    expect(error.message).toBe(`Invalid configuration: ${variable}`);
    expect(Object.keys(error).sort()).toEqual(["_tag", "variable"]);
  });

it.effect("parses every gateway default with an explicit embedded namespace", () =>
  Effect.gen(function* () {
    const config: GatewayConfig = yield* parseGatewayConfig(base);
    expect(config).toEqual({
      ...sharedDefaults,
      KRUN_API_KEYS_PATH: "/etc/krun/keys.yaml",
      KRUN_LISTEN_ADDR: ":8080",
      KRUN_INTERNAL_LISTEN_ADDR: ":8081",
      KRUN_MAX_INPUT_BYTES: 262144,
      KRUN_MAX_WAIT: Duration.seconds(60),
      KRUN_SHUTDOWN_DELAY: Duration.seconds(5),
      KRUN_RATE_LIMIT_RPS: 10,
      KRUN_RATE_LIMIT_BURST: 50,
      OTEL_SERVICE_NAME: "krun-gateway",
    });
    expect(Duration.isDuration(config.KRUN_MAX_WAIT)).toBe(true);
    expect(Duration.toMillis(config.KRUN_SHUTDOWN_DELAY)).toBe(
      Duration.toMillis(Duration.seconds(5)),
    );
  }),
);

it.effect("parses every scheduler default and derives its gateway URL", () =>
  Effect.gen(function* () {
    const config: SchedulerConfig = yield* parseSchedulerConfig(base);
    expect(config).toEqual({
      ...sharedDefaults,
      KRUN_GATEWAY_INTERNAL_URL: "http://krun-gateway-internal.config-tests.svc:8081",
      KRUN_JOBS_NAMESPACE: "krun-jobs",
      KRUN_MAX_RUNNING: 100,
      KRUN_K8S_CONCURRENCY: 8,
      KRUN_JOB_HOST_USERS: true,
      KRUN_TTL_AFTER_FINISHED: 86400,
      KRUN_RETENTION: Duration.hours(720),
      KRUN_S3_PRESIGN_TTL: undefined,
      KRUN_WEBHOOK_SECRET: [],
      OTEL_SERVICE_NAME: "krun-scheduler",
    });
  }),
);

for (const [name, parse, schema] of [
  ["gateway", parseGatewayConfig, GatewayEnv],
  ["scheduler", parseSchedulerConfig, SchedulerEnv],
] as const) {
  it.effect(`${name} treats all empty fields as omitted before defaults`, () =>
    Effect.gen(function* () {
      const empty = Object.fromEntries(Object.keys(yield* parse(base)).map((key) => [key, ""]));
      expect(schema.safeParse(base).success).toBe(true);
      expect(yield* parse({ ...empty, ...base })).toEqual(yield* parse(base));
    }),
  );
  it.effect(`${name} rejects an entirely empty config without inventing a namespace`, () =>
    invalid(parse({}), "KRUN_NAMESPACE"),
  );
  it.effect(`${name} requires a DSN in default postgres mode`, () =>
    invalid(parse({ KRUN_NAMESPACE: "config-tests", KRUN_DB_DSN: "" }), "KRUN_DB_DSN"),
  );
  it.effect(`${name} accepts postgres when a nonempty DSN is supplied`, () =>
    Effect.gen(function* () {
      const config = yield* parse({
        KRUN_NAMESPACE: "config-tests",
        KRUN_DB_DSN: "test-only-value",
      });
      expect(config.KRUN_DB_MODE).toBe("postgres");
    }),
  );
  it.effect(`${name} parses IPv4 and IPv6 CIDRs without reparsing later`, () =>
    Effect.gen(function* () {
      const config = yield* parse({
        ...base,
        KRUN_WEBHOOK_ALLOWED_CIDRS: " 192.0.2.0/24, 2001:db8::/32 ",
      });
      expect(
        config.KRUN_WEBHOOK_ALLOWED_CIDRS.map(([address, prefix]) => [address.kind(), prefix]),
      ).toEqual([
        ["ipv4", 24],
        ["ipv6", 32],
      ]);
    }),
  );
  for (const value of [
    "not-a-cidr",
    "192.0.2.0/33",
    "2001:db8::/129",
    "192.0.2.0/24,",
    ",2001:db8::/32",
  ]) {
    it.effect(`${name} rejects malformed CIDR list ${value}`, () =>
      invalid(parse({ ...base, KRUN_WEBHOOK_ALLOWED_CIDRS: value }), "KRUN_WEBHOOK_ALLOWED_CIDRS"),
    );
  }
  it.effect(`${name} accepts the exact result size ceiling`, () =>
    Effect.gen(function* () {
      expect(
        (yield* parse({ ...base, KRUN_MAX_RESULT_BYTES: "1048576" })).KRUN_MAX_RESULT_BYTES,
      ).toBe(1048576);
    }),
  );
  it.effect(`${name} rejects a result size above 1 MiB`, () =>
    invalid(parse({ ...base, KRUN_MAX_RESULT_BYTES: "1048577" }), "KRUN_MAX_RESULT_BYTES"),
  );
  for (const value of [
    "-1",
    "1.5",
    "1e3",
    " 12",
    "12 ",
    "Infinity",
    "NaN",
    "9007199254740992",
    "9".repeat(400),
  ]) {
    it.effect(
      `${name} rejects nonrepresentable or non-digit integers (${value.length} chars)`,
      () => invalid(parse({ ...base, KRUN_MAX_QUEUED: value }), "KRUN_MAX_QUEUED"),
    );
  }
  it.effect(
    `${name} accepts zero and the maximum safe integer without new operational minima`,
    () =>
      Effect.gen(function* () {
        expect((yield* parse({ ...base, KRUN_MAX_QUEUED: "0" })).KRUN_MAX_QUEUED).toBe(0);
        expect(
          (yield* parse({ ...base, KRUN_MAX_QUEUED: String(Number.MAX_SAFE_INTEGER) }))
            .KRUN_MAX_QUEUED,
        ).toBe(Number.MAX_SAFE_INTEGER);
      }),
  );
  it.effect(`${name} ignores unrelated environment and preserves raw OTEL strings`, () =>
    Effect.gen(function* () {
      const config = yield* parse({
        ...base,
        PATH: "/test",
        OTEL_TRACES_SAMPLER: "external-sampler",
        OTEL_TRACES_SAMPLER_ARG: "not-a-ratio",
        OTEL_SERVICE_NAME: "service-override",
      });
      expect(config.OTEL_TRACES_SAMPLER_ARG).toBe("not-a-ratio");
      expect(config.OTEL_TRACES_SAMPLER).toBe("external-sampler");
      expect(config.OTEL_SERVICE_NAME).toBe("service-override");
      expect(config).not.toHaveProperty("PATH");
    }),
  );
}

it.effect("gateway allows webhook hosts without scheduler signing secrets", () =>
  Effect.gen(function* () {
    const config = yield* parseGatewayConfig({
      ...base,
      KRUN_WEBHOOK_ALLOWED_HOSTS: "a.example, b.example",
      KRUN_WEBHOOK_SECRET: "",
    });
    expect(config.KRUN_WEBHOOK_ALLOWED_HOSTS).toEqual(["a.example", "b.example"]);
    expect(config).not.toHaveProperty("KRUN_WEBHOOK_SECRET");
  }),
);
it.effect("scheduler requires a signing secret for enabled webhook hosts", () =>
  invalid(
    parseSchedulerConfig({
      ...base,
      KRUN_WEBHOOK_ALLOWED_HOSTS: "a.example",
      KRUN_WEBHOOK_SECRET: "",
    }),
    "KRUN_WEBHOOK_SECRET",
  ),
);
it.effect("scheduler parses multiple signing secrets and exact false", () =>
  Effect.gen(function* () {
    const config = yield* parseSchedulerConfig({
      ...base,
      KRUN_WEBHOOK_ALLOWED_HOSTS: "a.example",
      KRUN_WEBHOOK_SECRET: "test-a, test-b",
      KRUN_JOB_HOST_USERS: "false",
      KRUN_GATEWAY_INTERNAL_URL: "http://override:1234",
    });
    expect(config.KRUN_WEBHOOK_SECRET).toHaveLength(2);
    expect(config.KRUN_JOB_HOST_USERS).toBe(false);
    expect(config.KRUN_GATEWAY_INTERNAL_URL).toBe("http://override:1234");
  }),
);
it.effect("rejects truthy boolean coercions", () =>
  invalid(parseSchedulerConfig({ ...base, KRUN_JOB_HOST_USERS: "1" }), "KRUN_JOB_HOST_USERS"),
);
it.effect(
  "gateway ignores scheduler-only validation and scheduler ignores gateway-only validation",
  () =>
    Effect.gen(function* () {
      yield* parseGatewayConfig({
        ...base,
        KRUN_RETENTION: "bad",
        KRUN_JOB_HOST_USERS: "bad",
        KRUN_S3_PRESIGN_TTL: "bad",
      });
      yield* parseSchedulerConfig({
        ...base,
        KRUN_MAX_WAIT: "bad",
        KRUN_MAX_INPUT_BYTES: "99999999",
        KRUN_SHUTDOWN_DELAY: "bad",
      });
    }),
);
it.effect("input size accepts exactly 1 MiB and rejects the next byte", () =>
  Effect.gen(function* () {
    expect(
      (yield* parseGatewayConfig({ ...base, KRUN_MAX_INPUT_BYTES: "1048576" }))
        .KRUN_MAX_INPUT_BYTES,
    ).toBe(1048576);
    yield* invalid(
      parseGatewayConfig({ ...base, KRUN_MAX_INPUT_BYTES: "1048577" }),
      "KRUN_MAX_INPUT_BYTES",
    );
  }),
);
for (const [variable, parse] of [
  ["KRUN_MAX_WAIT", parseGatewayConfig],
  ["KRUN_SHUTDOWN_DELAY", parseGatewayConfig],
  ["KRUN_RETENTION", parseSchedulerConfig],
  ["KRUN_S3_PRESIGN_TTL", parseSchedulerConfig],
] as const) {
  for (const value of [
    "1d",
    "1.5s",
    " 1s",
    "-1s",
    "Infinitys",
    `${"9".repeat(400)}h`,
    "9007199254740992ms",
  ]) {
    it.effect(`${variable} rejects invalid or unsafe durations (${value.length} chars)`, () =>
      invalid(parse({ ...base, [variable]: value }), variable),
    );
  }
}
it.effect("converts every supported duration unit to a real Effect Duration", () =>
  Effect.gen(function* () {
    for (const [value, expected] of [
      ["0ms", Duration.zero],
      ["15ms", Duration.millis(15)],
      ["2s", Duration.seconds(2)],
      ["3m", Duration.minutes(3)],
      ["4h", Duration.hours(4)],
    ] as const) {
      const config = yield* parseGatewayConfig({ ...base, KRUN_MAX_WAIT: value });
      expect(Duration.isDuration(config.KRUN_MAX_WAIT)).toBe(true);
      expect(Duration.toMillis(config.KRUN_MAX_WAIT)).toBe(Duration.toMillis(expected));
    }
  }),
);
it.effect("empty presign TTL remains unset for the individual Function deadline", () =>
  Effect.gen(function* () {
    expect(
      (yield* parseSchedulerConfig({ ...base, KRUN_S3_PRESIGN_TTL: "" })).KRUN_S3_PRESIGN_TTL,
    ).toBeUndefined();
  }),
);
it.effect("reports only the first Zod issue in field order without input values", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseGatewayConfig({
        ...base,
        KRUN_DB_DSN: "diagnostic-sentinel",
        KRUN_MAX_INPUT_BYTES: "bad",
        KRUN_MAX_WAIT: "bad",
      }),
    );
    expect(error.variable).toBe("KRUN_MAX_INPUT_BYTES");
    expect(String(error)).not.toContain("diagnostic-sentinel");
    expect(JSON.stringify(error)).not.toContain("diagnostic-sentinel");
  }),
);
it.effect("five Function ceilings parse without DB, namespace or scheduler settings", () =>
  Effect.gen(function* () {
    const ceilings = yield* parseFunctionCeilings({
      KRUN_DB_MODE: "bad",
      KRUN_NAMESPACE: "",
      KRUN_JOB_HOST_USERS: "bad",
    });
    expect(ceilings).toEqual({
      KRUN_MAX_ACTIVE_DEADLINE: 86400,
      KRUN_MAX_QUEUED: 1000,
      KRUN_ALLOWED_REGISTRIES: [],
      KRUN_ALLOWED_SERVICE_ACCOUNTS: ["krun-job-default"],
      KRUN_WEBHOOK_ALLOWED_HOSTS: [],
    });
    for (const parse of [parseGatewayConfig, parseSchedulerConfig]) {
      const config = yield* parse(base);
      expect(
        Object.fromEntries(Object.keys(ceilings).map((key) => [key, Reflect.get(config, key)])),
      ).toEqual(ceilings);
    }
    const overrides = {
      KRUN_MAX_ACTIVE_DEADLINE: "23",
      KRUN_MAX_QUEUED: "42",
      KRUN_ALLOWED_REGISTRIES: "registry.example, other.example",
      KRUN_ALLOWED_SERVICE_ACCOUNTS: "one, two",
      KRUN_WEBHOOK_ALLOWED_HOSTS: "hooks.example",
    };
    const changed = yield* parseFunctionCeilings(overrides);
    for (const parse of [parseGatewayConfig, parseSchedulerConfig]) {
      const config = yield* parse({ ...base, ...overrides, KRUN_WEBHOOK_SECRET: "test-only" });
      expect(
        Object.fromEntries(Object.keys(changed).map((key) => [key, Reflect.get(config, key)])),
      ).toEqual(changed);
    }
    yield* invalid(parseFunctionCeilings({ KRUN_MAX_QUEUED: "bad" }), "KRUN_MAX_QUEUED");
  }),
);
