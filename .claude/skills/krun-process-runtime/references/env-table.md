# Environment variables (SPEC.md section 12)

Verbatim from SPEC.md:1218-1254 (working tree 2026-10-23) with a `process`
column and a `kind` column added for the parser. Re-check the line numbers
before quoting; SPEC.md is edited concurrently.

## Validation rules (SPEC.md:1210-1216)

- Flags are not supported except `--help` (SPEC.md:1210).
- Each process validates its own variables at startup and exits 1 naming
  the first bad one (SPEC.md:1211-1212). The named checks:
  1. `KRUN_DB_DSN` empty while `KRUN_DB_MODE=postgres` (SPEC.md:1212).
  2. Scheduler with `KRUN_WEBHOOK_ALLOWED_HOSTS` set and
     `KRUN_WEBHOOK_SECRET` empty (SPEC.md:1212-1213). Gateway does not
     need the secret.
  3. `KRUN_MAX_INPUT_BYTES` or `KRUN_MAX_RESULT_BYTES` above `1048576`
     (SPEC.md:1214).
  4. A duration not matching `^\d+(ms|s|m|h)$` (SPEC.md:1214-1215; the
     same grammar as Function fields, SPEC.md:117-118).
  5. A CIDR that does not parse (SPEC.md:1215).
- An empty value is unset: the default applies and no validation runs on
  it (SPEC.md:1215-1216). P0.5 acceptance tests `KRUN_S3_PRESIGN_TTL=""`
  yielding the default (PLAN.md:189-190).
- P0.5 acceptance covers: defaults, one invalid duration, one invalid
  CIDR, DSN empty in postgres mode, webhook hosts without secret, a size
  above 1 MiB, and the empty-value case (PLAN.md:187-190).

`kind` legend: `enum`, `string`, `path`, `addr` (`host:port`, empty host =
all interfaces), `url`, `int` (non-negative integer, plain digits), `dur`
(duration grammar), `csv` (comma-separated strings), `cidrs`
(comma-separated CIDRs), `level` (pino level name), `bool` (`true` or
`false`, nothing else), `ratio` (a decimal number; see the sampler note
below).

Each kind is one small Zod 4 schema in `packages/shared/src/config`, all
wrapped by the same empty-is-unset preprocess and composed into
`GatewayEnv` and `SchedulerEnv` (PLAN.md:183-190): `enum` → `z.enum`;
`int` → digits regex then `Number`, with `.max(1048576)` on the two byte
limits; `dur` → the `^\d+(ms|s|m|h)$` regex refined into an Effect
`Duration` (the same refinement the Function schema uses); `cidrs` →
transform through `ipaddr.js` `parseCIDR`; `level` → `z.enum` of pino
level names. The result is the value of the `Config` service; nothing
else reads `process.env`.

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

- Defaults on a transformed schema: use `.prefault("5s")` (the raw input
  runs through the regex and transform) or `.default(() => Duration.seconds(5))`.
  `.default(Duration.seconds(5))` with a value is wrong: Zod 4.6.7
  `shallowClone`s an object default, so the result is a plain object, not
  a `Duration` (probe: `Duration.isDuration` was `false` and
  `Duration.toMillis` gave 0). `.prefault` with the SPEC string keeps the
  table and the schema visibly identical.
- First bad variable = `String(result.error.issues[0].path[0])`. Field
  issues come in schema key order, so declare the keys in the order of
  the SPEC table. The `superRefine` still runs when a field failed (probe:
  `KRUN_SHUTDOWN_DELAY=x` with no DSN gave
  `[KRUN_SHUTDOWN_DELAY, KRUN_DB_DSN]`), but its issues come after the
  field issues, so `issues[0]` is a field issue whenever one exists. Its
  callback may see half-parsed values: guard each cross-field check on
  the fields it reads. SPEC does not define "first"; table order is the
  convention here.
- A Zod issue carries `input` only when parsing with `reportInput: true`
  (zod `core/util.ts`); never set it, and never log the `ZodError`: the
  default issue message for a regex failure prints the pattern, not the
  value, but a custom refinement might not.

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
developer machine only (SPEC.md:1255-1257); they are not process config.
`krun validate` and `krun deploy` also read the five validation ceilings
named in SPEC section 3 (`KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`,
`KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS`,
`KRUN_WEBHOOK_ALLOWED_HOSTS`, SPEC.md:168-174) with the section 12
defaults; share those field schemas with the CLI rather than copying them.

Not in the table (open gap, see SKILL.md): the pod name the scheduler
uses as Lease `holderIdentity` (SPEC.md:791). SPEC section 12 names no
variable for it as of 2026-10-23.

## Notes for the parser

- `KRUN_JOB_HOST_USERS` is a `bool`: `z.enum(["true", "false"])`
  transformed to a boolean; `z.coerce.boolean()` would turn `"false"` into
  `true`. It reaches the Job manifest as `hostUsers` (`krun-scheduler-k8s`).
- The four `OTEL_*` variables are standard OpenTelemetry variables that the SDK
  also reads itself (`telemetry.md`). krun parses them anyway, with the same
  empty-is-unset rule, because the `Telemetry` layer decides from them:
  no endpoint, no span processor; `OTEL_SERVICE_NAME` unset, the process
  default; `OTEL_TRACES_SAMPLER` unset, krun builds the SPEC default
  sampler from `OTEL_TRACES_SAMPLER_ARG` (default `0.1`), because the
  SDK's own default is `parentbased_always_on`. None of them is among the
  five startup rules (SPEC.md:1212-1215): do not exit 1 on them. A ratio
  that is not a number in `[0, 1]` is an open gap (SKILL.md); fall back to
  `0.1` with a warn line naming the variable.
- The variables are plain process env, so `z.object` must not strip
  them before the `Telemetry` layer reads the parsed config: declare them
  in both `GatewayEnv` and `SchedulerEnv`.
- `KRUN_MAX_ACTIVE_DEADLINE` and `KRUN_TTL_AFTER_FINISHED` are integer
  seconds (`86400`), not durations; `KRUN_MAX_WAIT`, `KRUN_SHUTDOWN_DELAY`,
  `KRUN_RETENTION` and `KRUN_S3_PRESIGN_TTL` are durations. Do not accept
  `24h` for the integer ones or `3600` for the duration ones.
- `KRUN_NAMESPACE` fallback file: the ServiceAccount `namespace` file
  (`/var/run/secrets/kubernetes.io/serviceaccount/namespace`). Outside a
  pod (P3.7 and P4.11 process tests with `test/fake-kube`) set
  `KRUN_NAMESPACE` explicitly; see the open gap in SKILL.md on what to do
  when neither exists.
- `KRUN_GATEWAY_INTERNAL_URL` default is computed after `KRUN_NAMESPACE`
  is resolved (SPEC.md:1227).
- `KRUN_WEBHOOK_SECRET` and `KRUN_S3_SECRET_KEY` / `KRUN_S3_ACCESS_KEY`
  and `KRUN_DB_DSN` are secrets: never log the config object; `dsn` is in
  the pino redact list (SPEC.md:1183-1185), the others must simply never
  be passed to a logger.
- The scheduler in embedded mode gets `KRUN_ADMIN_LISTEN_ADDR=:9091` from
  the chart because both processes share one pod (SPEC.md:1226).
- The chart renders section 12 tunables from `config.*` camelCase keys on
  both processes (SPEC.md:1276-1285); unknown variables to a process are
  ignored, not rejected. So the env schema is a plain `z.object` (unknown
  keys stripped), never `z.strictObject`: `process.env` always carries
  `PATH`, `HOME` and the other process's `KRUN_*` variables.
