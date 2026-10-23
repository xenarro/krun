# Environment variables (SPEC.md section 12)

Table verbatim from SPEC.md:1218-1254 (working tree 2026-10-23) plus
`process` and `kind` columns. SPEC.md is edited concurrently: re-check
line numbers before quoting.

## Validation rules (SPEC.md:1210-1216)

- No flags except `--help` (SPEC.md:1210).
- Each process validates its own variables at startup and exits 1 naming
  the first bad one (SPEC.md:1211-1212). Checks:
  1. `KRUN_DB_DSN` empty while `KRUN_DB_MODE=postgres` (SPEC.md:1212).
  2. Scheduler with `KRUN_WEBHOOK_ALLOWED_HOSTS` set and
     `KRUN_WEBHOOK_SECRET` empty (SPEC.md:1212-1213). The gateway does
     not need the secret.
  3. `KRUN_MAX_INPUT_BYTES` or `KRUN_MAX_RESULT_BYTES` above `1048576`
     (SPEC.md:1214).
  4. A duration not matching `^\d+(ms|s|m|h)$` (SPEC.md:1214-1215; same
     grammar as Function fields, SPEC.md:117-118).
  5. A CIDR that does not parse (SPEC.md:1215).
- Empty value is unset: the default applies, no validation runs
  (SPEC.md:1215-1216).
- P0.5 acceptance (PLAN.md:187-190): defaults, one invalid duration, one
  invalid CIDR, DSN empty in postgres mode, webhook hosts without secret,
  a size above 1 MiB, and `KRUN_S3_PRESIGN_TTL=""` yielding the default
  (PLAN.md:189-190).

## Service shape

- Zod schemas `GatewayEnv` and `SchedulerEnv` over a plain
  `Record<string, string | undefined>`. A `parseConfig(env)` Effect fails
  with a `ConfigInvalid` `Data.TaggedError` carrying the variable name.
  Tests pass objects, never `process.env`.
- The service layer (`Layer.effect`) reads `process.env` once and runs
  `parseConfig`. Its failure fails `Layer.launch`: one error line naming
  the variable, then the teardown exits 1 (probe). Name the service
  `KrunConfig` or similar, distinct from Effect's `Config` module.
- One `z.preprocess` wrapper turns `''` into `undefined` for every field.
  Trim nothing else: a stray space in a duration is a validation error.
- Durations: `z.string().regex(/^\d+(ms|s|m|h)$/)` transformed into an
  Effect `Duration` (docs/STACK.md 4.3). Integers are plain digits
  (`KRUN_MAX_ACTIVE_DEADLINE=86400` is seconds, not a duration). Never
  `z.coerce.number()`: it accepts `1e3`, ` 12` and `""`.
- CIDRs: split on `,`, trim, parse each with `ipaddr.js` (`parseCIDR`,
  PLAN.md:74) in a transform that adds an issue on failure. Keep the
  parsed tuples so the webhook check does not re-parse
  (`krun-webhooks-objstore`).
- Acceptance: one Vitest test per rule. Plain `it` for pure parsing;
  `it.effect` for `parseConfig` and its tagged failure.

## Kinds and Zod schemas

| kind | Meaning | Zod 4 schema |
|---|---|---|
| `enum` | fixed values | `z.enum` |
| `string` | free text | `z.string()` |
| `path` | file path | `z.string()` |
| `addr` | `host:port`, empty host = all interfaces | `z.string()` |
| `url` | URL | `z.string()` |
| `int` | non-negative integer, plain digits | digits regex then `Number`; `.max(1048576)` on the two byte limits |
| `dur` | duration grammar (rule 4 above) | duration regex refined into an Effect `Duration` (same refinement as the Function schema) |
| `csv` | comma-separated strings | split on `,` |
| `cidrs` | comma-separated CIDRs | transform through `ipaddr.js` `parseCIDR` |
| `level` | pino level name | `z.enum` of pino level names |
| `bool` | `true` or `false`, nothing else | `z.enum(["true", "false"])` then a boolean |
| `ratio` | decimal number | see the sampler note below |

Each kind is one small schema in `packages/shared/src/config`, wrapped by
the same empty-is-unset preprocess and composed into `GatewayEnv` and
`SchedulerEnv` (PLAN.md:183-190). The result is the value of the `Config`
service; nothing else reads `process.env`.

Verified against zod 4.6.7 and effect 4.0.6 (probe `mod.test.mjs` in
`~/.hermes/cache/scratch/krun-skills/probe-runtime/`):

```ts
const DURATION = /^(\d+)(ms|s|m|h)$/
const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const
const unset = (v: unknown) => (v === "" ? undefined : v)

const duration = z.string().regex(DURATION).transform((s) => {
  const [, n, u] = DURATION.exec(s)!
  return Duration.millis(Number(n) * unitMs[u as keyof typeof unitMs])
})
const int = z.string().regex(/^\d+$/).transform(Number)

export const GatewayEnv = z.object({
  KRUN_DB_MODE: z.preprocess(unset, z.enum(["postgres", "embedded"]).default("postgres")),
  KRUN_DB_DSN: z.preprocess(unset, z.string().optional()),
  KRUN_MAX_INPUT_BYTES: z.preprocess(unset, int.pipe(z.number().max(1048576)).prefault("262144")),
  KRUN_SHUTDOWN_DELAY: z.preprocess(unset, duration.prefault("5s")),
  KRUN_S3_PRESIGN_TTL: z.preprocess(unset, duration.optional()),
  // ... every gateway row of the table below, in table order
}).superRefine((c, ctx) => {
  if (c.KRUN_DB_MODE === "postgres" && c.KRUN_DB_DSN === undefined)
    ctx.addIssue({ code: "custom", path: ["KRUN_DB_DSN"], message: "required in postgres mode" })
})
```

- Defaults on a transformed schema: `.prefault("5s")` (raw input runs
  through regex and transform) or `.default(() => Duration.seconds(5))`.
  Never `.default(Duration.seconds(5))` with a value: Zod 4.6.7
  `shallowClone`s an object default, so the result is a plain object, not
  a `Duration` (probe: `Duration.isDuration` was `false`,
  `Duration.toMillis` gave 0). `.prefault` with the SPEC string keeps
  table and schema visibly identical.
- First bad variable = `String(result.error.issues[0].path[0])`. Field
  issues come in schema key order: declare keys in SPEC table order. The
  `superRefine` still runs when a field failed (probe:
  `KRUN_SHUTDOWN_DELAY=x` with no DSN gave
  `[KRUN_SHUTDOWN_DELAY, KRUN_DB_DSN]`), but its issues come after field
  issues, so `issues[0]` is a field issue whenever one exists. Its
  callback may see half-parsed values: guard each cross-field check on the
  fields it reads. SPEC does not define "first"; table order is the
  convention here.
- A Zod issue carries `input` only when parsing with `reportInput: true`
  (zod `core/util.ts`). Never set it. Never log the `ZodError`: the
  default regex message prints the pattern, not the value, but a custom
  refinement might not.

## Table (SPEC.md:1218-1254)

| Variable | Default | Used by (SPEC text) | process | kind |
|---|---|---|---|---|
| `KRUN_DB_MODE` | `postgres` | both. `postgres` or `embedded` | both | enum |
| `KRUN_DB_DSN` | | both, postgres mode | both | string |
| `KRUN_DB_PATH` | `/data/krun.db` | both, embedded mode | both | path |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway | gateway | path |
| `KRUN_LISTEN_ADDR` | `:8080` | gateway, public API | gateway | addr |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | gateway, internal API | gateway | addr |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9090` | both, probes and metrics; the chart sets `:9091` on the scheduler in embedded mode | both | addr |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | scheduler, injected into Jobs; the chart always sets it from the rendered internal Service name and port, the default serves non-chart deployments | scheduler | url |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler | scheduler | string |
| `KRUN_NAMESPACE` | pod namespace, read from the ServiceAccount `namespace` file | both: Functions and Lease | both | string |
| `KRUN_MAX_RUNNING` | `100` | scheduler | scheduler | int |
| `KRUN_MAX_QUEUED` | `1000` | both, ceiling for `maxQueued` | both | int |
| `KRUN_MAX_INPUT_BYTES` | `262144` | gateway | gateway | int (≤ 1048576) |
| `KRUN_MAX_RESULT_BYTES` | `262144` | both | both | int (≤ 1048576) |
| `KRUN_MAX_WAIT` | `60s` | gateway | gateway | dur |
| `KRUN_SHUTDOWN_DELAY` | `5s` | gateway | gateway | dur |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway | gateway | int |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway | gateway | int |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | both, Function validation | both | int (seconds) |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | both, Function validation; comma-separated | both | csv |
| `KRUN_K8S_CONCURRENCY` | `8` | scheduler | scheduler | int |
| `KRUN_JOB_HOST_USERS` | `true` | scheduler; `false` sets `hostUsers: false` on function pods (chart value `jobsNamespace.userNamespaces`) | scheduler | bool |
| `KRUN_TTL_AFTER_FINISHED` | `86400` | scheduler | scheduler | int (seconds) |
| `KRUN_RETENTION` | `720h` | scheduler | scheduler | dur |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both | both | csv |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both | both | string |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | scheduler, PUT presign; a duration. The gateway's GET presign is fixed at 300 s | scheduler | dur |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty, webhooks disabled | both | both | csv |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | both; comma-separated CIDRs that pass the address check | both | cidrs |
| `KRUN_WEBHOOK_SECRET` | | scheduler; comma-separated secrets, one signature each | scheduler | csv (secret) |
| `KRUN_LOG_LEVEL` | `info` | both | both | level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty, traces dropped | both; standard OpenTelemetry variable, OTLP/HTTP | both | string |
| `OTEL_SERVICE_NAME` | `krun-gateway` or `krun-scheduler` | both | both | string |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio`, `0.1` | both | both | string, ratio |

`KRUN_API_URL`, `KRUN_API_KEY`, `KRUN_REGISTRY` are read by the CLI on a
developer machine only (SPEC.md:1255-1257); not process config.
`krun validate` and `krun deploy` also read the five validation ceilings
of SPEC section 3 (`KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`,
`KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS`,
`KRUN_WEBHOOK_ALLOWED_HOSTS`, SPEC.md:168-174) with section 12 defaults.
Share those field schemas with the CLI; do not copy them.

## Open gaps

- Lease identity: SPEC.md:791 says `holderIdentity` is the pod name from
  the downward API (`metadata.name`). Section 12 (SPEC.md:1218-1254) has
  no variable carrying it (e.g. `KRUN_POD_NAME`) as of 2026-10-23, the
  chart's `config:` block (SPEC.md:1276-1292) names none, and P4.2
  (PLAN.md:494-495) only says "the pod name". P4.2/P4.11 need a Decisions
  row adding the variable (default `os.hostname()`, the pod name in
  Kubernetes) before the scheduler config is complete.
- Namespace outside a pod: SPEC.md:1229 gives no behaviour when
  `KRUN_NAMESPACE` is unset and the ServiceAccount file is missing. Fail
  startup naming `KRUN_NAMESPACE`; set it in tests. A `krun` default like
  the CLI's (SPEC.md:762) needs a Decisions row.
- Sampler argument: SPEC has no rule for an `OTEL_TRACES_SAMPLER_ARG`
  outside `[0, 1]` or not a number; the five startup rules do not cover
  it. Fall back to `0.1` with a warn line naming the variable, or ask for
  a Decisions row. Do not exit 1 on it.

## Notes for the parser

- `KRUN_JOB_HOST_USERS`: `z.coerce.boolean()` would turn `"false"` into
  `true`; use the `bool` schema. It reaches the Job manifest as
  `hostUsers` (`krun-scheduler-k8s`).
- The four `OTEL_*` variables are standard OpenTelemetry variables the SDK
  also reads itself (`telemetry.md`). krun parses them anyway, same
  empty-is-unset rule, because the `Telemetry` layer decides from them:
  no endpoint, no span processor; `OTEL_SERVICE_NAME` unset, the process
  default; `OTEL_TRACES_SAMPLER` unset, krun builds the SPEC default
  sampler from `OTEL_TRACES_SAMPLER_ARG` (default `0.1`), because the
  SDK's own default is `parentbased_always_on`. None of them is among the
  five startup rules (SPEC.md:1212-1215): do not exit 1 on them. A bad
  ratio is an open gap (above).
- Declare the `OTEL_*` variables in both `GatewayEnv` and `SchedulerEnv`:
  `z.object` strips undeclared keys before the `Telemetry` layer reads
  the parsed config.
- `KRUN_MAX_ACTIVE_DEADLINE` and `KRUN_TTL_AFTER_FINISHED` are integer
  seconds (`86400`), not durations. `KRUN_MAX_WAIT`, `KRUN_SHUTDOWN_DELAY`,
  `KRUN_RETENTION` and `KRUN_S3_PRESIGN_TTL` are durations. Do not accept
  `24h` for the integer ones or `3600` for the duration ones.
- `KRUN_NAMESPACE` fallback file:
  `/var/run/secrets/kubernetes.io/serviceaccount/namespace`. Outside a pod
  (P3.7 and P4.11 process tests with `test/fake-kube`) set
  `KRUN_NAMESPACE` explicitly; "Open gaps" above covers neither existing.
- Compute the `KRUN_GATEWAY_INTERNAL_URL` default after `KRUN_NAMESPACE`
  is resolved (SPEC.md:1227).
- Secrets: `KRUN_WEBHOOK_SECRET`, `KRUN_S3_SECRET_KEY`,
  `KRUN_S3_ACCESS_KEY`, `KRUN_DB_DSN`. Never log the config object. `dsn`
  is in the pino redact list (SPEC.md:1183-1185); the others must never
  be passed to a logger.
- Embedded mode: the chart gives the scheduler
  `KRUN_ADMIN_LISTEN_ADDR=:9091` because both processes share one pod
  (SPEC.md:1226).
- The chart renders section 12 tunables from `config.*` camelCase keys on
  both processes (SPEC.md:1276-1285). Unknown variables are ignored, not
  rejected. So the env schema is a plain `z.object` (unknown keys
  stripped), never `z.strictObject`: `process.env` always carries `PATH`,
  `HOME` and the other process's `KRUN_*` variables.
