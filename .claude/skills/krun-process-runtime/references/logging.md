# Logging (SPEC.md:1149-1159, 1087-1089)

Line numbers from the working tree 2026-10-23; re-check before quoting.

## pino setup

- JSON via pino, one line per event (SPEC.md:1149). One pino instance per
  process, built in the Logger layer (`packages/shared/src/runtime`,
  PLAN.md:107) with `{ level, redact }` and passed as `loggerInstance` to
  every Fastify instance (public, internal, admin, scheduler admin);
  derive module loggers with `.child({ module })`. A second pino instance
  would miss the redact list.
- The Effect `Logger` is replaced by one that writes to that pino instance
  (docs/STACK.md 2.5): map the Effect log level to the pino method, the
  message to `msg`, and log annotations (`Effect.annotateLogs({ run_id,
  function })`) and spans to fields. So `Effect.logInfo` in a loop or
  handler produces the same JSON line, through the same redaction, as
  `request.log.info`. Install it with the Effect 4 logger-replacement API
  (check `MIGRATION.md`; the Effect 3 `Logger.replace(Logger.defaultLogger,
  ...)` form may not exist), and remove the default console logger so no
  line is printed twice.
- Level from `KRUN_LOG_LEVEL`, default `info` (SPEC.md:1150, SPEC.md:1217).
- Fields where relevant: `run_id`, `function`, `state`, `reason`, `reqId`
  (SPEC.md:1149-1150). Use exactly these names (snake_case `run_id`,
  camelCase `reqId`, as written); dashboards and the audit test grep them.
- `reqId` is on every request-scoped line (SPEC.md:277); Fastify adds it
  through the request logger (`request.log`), and the handler runner
  annotates the handler Effect with `reqId` so `Effect.log*` lines inside a
  request carry it too. Never log with `app.log` inside a request.
- `X-Request-Id`: accepted up to 128 characters, else replaced by a UUID;
  echoed on every response (SPEC.md:276-277). Fastify's `requestIdHeader`
  defaults to `false` in Fastify 5, and when a header name is set
  `genReqId` is skipped whenever the header is present. Keep
  `requestIdHeader: false` and read `x-request-id` inside `genReqId`:
  accept it when 1 to 128 characters, else return `v7()` from `uuid`
  (synchronous, outside Effect, so no `Clock` there); the id is then right
  in `request.log` from the first line. Confirm against the installed
  Fastify. Add an `onSend` hook that sets the response header.
- `trustProxy: true` so `client_ip` is the forwarded address
  (SPEC.md:1157; Fastify 5 accepts `true`, CIDR strings or a function).
- Fastify's default request/response logging prints `req`/`res`
  summaries at info; keep `disableRequestLogging: true` on the public and
  internal listeners and write the audit line yourself in `onResponse`,
  otherwise every request logs twice. Probe hits on the admin listener
  (`/healthz` every 10 s, `/readyz` every 5 s per SPEC.md:1327-1330) must
  not log at info; log them at debug or not at all.

## Redact list (SPEC.md:1151-1153, verbatim)

pino `redact` in both processes on every listener covers:

```
req.headers.authorization
input
result
runtimeStatus
error.details
dsn
```

Use the paths as given. Because fast-redact paths are positional, also
redact the same keys one level down for the shapes krun logs
(`run.input`, `run.result`, `run.runtimeStatus`, `run.error.details`,
`config.dsn`) rather than logging whole run or config objects at all. Do
not set `censor` to something that reveals length.

P3.1b acceptance: "a redacted field never appears in a log line"
(PLAN.md:382). Write the test (`@effect/vitest`) against a pino
destination stream, log an object containing each path with a sentinel
value once through pino and once through `Effect.log` with the replaced
Logger, and assert the sentinel is absent from the captured output.

## Never-log list

Never logged, regardless of level (SPEC.md:1153-1154, 1087-1089, 986,
1159):

- request and response bodies (public and internal listeners);
- Job manifests (they embed the Secret name and the env list);
- env lists / container env (presigned URLs live there);
- input, results, per-run tokens, API keys, `keys.yaml` contents;
- `KRUN_DB_DSN`, `KRUN_WEBHOOK_SECRET`, `KRUN_S3_SECRET_KEY`,
  `KRUN_S3_ACCESS_KEY` (never log the parsed config object; log the
  variable *name* in the exit-1 message, never the value);
- the `Authorization` header on either listener (SPEC.md:986 "The token
  is never logged").

Log the *name* of a thing, not its value: key name, Function name, Secret
name, run id, variable name, HTTP status. Dapr applies the same rule to
`secretKeyRef` resolution: every line names the resource or the env var,
never the value (`dapr pkg/runtime/processor/secret/secret.go:134-186`).

## Audit line (SPEC.md:1156-1159)

One line per `/v1` request (public listener only), at `info`; `warn` for
401 and 403. Fields:

| Field | Value | Notes |
|---|---|---|
| `key` | key name, or `null` | never the key itself (SPEC.md:1159); P3.1b asserts `key: null` on the 401 line (PLAN.md:381) |
| `client_ip` | `request.ip` with `trustProxy: true` | SPEC.md:1157 |
| `user_agent` | `User-Agent` header | |
| `route` | `request.routeOptions.url`, `unmatched` on 404 | same rule as the `route` metric label (SPEC.md:1131) |
| `code` | response status | |
| `run_id` | when present | create, get, cancel, wait, watch, result |
| `function` | when present | |
| `idempotency_key` | when present | the `requestId` of `CreateRun` (SPEC.md:228-233) |
| `reqId` | always | request-scoped (SPEC.md:277) |

Emit from a single `onResponse` hook registered on the public listener so
every route, including 404 and 415 before a handler runs, produces one
line. The internal listener logs `User-Agent` of each request
(SPEC.md:308) but has no `key`; it is not the `/v1` audit line.

## Levels for other events

- `debug`: stale CAS (zero rows), ignored informer events, probe hits,
  unhealthy readiness target names.
- `info`: process start with the resolved non-secret config summary (mode,
  addresses, namespace), readiness flips, leader acquired/lost, each run
  transition (`run_id function state reason`), shutdown steps.
- `warn`: 401/403 audit lines, transient Kubernetes errors with backoff,
  delivery attempt failures, Lease 409 retries.
- `error`: permanent failures (`job_create_failed`), informer watch
  errors before restart, startup validation failure (then exit 1).
- `fatal`: a shutdown release step exceeded its `Effect.timeout` (then
  runMain exits 1).
