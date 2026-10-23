---
name: krun-process-runtime
description: Use when wiring krun config, health, metrics or logs. Env parsing, admin listener, prom-client, pino redaction, SIGTERM order.
---

# krun process runtime: config, admin listener, metrics, logs, shutdown

Covers what both krun processes share below the business logic: SPEC
section 12 env parsing and startup validation, the admin listener
(`/healthz /readyz /metrics`), SPEC section 11 metrics, pino logging,
the audit line, health rules and the SIGTERM sequences. PLAN tasks P0.5,
P0.7, P3.1b, P3.7, P4.6, P4.11; every app skill points here for these.

## When to use

- Writing or changing `packages/shared/src/config` (P0.5) or
  `packages/shared/src/health` (P0.7) (PLAN.md:80, 90).
- Adding a metric, a log field, a redact path or the audit line (P3.1b,
  P4.6, and any task that touches a `krun_*` metric).
- Wiring `main.ts` of the gateway (P3.7) or the scheduler (P4.11):
  readiness, listeners, `close-with-grace`.
- Load `krun-gateway-api` or `krun-scheduler-k8s` next to this skill for
  the routes and loops; `krun-functions-crd` for the informer `synced`
  promise readiness depends on (P2.3); `krun-helm-chart` for probes and
  `terminationGracePeriodSeconds`; `krun-testing-ci` for `test/fake-kube`.

## Read first

- SPEC.md:176-189 listeners and the admin table; SPEC.md:1125-1174
  section 11 (metrics, logs, audit, health, shutdown); SPEC.md:1176-1221
  section 12 configuration; SPEC.md:154-162 readiness waits for the
  Function informer (D17); SPEC.md:1327-1332 probe values; D30
  (SPEC.md:1471).
- PLAN.md:160-166 P0.5; PLAN.md:171-177 P0.7; PLAN.md:360-363 P3.1b;
  PLAN.md:413-421 P3.7; PLAN.md:532-536 P4.6; PLAN.md:572-579 P4.11;
  PLAN.md:48-74 allowed dependencies.
- References in this skill: `references/env-table.md` (section 12 table
  with a process column and the validation rules),
  `references/metrics-table.md` (section 11 metrics with type and owning
  task), `references/logging.md` (pino fields, redact list, audit line,
  never-log list, levels), `references/shutdown.md` (both SIGTERM
  sequences step by step with the 30 s budget and the tests).

## Rules

1. One config object per process, every section 12 variable with its
   default, parsed once in `packages/shared/src/config` (PLAN.md:80, 160-163)
   because scattered `process.env` reads skip validation.
2. An empty value is unset: the default applies and no validation runs on
   it (SPEC.md:1183-1184); `KRUN_S3_PRESIGN_TTL=""` must yield the default
   (PLAN.md:165-166).
3. Validate at startup and exit 1 naming the first bad variable
   (SPEC.md:1179-1180): the five rules are DSN empty in postgres mode,
   scheduler with webhook hosts and no secret, a size above 1048576, a
   duration not matching `^\d+(ms|s|m|h)$`, a CIDR that does not parse
   (SPEC.md:1180-1183). Name the variable, never print its value.
4. Flags are unsupported except `--help` (SPEC.md:1178); add no other
   flags or options (PLAN.md:31-32).
5. `KRUN_NAMESPACE` falls back to the ServiceAccount `namespace` file
   (SPEC.md:1197) and `KRUN_GATEWAY_INTERNAL_URL` defaults to
   `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` (SPEC.md:1195),
   computed after the namespace is known.
6. `/healthz` is always 200 while the process runs (SPEC.md:1161); never
   couple it to the database or the informer, the chart's liveness probe
   hits it and a restart loop would not help (SPEC.md:1329-1330).
7. `/readyz` is 503 until the database check passes within 2 seconds and
   the Function informer finished its initial list, and from the start of
   shutdown (SPEC.md:1161-1163, SPEC.md:158-161, PLAN.md:174-176); a
   stalled DB check returns 503, it does not hang the probe.
8. A scheduler standby stays ready and reports leader status in the
   `/readyz` body without failing readiness (SPEC.md:1163-1164,
   PLAN.md:574-575); `RollingUpdate maxUnavailable: 0` relies on a Ready
   standby (SPEC.md:1335-1337).
9. Each listener answers 404 for the other listeners' paths
   (SPEC.md:181): `/v1/*` on the admin port is 404 (P3.7, PLAN.md:418),
   so the admin plugin registers only its three routes and no catch-all.
10. Metrics: exactly the SPEC.md:1129-1147 table, names, labels and
    owners; `route` is `request.routeOptions.url` and `unmatched` for 404
    (SPEC.md:1131); the chart's alert rules query these names
    (SPEC.md:1393-1401), so a rename is a Decisions row.
11. One `prom-client` `Registry` per process, no global registry, exposed
    on `GET /metrics` of the admin listener only (SPEC.md:1127, D30
    SPEC.md:1471 "never on the public port").
12. pino JSON, level from `KRUN_LOG_LEVEL`, fields `run_id function state
    reason reqId` (SPEC.md:1149-1150); the `redact` list
    `req.headers.authorization input result runtimeStatus error.details
    dsn` on every listener of both processes (SPEC.md:1151-1153).
13. Never log bodies, Job manifests, env lists, input, results, tokens,
    keys or the config object (SPEC.md:1153-1154, 1087-1089, 986); log
    names and ids, not values. docs/PROBLEM.md:82 makes this a success
    criterion.
14. One audit line per `/v1` request at info, warn on 401 and 403, with
    `key client_ip user_agent route code run_id function idempotency_key`,
    never the key itself (SPEC.md:1156-1159); P3.1b asserts `key: null`
    and a `reqId` on the 401 line (PLAN.md:362).
15. `X-Request-Id` accepted up to 128 characters else replaced by a UUID,
    echoed on every response, `reqId` on every request-scoped line
    (SPEC.md:276-277); `trustProxy: true` for `client_ip` (SPEC.md:1157).
16. Gateway SIGTERM: readiness 503 first, serve for `KRUN_SHUTDOWN_DELAY`
    with `/v1` never answering `NOT_READY`, then close listeners, end SSE,
    answer waits, close the pool, exit 0 (SPEC.md:1166-1170).
17. Scheduler SIGTERM: stop claiming, bound the iteration to 10 s, stop
    informers, clear `holderIdentity`, close the pool, exit 0
    (SPEC.md:1170-1174); leader loss exits non-zero instead
    (SPEC.md:790-792).
18. Both sequences fit the 30 s grace (SPEC.md:1174, 1238); use
    `close-with-grace` (PLAN.md:56) and let its timeout exit 1.
19. Dependencies only from PLAN.md:50-67; `pino` arrives through
    `fastify`, `prom-client`, `@fastify/under-pressure`, `close-with-grace`
    are listed; anything else (`pino-pretty`, `dotenv`, `envalid`, `zod`)
    needs a Decisions row (PLAN.md:29-30).

## Config parsing (P0.5)

- Shape: `parseGatewayConfig(env)` and `parseSchedulerConfig(env)` over a
  plain `Record<string, string | undefined>` so tests pass objects, not
  `process.env`. Each returns a frozen object or throws a `ConfigError`
  carrying the variable name; `main.ts` catches it, logs at error with the
  name only, and `process.exit(1)`.
- Treat `''` as `undefined` before every rule (rule 2). Trim nothing else;
  a stray space in a duration is a validation error.
- Parse durations into milliseconds with the regex of SPEC.md:1183; integer
  variables are plain digits (`KRUN_MAX_ACTIVE_DEADLINE=86400` is seconds,
  not a duration; see `references/env-table.md`).
- CIDRs: split on `,`, trim, parse each with `ipaddr.js`
  (`parseCIDR`, PLAN.md:66), keep the parsed tuples so the webhook check
  does not re-parse (`krun-webhooks-objstore`).
- The webhook-secret rule applies to the scheduler config only
  (SPEC.md:1180-1181); the gateway validates hosts and CIDRs but not the
  secret.
- `KRUN_DB_MODE` is `postgres` or `embedded` (SPEC.md:1188); anything else
  is the first bad variable.
- Acceptance (PLAN.md:163-166): one unit test per rule plus defaults and
  the empty-value case.

## Admin listener (P0.7)

- `packages/shared/src/health`: a Fastify plugin
  `adminPlugin(app, { registry, readiness })` registered on its own
  Fastify instance listening on `KRUN_ADMIN_LISTEN_ADDR`; the gateway has
  three instances, the scheduler one (SPEC.md:178-180; one Fastify
  instance owns one server, node-stack-facts.md:554-558).
- Readiness state object shared with `main.ts`: `{ dbCheck: () =>
  Promise<void>, functionsSynced: () => boolean, draining: boolean,
  leader?: () => boolean }`. `/readyz` returns 503 when `draining`, when
  `functionsSynced()` is false, or when `dbCheck()` has not resolved within
  2 s (`AbortSignal.timeout(2000)` / `Promise.race`); otherwise 200 with
  `{ status: 'ok', leader: true|false }` on the scheduler.
- `@fastify/under-pressure` (PLAN.md:55, 173): its `healthCheck` runs on
  a timer and on each status-route call and the service "is considered
  unhealthy until it has started to return true" (node-stack-facts.md:581-583).
  Use it for `/readyz` via `exposeStatusRoute: { url: '/readyz' }` with
  `healthCheck` returning the readiness result, and register `/healthz`
  as a plain route that returns 200. Fact marked UNVERIFIED: the exact 503
  payload of the status route (node-stack-facts.md:592-594); the P0.7
  `inject` test asserts the status code only, not the body shape.
- `/metrics`: `reply.type(registry.contentType).send(await
  registry.metrics())`.
- Acceptance (PLAN.md:176-177): `inject` tests for 200/503 transitions
  including a stalled DB check (a `dbCheck` that never resolves must give
  503 in about 2 s, not hang).
- Probe hits are not audit lines and not info logs
  (`references/logging.md`).

## Metrics (P3.1b, P4.6)

- Table, types and owning tasks: `references/metrics-table.md`.
- `krun_http_*` are recorded in one `onResponse` hook on every listener,
  including the admin listener of the scheduler (owner "both",
  SPEC.md:1131-1132); the hook reads `request.routeOptions.url` and maps
  undefined to `unmatched`.
- Histograms for every `_seconds` metric; give the run-timing histograms
  explicit buckets that reach `KRUN_MAX_ACTIVE_DEADLINE` (default buckets
  stop at 10 s, node-stack-facts.md:729).
- `krun_runs_current{function,state}` is refilled from `countByState`
  every loop (SPEC.md:1135); reset the gauge before refilling.
- No run id, request id, key name, IP or raw path as a label.
- Acceptance P3.1b: a 404 counts under `unmatched` (PLAN.md:362-363);
  P4.6: names appear on `/metrics` after one run through `test/fake-kube`
  (PLAN.md:535-536).

## Logging and audit (P3.1b)

- Details, redact list verbatim, audit fields and levels:
  `references/logging.md`.
- `disableRequestLogging: true` on the public and internal listeners; the
  audit line is one `onResponse` hook on the public listener so 401, 404
  and 415 produce it too.
- Redaction test (PLAN.md:363): capture pino output to a stream, log an
  object with sentinel values at each redact path, assert the sentinel is
  absent.

## Shutdown (P3.7, P4.11)

- Step tables for both processes, the budget, and the tests:
  `references/shutdown.md`.
- `close-with-grace` 2.5.0: `closeWithGrace({ delay }, fn)`; `fn` resolving
  exits 0, rejecting exits 1, timeout exits 1 (README and `index.js`
  read from the tarball; the earlier UNVERIFIED mark in
  node-stack-facts.md:610-614 is now verified for these three facts).
- Flip readiness synchronously in the handler before any `await`.
- Fastify `close()` does not end hijacked `reply.raw` SSE responses: track
  them and end them in a `preClose` hook (node-stack-facts.md:571-573).

## Library facts

- Fastify 5.12.7: `requestIdHeader` default `false`; `genReqId` must be
  error-free; `trustProxy` accepts `true`, CIDR strings or a function,
  hop counts disabled (node-stack-facts.md:490-500, VERIFIED).
- Fastify `logger: { level, redact }` goes to the pino constructor;
  `redact` is fast-redact syntax with `*` wildcards; Fastify 5.12.7 accepts
  `pino ^9.14.0 || ^10.1.0` (node-stack-facts.md:503-511, VERIFIED).
- `close()` sequence: closing flag with 503 + `Connection: close` →
  `preClose` → connection draining per `forceCloseConnections` (default
  `"idle"`) → `server.close()` → `onClose` (node-stack-facts.md:559-567,
  VERIFIED).
- `@fastify/under-pressure` 9.2.1 options and `healthCheck` semantics
  (node-stack-facts.md:575-591, VERIFIED); 503 payload shape UNVERIFIED.
- `prom-client` 15.1.3: `Registry`, `Counter/Gauge/Histogram` with
  `registers: [registry]`, `await registry.metrics()`,
  `registry.contentType`, ESM named imports work (node-stack-facts.md:726-735).
- `onListen` hooks do not run under `inject()` (node-stack-facts.md:521);
  do not put readiness wiring there if the P0.7 test uses `inject`.

## Lessons from Dapr, Knative Serving and KEDA

- Not-ready is 503, never 500: Dapr's sidecar returns 500 for not-ready
  on `/v1.0/healthz` while its control-plane servers use 503; krun uses
  503 everywhere (`dapr pkg/messages/predefined.go:63-78`,
  `pkg/healthz/server/server.go:58`).
- Model readiness as named targets and log the unhealthy names at debug:
  Dapr's operator marks the cache target ready only after cache sync
  (`dapr pkg/operator/operator.go:344-366`, `pkg/healthz/server/server.go:55-62`).
- Flip readiness before draining so probes fail during the drain, then
  close under a hard cap: Dapr's scheduler (`dapr pkg/scheduler/server/server.go:336-366`)
  and Knative's queue-proxy (`serving pkg/queue/sharedmain/main.go:310-347`).
- Grace expiry exits 1 and is asserted by a test: Dapr's integration suite
  expects exit code 1 and "Graceful shutdown timeout exceeded"
  (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`).
- Close independent servers concurrently under one deadline so the first
  close does not cancel the rest (`dapr pkg/api/http/server.go:235-265`).
- Hijacked streams are invisible to server close; count them and drain
  with a cap (`serving pkg/http/handler/hijack.go:27-66`).
- Secrets resolve into values that are never logged; lines name the
  resource or env var only (`dapr pkg/runtime/processor/secret/secret.go:134-186`).
- High-cardinality metric labels are opt-in in KEDA because
  per-trigger histogram labels exploded; keep krun labels bounded by
  Function count and route templates (`keda pkg/metricscollector/prommetrics.go:35-178`).
- Readiness waits for cache sync and fails fast when the initial list
  cannot complete; KEDA exits non-zero on `WaitForCacheSync` failure,
  krun stays 503 and retries with backoff (SPEC.md:159-161,
  `keda cmd/operator/main.go:352-359`).

## Pitfalls

- `KRUN_S3_PRESIGN_TTL=""` is the default, not an invalid duration
  (PLAN.md:165-166).
- The embedded-mode scheduler listens on `:9091` because the chart sets
  `KRUN_ADMIN_LISTEN_ADDR` so two processes share one pod (SPEC.md:1194);
  tests that run both processes locally must pick distinct admin ports.
- `KRUN_MAX_INPUT_BYTES` and `KRUN_MAX_RESULT_BYTES` have a hard ceiling
  of 1048576 (SPEC.md:1182); the chart also fails above it
  (`krun-helm-chart`).
- Liveness never on `/readyz`, no startup probe (SPEC.md:1330); a
  `/healthz` that checks the DB turns an outage into a restart storm.
- Gateway readiness depends on the API server at startup (D17,
  docs/PROBLEM.md:97-98): an unreachable API server keeps the gateway 503
  by design; do not "fix" it by serving before the initial list.
- Default pino request logging plus the audit hook logs every request
  twice; probe hits at info drown the log at 1 line per 5 s per pod.
- `process.exit` anywhere but the `close-with-grace` handler and the
  config failure path skips `onClose` hooks and leaves the Lease held.
- Informer `stop()` must be called in the scheduler sequence or the watch
  keeps the event loop alive and the P4.11 5 s exit assertion fails.
- The scheduler's `krun_http_*` series exist too (owner "both"); forgetting
  the hook on the scheduler admin listener breaks the metric contract.
- SPEC RISK (under-pressure fit): node-stack-facts.md:595-599 recommends
  hand-writing `/readyz` instead of under-pressure's status route because
  the plugin couples `healthCheck` to its own route and 503 schema, while
  PLAN.md:55 and :173 name `@fastify/under-pressure` for `/healthz` and
  `/readyz`. Use the plugin as PLAN says; if its status route cannot
  express the scheduler's leader field or the 2 s stall, record the
  deviation in a Decisions row rather than silently dropping the package.
- SPEC RISK (quiet period vs fixed delay): knative-serving.md:160-162
  argues the drain should be a quiet period that restarts on activity;
  SPEC.md:1166-1167 and D30 define a fixed `KRUN_SHUTDOWN_DELAY`. Implement
  the fixed delay; a quiet period is a Decisions row.
- Open gap (Lease identity): SPEC.md:785 says `holderIdentity` is the pod
  name from the downward API, but section 12 lists no variable carrying
  it (e.g. `KRUN_POD_NAME`) and the chart's env list (SPEC.md:1240-1249)
  does not name one. P4.2/P4.11 need a Decisions row adding the variable
  (default: `os.hostname()`, which is the pod name in Kubernetes) before
  the scheduler config can be complete.
- Open gap (namespace outside a pod): SPEC.md:1197 gives no behaviour
  when `KRUN_NAMESPACE` is unset and the ServiceAccount file is missing
  (P3.7/P4.11 process tests). Treat it as a startup validation failure
  naming `KRUN_NAMESPACE` and set the variable in tests; confirm with a
  Decisions row if the owner wants a `krun` default like the CLI
  (SPEC.md:756).
- Open gap (default metrics): `collectDefaultMetrics` and
  `krun_build_info` are not in the SPEC table; do not register them
  without a Decisions row (`references/metrics-table.md`).

## Before marking a task done

- Run the task's acceptance: P0.5 and P0.7 unit tests under
  `packages/shared/src/{config,health}` (PLAN.md:163-166, 176-177); P3.1b
  the gateway handler tests (PLAN.md:361-363); P3.7 and P4.11 the process
  tests against `test/fake-kube` (PLAN.md:415-421, 576-579); P4.6 the
  `/metrics` scrape after one run (PLAN.md:535-536); then `make check`
  (PLAN.md:17-18, CLAUDE.md:5).
- Branch per task id (`p0-5-config`), Conventional Commits with scope
  `shared`, `gateway` or `scheduler`, PR to main, merge when CI is green,
  never push main (PLAN.md:13-22).
- Mark `[x]`, append `YYYY-MM-DD P0.5 <short sha> note` to PLAN.md section
  6 and commit it with the code (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7,
  PLAN.md:16).
- Blocked on an owner decision (Lease identity variable, namespace
  default): `BLOCKED P4.11: <need>` in the progress log, take the next
  independent task (PLAN.md:27-28).

## Limitations

- Line numbers verified against the working tree on 2026-10-23;
  SPEC.md/PLAN.md are edited concurrently, so re-check a cited line before
  quoting it in a commit or a Decisions row.
- `@fastify/under-pressure` 503 payload and `@fastify/swagger` behaviour
  remain UNVERIFIED (node-stack-facts.md:592-594, 601-609); confirm at
  first install.
- This skill does not cover route handlers, error envelopes or SSE
  framing (`krun-gateway-api`), the loops and Lease contract
  (`krun-scheduler-k8s`), Store pool setup (`krun-store`), the informer
  (`krun-functions-crd`), chart probes and NetworkPolicies
  (`krun-helm-chart`), or `test/fake-kube` (`krun-testing-ci`).
