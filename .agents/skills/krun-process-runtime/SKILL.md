---
name: krun-process-runtime
description: Use when wiring krun config, health, metrics, logs or process entry. Zod env schema as a Config layer, readiness route over a Ref, prom-client, pino-backed Effect Logger, runMain shutdown.
---

# krun process runtime: config, admin listener, metrics, logs, shutdown

Covers what both krun processes share below the business logic: SPEC
section 12 env parsing and startup validation, the admin listener
(`/healthz /readyz /metrics`), SPEC section 11 metrics, pino logging and
the Effect Logger on top of it, the audit line, health rules, the process
entry and the SIGTERM sequences. PLAN tasks P0.5, P0.7, P3.1b, P3.7, P4.6,
P4.11; every app skill points here for these.

## When to use

- Writing or changing `packages/shared/src/config` (P0.5),
  `packages/shared/src/health` (P0.7) or the shared layers in
  `packages/shared/src/runtime` (Config, Logger, Metrics; PLAN.md:96, 106,
  107).
- Adding a metric, a log field, a redact path or the audit line (P3.1b,
  P4.6, and any task that touches a `krun_*` metric).
- Wiring `main.ts` of the gateway (P3.7) or the scheduler (P4.11):
  `NodeRuntime.runMain(Layer.launch(Main))`, listener layers, readiness,
  finalizer order.
- Load `krun-gateway-api` or `krun-scheduler-k8s` next to this skill for
  the routes and loops; `krun-functions-crd` for the informer `synced`
  signal readiness depends on (P2.3); `krun-helm-chart` for probes and
  `terminationGracePeriodSeconds`; `krun-testing-ci` for `test/fake-kube`.
- Also load the Effect skills (`effect-core-patterns`,
  `effect-dependency-injection`, `effect-resource-management`,
  `effect-testing`), `fastify-best-practices` and `zod-4` (docs/STACK.md
  section 5). Effect's `MIGRATION.md` overrides skill text written for
  Effect 3: `Context.Tag` is `Context.Service`, `Runtime<R>` is gone,
  `FiberRef` is `Context.Reference`.

## Read first

- docs/STACK.md in full (normative, SPEC D35 SPEC.md:1476): 2.5 for pino
  and prom-client, 4.1 process shape, 4.4 time.
- SPEC.md:176-189 listeners and the admin table; SPEC.md:1125-1174
  section 11 (metrics, logs, audit, health, shutdown); SPEC.md:1176-1221
  section 12 configuration; SPEC.md:158-161 readiness waits for the
  Function informer (D17); SPEC.md:1327-1332 probe values; D30
  (SPEC.md:1471).
- PLAN.md:179-186 P0.5; PLAN.md:191-197 P0.7; PLAN.md:379-382 P3.1b;
  PLAN.md:432-441 P3.7; PLAN.md:552-556 P4.6; PLAN.md:592-599 P4.11;
  PLAN.md:58-86 allowed dependencies.
- References in this skill: `references/env-table.md` (section 12 table
  with a process column and the validation rules),
  `references/metrics-table.md` (section 11 metrics with type and owning
  task), `references/logging.md` (pino fields, redact list, audit line,
  never-log list, levels, the Effect Logger), `references/shutdown.md`
  (both SIGTERM sequences step by step with the 30 s budget and the
  tests).

## Rules

1. One config per process, every section 12 variable with its default,
   parsed once by a Zod schema over `process.env` in
   `packages/shared/src/config` and exposed as an Effect `Config` service
   layer (PLAN.md:96, 179-186, docs/STACK.md principle 2); scattered
   `process.env` reads skip validation. Effect's own `Config` module and
   Effect Schema are not used for this.
2. An empty value is unset: the default applies and no validation runs on
   it (SPEC.md:1183-1184); `KRUN_S3_PRESIGN_TTL=""` must yield the default
   (PLAN.md:185-186).
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
7. `/readyz` is 503 until marked ready (database check passes and the
   Function informer finished its initial list), when the database check
   exceeds 2 seconds, and from the start of shutdown (SPEC.md:1161-1163,
   SPEC.md:158-161, PLAN.md:191-196). It is a small route over an Effect
   `Ref`, the check bounded with `Effect.timeout("2 seconds")`; a stalled
   check returns 503, it does not hang the probe.
8. A scheduler standby stays ready and reports leader status in the
   `/readyz` body without failing readiness (SPEC.md:1163-1164,
   PLAN.md:594-595); `RollingUpdate maxUnavailable: 0` relies on a Ready
   standby (SPEC.md:1335-1337).
9. Each listener answers 404 for the other listeners' paths
   (SPEC.md:181): `/v1/*` on the admin port is 404 (P3.7, PLAN.md:438),
   so the admin plugin registers only its three routes and no catch-all.
10. Metrics: exactly the SPEC.md:1129-1147 table, names, labels and
    owners; `route` is `request.routeOptions.url` and `unmatched` for 404
    (SPEC.md:1131); the chart's alert rules query these names
    (SPEC.md:1393-1401), so a rename is a Decisions row.
11. One `prom-client` `Registry` per process, held by a `Metrics` service
    layer, no global registry, exposed on `GET /metrics` of the admin
    listener only (SPEC.md:1127, D30 SPEC.md:1471 "never on the public
    port"). Effect `Metric` is not used (docs/STACK.md 2.5).
12. pino JSON, level from `KRUN_LOG_LEVEL`, fields `run_id function state
    reason reqId` (SPEC.md:1149-1150); the `redact` list
    `req.headers.authorization input result runtimeStatus error.details
    dsn` on every listener of both processes (SPEC.md:1151-1153). The
    Effect `Logger` is replaced by one that writes to the same pino
    instance, so `Effect.log*` lines get the same format and redaction
    (docs/STACK.md 2.5).
13. Never log bodies, Job manifests, env lists, input, results, tokens,
    keys or the config object (SPEC.md:1153-1154, 1087-1089, 986); log
    names and ids, not values. docs/PROBLEM.md:82 makes this a success
    criterion.
14. One audit line per `/v1` request at info, warn on 401 and 403, with
    `key client_ip user_agent route code run_id function idempotency_key`,
    never the key itself (SPEC.md:1156-1159); P3.1b asserts `key: null`
    and a `reqId` on the 401 line (PLAN.md:380-381).
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
18. Shutdown is `NodeRuntime.runMain(Layer.launch(Main), { teardown })`
    plus scope finalizers (docs/STACK.md 4.1): SIGTERM interrupts the main
    fiber, finalizers run in reverse acquisition order, so listeners close
    before the pool. Pass the teardown from `references/shutdown.md`: the
    default maps SIGTERM to exit 130, SPEC wants 0. No signal handlers of
    your own; `process.exit` only in the grace watchdog. Both sequences
    fit the 30 s grace (SPEC.md:1174, 1238): bound each release step with
    `Effect.timeout` and arm a 25 s watchdog so a stuck step cannot outlive
    the kubelet's SIGKILL.
19. Dependencies only from PLAN.md:58-74 (ranges in docs/STACK.md); `pino`
    arrives through `fastify`; `effect`, `@effect/platform-node`, `zod`,
    `prom-client`, `ipaddr.js` are listed; anything else (`pino-pretty`,
    `dotenv`, `envalid`) needs a Decisions row (PLAN.md:29-30).
20. Time: application code never calls `Date.now()` or `new Date()`; read
    `Clock`/`DateTime`, and tests use `TestClock` (CLAUDE.md rule 8,
    docs/STACK.md 4.4).

## Config parsing (P0.5)

- Shape: Zod schemas `GatewayEnv` and `SchedulerEnv` over a plain
  `Record<string, string | undefined>`, and a `parseConfig(env)` Effect
  that fails with a `ConfigInvalid` `Data.TaggedError` carrying the
  variable name; tests pass objects, never `process.env`. The service
  layer (`Layer.effect`) reads `process.env` once and runs `parseConfig`.
  Its failure fails `Layer.launch`: one error line naming the variable,
  then the teardown exits 1 (probe: exit 1). Name the service `KrunConfig`
  or similar so it is not confused with Effect's `Config` module.
- Treat `''` as `undefined` before every rule (rule 2): one `z.preprocess`
  wrapper shared by every field. Trim nothing else; a stray space in a
  duration is a validation error.
- Durations: `z.string().regex(/^\d+(ms|s|m|h)$/)` transformed into an
  Effect `Duration` (docs/STACK.md 4.3). Give its default with
  `.prefault("5s")`, never `.default(Duration.seconds(5))`: Zod 4.6.7
  shallow-clones an object default and the `Duration` comes back as a
  plain object (probe). Integer variables are plain digits
  (`KRUN_MAX_ACTIVE_DEADLINE=86400` is seconds, not a duration). Do not use
  `z.coerce.number()`: it accepts `1e3`, ` 12` and `""`. Verified code and
  the full table: `references/env-table.md`.
- CIDRs: split on `,`, trim, parse each with `ipaddr.js` (`parseCIDR`,
  PLAN.md:73) in a transform that adds an issue on failure; keep the parsed
  tuples so the webhook check does not re-parse (`krun-webhooks-objstore`).
- "First bad variable": the first issue's `path[0]`. Field issues come in
  schema key order (keep the SPEC table order); cross-field rules (DSN in
  postgres mode, scheduler webhook secret) sit in a `superRefine`, whose
  issues always come after the field issues. Never format the `ZodError`
  or `issue.input` into a log line: it can hold the DSN or a secret.
- The webhook-secret rule applies to the scheduler config only
  (SPEC.md:1180-1181); the gateway validates hosts and CIDRs but not the
  secret.
- `KRUN_DB_MODE` is `postgres` or `embedded` (SPEC.md:1188); anything else
  is the first bad variable.
- Acceptance (PLAN.md:183-186): one Vitest test per rule plus defaults and
  the empty-value case. Parsing is pure, so plain `it` is enough; use
  `it.effect` for the `parseConfig` Effect and its tagged failure.

## Admin listener (P0.7)

- `packages/shared/src/health`: a Fastify plugin registered on its own
  Fastify instance listening on `KRUN_ADMIN_LISTEN_ADDR`, wrapped in the
  `AdminServer` scoped layer; the gateway has three instances, the
  scheduler one (SPEC.md:178-180; one Fastify instance owns one server).
  No `@fastify/under-pressure` (docs/STACK.md:98).
- A `Readiness` service holds a `Ref` of `{ ready: boolean, draining:
  boolean, leader?: boolean }` plus a `dbCheck: Effect<void, DatabaseError>`
  and `functionsSynced: Effect<boolean>`. `main.ts` flips `ready` after the
  first good check; the `Drain` finalizer sets `draining`.
- The hand-written route (probe `mod.test.mjs` passed with this shape):
  ```ts
  app.get("/readyz", async (_req, reply) => {
    const ok = await run(Effect.gen(function* () {
      const s = yield* Ref.get(readiness.state)
      if (s.draining || !s.ready || !(yield* readiness.functionsSynced)) return false
      return Option.isSome(yield* readiness.dbCheck.pipe(Effect.timeoutOption("2 seconds"), Effect.option, Effect.map(Option.flatten)))
    }))
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", ...leaderField })
  })
  ```
  `run` is `Effect.runPromiseWith(ctx)` over the context captured in the
  layer constructor; `leaderField` is `{ leader }` on the scheduler only.
- `/healthz` is a plain route that returns 200.
- `/metrics`: `reply.type(registry.contentType).send(await
  registry.metrics())`.
- Acceptance (PLAN.md:196-197): `@effect/vitest` `it.effect` with Fastify
  `inject` and `TestClock`. Build the app inside the test from
  `yield* Effect.context()` so its handlers run on the `TestClock`. Stalled
  DB check: `dbCheck = Effect.never`, fork `Effect.promise(() =>
  app.inject("/readyz"))`, `TestClock.adjust("1999 millis")` and assert the
  fiber is still pending (`fiber.pollUnsafe()` is `undefined` after an
  `Effect.yieldNow`), adjust 1 ms more, join, expect 503. Also: 200 when
  ready, 503 when `draining`, 404 for `/v1/functions` on the admin app.
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
  stop at 10 s). Durations for histograms come from `Clock`, not
  `Date.now()`.
- `krun_runs_current{function,state}` is refilled from `countByState`
  every loop (SPEC.md:1135); reset the gauge before refilling.
- No run id, request id, key name, IP or raw path as a label.
- Acceptance P3.1b: a 404 counts under `unmatched` (PLAN.md:381-382);
  P4.6: names appear on `/metrics` after one run through `test/fake-kube`
  (PLAN.md:555-556).

## Logging and audit (P3.1b)

- Details, redact list verbatim, audit fields, levels and the verified
  Effect Logger code: `references/logging.md`.
- Request logging off on every listener through `logController: new
  LogController({ disableRequestLogging: true })` (the top-level
  `disableRequestLogging` is deprecated in Fastify 5.12.7, FSTDEP023); the
  audit line is one `onResponse` hook on the public listener so 401, 404
  and 415 produce it too.
- Effect logs: `Logger.layer([PinoLogger])` replaces the default logger
  set, and `References.MinimumLogLevel` follows `KRUN_LOG_LEVEL` (Effect's
  default minimum is `Info`). Inside a request, provide `request.log` as
  the `CurrentPino` reference so `Effect.log*` lines carry `reqId`.
- Redaction test (PLAN.md:382): capture pino output to a stream, log an
  object with sentinel values at each redact path through the root pino,
  `request.log` and `Effect.logInfo`, assert the sentinel is absent.

## Shutdown (P3.7, P4.11)

- Verified mechanism, layer shape, step tables for both processes, the
  budget, the watchdog and the tests: `references/shutdown.md`.
- Exit codes: SIGTERM is an interrupt-only exit; `runMain`'s default
  teardown maps it to **130** (`Runtime.defaultTeardown`, probe). Pass
  `teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) ||
  Cause.hasInterruptsOnly(exit.cause) ? 0 : 1)`. Leader loss and config
  failure fail the main fiber with a tagged error and exit 1.
- `Layer.mergeAll` releases its members concurrently, so the three
  gateway listeners close together; a `Drain` layer on top of them flips
  readiness first and waits `KRUN_SHUTDOWN_DELAY` once.
- Flip readiness (`Ref.set`) as the first effect of the first finalizer,
  before any sleep.
- Fastify `close()` does not end hijacked `reply.raw` SSE responses:
  complete the shutdown `Deferred` in the public listener's `preClose`
  hook and await the tracked responses' `finish` there, or `close()`
  waits on a busy keep-alive socket until its timeout (probe).

## Library facts and prior art

Verified versions, Fastify/pino/prom-client/Effect 4 API facts, and the
Dapr, Knative and KEDA lessons (503 not 500, flip readiness before the
drain, grace overrun exits 1, bounded labels, readiness waits for cache
sync): `references/library-facts.md`.

## Pitfalls

- `KRUN_S3_PRESIGN_TTL=""` is the default, not an invalid duration
  (PLAN.md:185-186).
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
- `process.exit` anywhere but the grace watchdog skips the finalizers and
  leaves the Lease held and the pool open; `runMain`'s teardown ends the
  process. A config failure is a failed layer, not an exit call.
- `NodeRuntime.runMain` without a `teardown` exits 130 on SIGTERM, and
  the P3.7/P4.11 "exits 0" assertions fail.
- `KRUN_SHUTDOWN_DELAY` must elapse once per process. Put it in one
  `Drain` layer above the merged listeners (`references/shutdown.md`); if
  each listener release drains instead, share one memoised Effect, or the
  releases each wait the full delay.
- A `ManagedRuntime` or context captured outside an `it.effect` body runs
  on the live clock; `TestClock.adjust` then does nothing and the 2 s
  readiness test hangs or sleeps for real.
- Under `TestClock`, test the shutdown order by closing a `Scope` built
  with `Layer.buildWithScope`, not by interrupting a `Layer.launch` fiber:
  a finalizer's `Effect.sleep` returned `Interrupt` at once in that setup
  (probe).
- `.default(Duration.seconds(5))` on a Zod field yields a plain object,
  not a `Duration`; use `.prefault("5s")`.
- The Effect logger drops `logDebug` unless `References.MinimumLogLevel`
  is set from `KRUN_LOG_LEVEL`: Effect's default minimum is `Info`.
- Informer stop must run in a finalizer in the scheduler sequence or the
  watch keeps the event loop alive and the P4.11 5 s exit assertion fails.
- The scheduler's `krun_http_*` series exist too (owner "both"); forgetting
  the hook on the scheduler admin listener breaks the metric contract.
- SPEC RISK (quiet period vs fixed delay): knative-serving argues the drain
  should be a quiet period that restarts on activity; SPEC.md:1166-1167
  and D30 define a fixed `KRUN_SHUTDOWN_DELAY`. Implement the fixed delay;
  a quiet period is a Decisions row.
- Open gap (Lease identity, still open 2026-10-23): SPEC.md:785 says
  `holderIdentity` is the pod name from the downward API (`metadata.name`),
  but section 12 (SPEC.md:1186-1217) lists no variable carrying it (e.g.
  `KRUN_POD_NAME`), the chart's `config:` block (SPEC.md:1240-1256) names
  none, and P4.2 (PLAN.md:488-489) only says "the pod name". P4.2/P4.11
  need a Decisions row adding the variable (default: `os.hostname()`,
  which is the pod name in Kubernetes) before the scheduler config is
  complete.
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

- Run the task's acceptance: P0.5 and P0.7 with `pnpm exec vitest run
  packages/shared/src/config packages/shared/src/health`
  (PLAN.md:183-186, 196-197); P3.1b the gateway handler tests
  (PLAN.md:380-382); P3.7 and P4.11 the process tests against
  `test/fake-kube` (PLAN.md:436-441, 596-599); P4.6 the `/metrics` scrape
  after one run (PLAN.md:555-556); then `make check` (PLAN.md:17-18,
  CLAUDE.md rule 3).
- Branch per task id (`p0-5-config`), Conventional Commits with scope
  `shared`, `gateway` or `scheduler`, PR to main, merge when CI is green,
  never push main (PLAN.md:13-22).
- Mark `[x]`, append `YYYY-MM-DD P0.5 <short sha> note` to PLAN.md section
  6 and commit it with the code (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md rule 5,
  PLAN.md:16).
- Blocked on an owner decision (Lease identity variable, namespace
  default): `BLOCKED P4.11: <need>` in the progress log, take the next
  independent task (PLAN.md:27-28).

## Limitations

- Line numbers verified against the working tree on 2026-10-23;
  SPEC.md/PLAN.md are edited concurrently, so re-check a cited line before
  quoting it in a commit or a Decisions row.
- Library facts were checked against effect/@effect/platform-node 4.0.6,
  zod 4.6.7, fastify 5.12.7 and pino 10.4.0 with JavaScript probes on Node
  26, not with TypeScript 7 type-checking; type signatures in the snippets
  are UNVERIFIED until the first `tsc` run. `NodeRuntime` is
  `@stability unstable` in 4.0.6. `@fastify/swagger` behaviour remains
  UNVERIFIED.
- This skill does not cover route handlers, error envelopes or SSE
  framing (`krun-gateway-api`), the loops and Lease contract
  (`krun-scheduler-k8s`), Store pool setup (`krun-store`), the informer
  (`krun-functions-crd`), chart probes and NetworkPolicies
  (`krun-helm-chart`), or `test/fake-kube` (`krun-testing-ci`).
