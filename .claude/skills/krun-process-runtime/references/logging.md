# Logging (SPEC.md:1181-1191, 1103-1105)

Line numbers from the working tree 2026-10-23; re-check before quoting.

## pino setup

- JSON via pino, one line per event (SPEC.md:1181). Build the root pino
  with `{ level, redact }` once per process (`pino({ level, redact })`) in the Logger layer
  (`packages/shared/src/runtime`, PLAN.md:111). Pass it as
  `loggerInstance` to every Fastify instance (public, internal, admin,
  scheduler admin). Derive module loggers with `.child({ module })`. A
  second pino instance would miss the redact list.
- Effect `Logger` replaced by one writing to that pino instance
  (docs/STACK.md 2.5): `Effect.logInfo` produces the same JSON line,
  through the same redaction, as `request.log.info`. Code below.
- Level from `KRUN_LOG_LEVEL`, default `info` (SPEC.md:1182, SPEC.md:1250).
  Set it twice from the one config value: as the pino `level`, and as
  `References.MinimumLogLevel` (`Layer.succeed(References.MinimumLogLevel,
  "Debug")`). Effect's own minimum defaults to `Info`: without this an
  Effect `logDebug` is dropped before pino (probe).
- Fields where relevant: `run_id`, `function`, `state`, `reason`, `reqId`
  (SPEC.md:1181-1182), and `traceId` plus `spanId` on every line inside a
  span (SPEC.md:1152-1153). Use exactly these names (snake_case `run_id`,
  camelCase `reqId`, `traceId`, `spanId`). Dashboards, docs/OPERATIONS.md
  ("find it by the `traceId` field") and the audit test grep them.
- `reqId` is on every request-scoped line (SPEC.md:277). Fastify binds it
  on `request.log` (a pino child). The handler runner provides
  `request.log` as `CurrentPino` (below), so `Effect.log*` lines in a
  request carry `reqId` too. Never log with `app.log` inside a request.
- `X-Request-Id` (SPEC.md:276-277): Fastify 5.12.7's `requestIdHeader`
  defaults to `false`. With a header name set, the header value is used
  unchecked and `genReqId` is skipped (`lib/req-id-gen-factory.js`
  `buildOptionalHeaderReqId`: `req.headers[h] || genReqId(req)`,
  VERIFIED). So keep `requestIdHeader: false` and read `x-request-id`
  inside `genReqId`. Accept it when 1 to 128 characters. Otherwise return
  `v7({ msecs })` from `uuid`, `msecs` from
  `Effect.runSyncWith(ctx)(Clock.currentTimeMillis)` (`genReqId` is
  synchronous; docs/STACK.md 2.5 uuid row). The id is on `request.log`
  from the first line. An `onSend` hook sets the response header.
- `trustProxy: true` so `client_ip` is the forwarded address
  (SPEC.md:1189; Fastify 5 accepts `true`, CIDR strings or a function).
- Fastify's default request logging prints `req`/`res` summaries at info.
  Turn it off on every listener and write the audit line in
  `onResponse`, or every request logs twice. In Fastify 5.12.7 the
  top-level `disableRequestLogging` still works but emits FSTDEP023
  ("will be removed in `fastify@6`"). Use `logController: new
  LogController({ disableRequestLogging: true })`, `LogController`
  imported from `fastify` (probe, `docs/Reference/Server.md`
  "logController").
- Probe hits on the admin listener (`/healthz` every 10 s, `/readyz` every
  5 s, SPEC.md:1376-1379) must not log at info: debug or not at all.

## Effect Logger on pino (verified: effect 4.0.6, pino 10.4.0, Fastify 5.12.7)

Lives in the Logger layer of `packages/shared/src/runtime` (PLAN.md:111).
Probe `log.test.mjs` passed with this shape:

```ts
import { Context, Layer, Logger, Option, References, Tracer } from "effect"
import type { Logger as Pino } from "pino"

// Which pino logger the current fiber writes to; defaults to the process root.
export const CurrentPino = Context.Reference<Pino>("krun/CurrentPino", {
  defaultValue: () => rootPino,   // set when the Logger layer is built
})

const method = { Fatal: "fatal", Error: "error", Warn: "warn",
                 Info: "info", Debug: "debug", Trace: "trace" } as const

export const PinoLogger = Logger.make(({ logLevel, message, fiber }) => {
  const m = method[logLevel as keyof typeof method]
  if (m === undefined) return                       // "All" / "None"
  const parts = Array.isArray(message) ? message : [message]
  const fields = Object.assign({}, fiber.getRef(References.CurrentLogAnnotations),
    ...parts.filter((p) => typeof p === "object" && p !== null))
  const span = Context.getOption(fiber.context, Tracer.ParentSpan)   // UNVERIFIED, see below
  if (Option.isSome(span)) Object.assign(fields, { traceId: span.value.traceId, spanId: span.value.spanId })
  fiber.getRef(CurrentPino)[m](fields, parts.filter((p) => typeof p === "string").join(" "))
})

export const LoggerLive = Layer.mergeAll(
  Logger.layer([PinoLogger]),                                    // replaces the default set
  Layer.succeed(References.MinimumLogLevel, toEffectLevel(config.logLevel)),
)
```

- `toEffectLevel` maps `KRUN_LOG_LEVEL` pino names to Effect `LogLevel`
  (`effect` `LogLevel.ts` lists `All Fatal Error Warn Info Debug
  Trace None`):

  | pino | `fatal` | `error` | `warn` | `info` | `debug` | `trace` | `silent` |
  |---|---|---|---|---|---|---|---|
  | Effect | `"Fatal"` | `"Error"` | `"Warn"` | `"Info"` | `"Debug"` | `"Trace"` | `"None"` |

- `Logger.layer(loggers)` overwrites the logger set unless
  `{ mergeWithExisting: true }` is passed (`Logger.ts` `layer`). The
  default console logger is gone, so no line prints twice. Effect 3's
  `Logger.replace(Logger.defaultLogger, ...)` is not the Effect 4 API.
- `Logger.Options` carries `message`, `logLevel`, `cause`, `fiber` and
  `date`. Do not log `date`: pino stamps its own `time`. Pass `cause` to
  pino's `err` only after checking it carries no value (a Zod issue's
  `input`, a DSN in a pg error message).
- `Effect.annotateLogs({ run_id, function })` becomes fields on the line
  (probe asserted `run_id`). Use the SPEC field names exactly.
- Trace ids (SPEC.md:1152-1153): the two span lines above are not covered
  by the probe and are UNVERIFIED. Source (`effect` 4.0.6): `Fiber`
  exposes `context`; `Tracer.ParentSpan` is the context service
  `Effect.withSpan` sets (an Effect span or the external parent from
  `traceparent`); every span has `traceId` and `spanId` even with no
  OpenTelemetry tracer. Probe it before P3.1b relies on it. Check Effect's
  `MIGRATION.md` if `Context.getOption` has another name. Lines outside
  any span (startup, shutdown steps outside a span) carry neither field;
  that is correct.
- Never bind `traceId`/`spanId` into a pino child as well: pino serialises
  child bindings and line fields side by side, so the key appears twice in
  one JSON line. The Effect logger adds them per line; the audit hook adds
  them from the request span.
- Request scope: the handler runner wraps the handler Effect with
  `Effect.provideService(CurrentPino, request.log)`, so the `reqId`
  binding appears on every `Effect.log*` line in the request (probe
  asserted `reqId: "abc"`).
- Redaction holds because every line ends in the same pino instance or a
  child. pino children inherit the parent's redact configuration unless
  given their own `redact` (pino `lib/proto.js` `child`). Probe: `input`
  logged through `Effect.logInfo` came out as `"[Redacted]"`.
- Fastify wraps the `loggerInstance` in `prevLogger.child({}, opts)`
  (`lib/logger-pino.js` `createPinoLogger`), which keeps the redact list
  (probe: request-scoped and root lines both redacted, `reqId` present).

## Redact list (SPEC.md:1183-1185, verbatim)

pino `redact` in both processes on every listener covers:

```
req.headers.authorization
input
result
runtimeStatus
error.details
dsn
```

Use the paths as given. fast-redact paths are positional: also redact the
same keys one level down for shapes krun logs (`run.input`, `run.result`,
`run.runtimeStatus`, `run.error.details`, `config.dsn`). Better: never
log whole run or config objects. Never set `censor` to something that
reveals length.

P3.1b acceptance: "a redacted field never appears in a log line"
(PLAN.md:388). Test with `@effect/vitest` `it.effect` against a pino
destination stream (a `node:stream` `Writable` collecting chunks). Log an
object holding each path with a sentinel value three ways: root pino,
`request.log` (Fastify `inject` with an `Authorization: Bearer <sentinel>`
header), and `Effect.logInfo` with `LoggerLive` provided. Assert the
sentinel is absent from the output. pino `redact` does not reach spans:
run the same request with an in-memory span exporter and assert the
sentinel is in no span attribute, event or status (`telemetry.md`
"Redaction for spans").

## Never-log list

Never logged at any level (SPEC.md:1185-1186, 1103-1105, 992, 1159):

- request and response bodies (public and internal listeners);
- Job manifests (they embed the Secret name and the env list);
- env lists / container env (presigned URLs live there);
- input, results, per-run tokens, API keys, `keys.yaml` contents;
- `KRUN_DB_DSN`, `KRUN_WEBHOOK_SECRET`, `KRUN_S3_SECRET_KEY`,
  `KRUN_S3_ACCESS_KEY`. Never log the parsed config object; the exit-1
  message names the variable, never the value;
- the `Authorization` header on either listener (SPEC.md:992 "The token
  is never logged").

Log the name, not the value: key name, Function name, Secret name, run
id, variable name, HTTP status. Dapr does the same for `secretKeyRef`
(`dapr pkg/runtime/processor/secret/secret.go:134-186`).

## Audit line (SPEC.md:1188-1191)

One line per `/v1` request (public listener only), at `info`; `warn` for
401 and 403.

| Field | Value | Notes |
|---|---|---|
| `key` | key name, or `null` | never the key itself (SPEC.md:1191); P3.1b asserts `key: null` on the 401 line (PLAN.md:387) |
| `client_ip` | `request.ip` with `trustProxy: true` | SPEC.md:1189 |
| `user_agent` | `User-Agent` header | |
| `route` | `request.routeOptions.url`, `unmatched` on 404 | same rule as the `route` metric label (SPEC.md:1163) |
| `code` | response status | |
| `run_id` | when present | create, get, cancel, wait, watch, result |
| `function` | when present | |
| `idempotency_key` | when present | the `requestId` of `CreateRun` (SPEC.md:228-233) |
| `reqId` | always | request-scoped (SPEC.md:277) |
| `traceId`, `spanId` | when the request span exists | from the request span the runner keeps on the request (`telemetry.md` "Spans"), not a pino child binding (SPEC.md:1152-1153) |

Emit from one `onResponse` hook on the public listener, so every route,
including 404 and 415 before a handler runs, produces one line. The
internal listener logs each request's `User-Agent` (SPEC.md:308) but has
no `key`; it is not the `/v1` audit line.

## Levels for other events

- `debug`: stale CAS (zero rows), ignored informer events, probe hits,
  unhealthy readiness target names.
- `info`: process start with the resolved non-secret config summary (mode,
  addresses, namespace), readiness flips, leader acquired/lost, each run
  transition (`run_id function state reason`), shutdown steps.
- `warn`: 401/403 audit lines, transient Kubernetes errors with backoff,
  delivery attempt failures, Lease 409 retries.
- `error`: permanent failures (`job_create_failed`), informer watch errors
  before restart, startup validation failure naming the variable (then
  exit 1), `LeaderLost` (then exit 1). `runMain` runs with
  `disableErrorReporting: true`, so this one line is the only report
  (`references/shutdown.md`).
- `fatal`: the shutdown grace watchdog fired (then exit 1).
