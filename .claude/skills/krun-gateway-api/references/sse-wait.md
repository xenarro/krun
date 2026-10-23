# `wait`, `WaitRun` and `WatchRun` (SSE): rules and the drain

Serves P5.1 (PLAN.md:625-630) and P5.2 (PLAN.md:631-637), and the drain
part of P3.7 (PLAN.md:432-441). SSE is written in house on `reply.raw`; no
package (PLAN.md section 2). Runs reach the wire only through `toRun(row)` /
`toRunSummary(row)` from `packages/shared/src/store` (SPEC.md:264-265,
529-539). Timers are `Effect.sleep` and `Schedule`, time comes from
`Clock`/`DateTime`, tests drive them with `TestClock.adjust`; no test
sleeps (docs/STACK.md 4.3, 4.4).

## 1. Notify fan-out (P5.1)

- One consumer of `Store.subscribe()` per gateway process. The Store
  exposes it as `Stream.Stream<{ id, kind: "state" | "status" |
  "job_status" }, DatabaseError>` (`krun-store`
  `references/store-interface.md`; SPEC.md:514 shows the promise form). A
  `Notifier` service forks `Stream.runForEach` into its layer scope;
  closing the scope interrupts it and releases the `LISTEN` client or the
  SQLite poll. Retry the stream with `Schedule.exponential` on
  `DatabaseError`; the 1 s fallback below keeps waiters correct meanwhile.
- Fan out by run id: `Map<runId, Set<Queue>>` of `Queue.sliding(1)` wake-up
  queues (a coalesced wake-up costs nothing; the handler re-reads the row).
  `Notifier.register(id)` is scoped: the finalizer removes the queue, so a
  disconnect or a finished wait never leaks an entry.
- Postgres: `LISTEN krun_runs`, payload `<id>:<state>`;
  `setRuntimeStatus` publishes `<id>:status`, `setJobStatus`
  `<id>:job_status` (SPEC.md:344-347, 541). SQLite: `run_events` polled by
  rowid every 1 s from `max(rowid)` at subscribe time; `from_state =
  to_state` rows are `job_status`, others `state`; runtime status reaches
  SSE only through the handler's 1 s re-read (SPEC.md:541-546).
- Both modes keep a 1 s poll fallback in the wait and SSE handlers
  (SPEC.md:545-546): on every wake-up (queue or a 1 s tick) re-read with
  `getRun(id)` and act on the row, never on the notify payload.
- `CreateRun` with `wait`: `register(id)` before `createRun` inserts, so no
  event is missed (SPEC.md:295-296). The id comes from `v7({ msecs })` on
  `Clock` before the insert, so it is known in advance.

## 2. `wait` on `CreateRun` and `WaitRun`

| Rule | Source |
|---|---|
| `wait` (query on `POST /v1/functions/{function}/runs`) and `timeout` (body of `POST .../runs/{run}:wait`) match `^\d+(ms\|s\|m\|h)$`, parsed by the shared Zod refinement into `Duration`; bad grammar 400 `REQUEST_INVALID` | docs/API.md:23-26, 324 |
| Both capped at `KRUN_MAX_WAIT` (default `60s`, `Function.maxWait`); `WaitRun` without `timeout` waits the cap | SPEC.md:232, 1234, docs/API.md:83, 253 |
| `CreateRun` answers 201 whether terminal or elapsed; `WaitRun` 200; no error on timeout; the client reads `state` | SPEC.md:232-233, docs/API.md:212-217, 253-256 |
| The body is the FULL `Run` as it is now | docs/API.md:123-126 |
| An idempotent replay with `wait` waits too | SPEC.md:230-231, docs/API.md:207-209 |
| Client disconnect never cancels the run; the abort only interrupts the wait | SPEC.md:296-297, docs/API.md:220-221 |
| The drain answers in-flight waits at once with the current row (still 201 / 200) | SPEC.md:233, 1198-1203, PLAN.md:628 |
| `WaitRun` needs `runs:read` and owner scoping like `GetRun` | SPEC.md:207, 215-217 |

Shape: `waitForTerminal(id, timeout)` is a scoped Effect that registers
the wake-up queue, then races (a) a loop of `Queue.take` or the 1 s tick
that re-reads and stops on a terminal row, (b) `Effect.sleep(timeout)`,
(c) `Deferred.await(drain.shuttingDown)`; whichever wins, re-read once and
answer with that row. The `createRun` before it is
`Effect.uninterruptible`: a disconnect mid-request never leaves a
half-created run, it only ends the wait. Never Fastify `handlerTimeout`:
the wait has its own deadline and a server-level `handlerTimeout` cannot
be opted out per route. Set the response the moment the race ends; a wait
never writes an error status after deciding to answer (knative lesson).

## 3. `WatchRun` SSE message rules (P5.2)

Source: SPEC.md:253-258, docs/API.md:283-295, transcript docs/API.md:439-456.
Route: `GET /v1/functions/{function}/runs/{run}:watch`. Auth, scope and
owner scoping run first; any failure is a normal envelope before
`hijack()`.

| Rule | Detail |
|---|---|
| Headers | `reply.hijack()`, then `reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-request-id": request.id })`; `reply.header()` values are not applied to `raw` writes |
| First message | one `event: state` with the current BASIC run (`toRunSummary`) |
| Terminal at connect | that one event, then `end()` |
| Later messages | one event per changed group: `state`, `status`, `job_status`; `data:` the BASIC run as one line of JSON |
| `id:` | the field's own time: `createTime` / `scheduleTime` / `startTime` / `endTime` for `state` (`DateTime.now` read time for `CANCELLING`, which has no column); `runtimeStatus.reportTime` for `status`; `jobStatus.observeTime` for `job_status` |
| Change detection | compare the re-read row with the last sent snapshot per group (`state`; `runtime_status.at`; `job_status` minus `observedAt`); a 1 s tick without change sends nothing |
| Keepalive | `: keepalive\n\n` every 15 s from a fiber on `Schedule.spaced("15 seconds")` |
| Close | after the terminal `state` event; on the drain; on client disconnect (`request.signal` aborts, the fiber is interrupted) |
| `Last-Event-ID` | ignored; a reconnect gets the snapshot again; ending without a terminal event is not an error |
| Never | `input`, `result`, `logTail`, `error.details` in `data`; no Fastify serialisation of the stream; no error status after `writeHead` |

Shape: the SSE handler is one scoped Effect. `Effect.addFinalizer` ends
`reply.raw` (idempotent), so terminal, drain, disconnect and defects all
close the stream the same way; the keepalive fiber is forked into that
scope (`Effect.forkScoped`) and dies with it. `raw.write` returning
`false` means a slow client: wait for `drain` or end the stream; never
buffer without bound.

Wire format per message (a blank line ends it):

```
event: status
id: 2026-10-22T10:00:12.000Z
data: {"name":"functions/report-generator/runs/019a...","state":"RUNNING",...}

```

## 4. The drain (P3.7, P5.1, P5.2)

SIGTERM order: SPEC.md:1198-1206, D30 (SPEC.md:1534), PLAN.md:432-441,
docs/STACK.md 4.1. `NodeRuntime.runMain` turns SIGTERM into interruption of
the main fiber; `Layer.launch` closes the scope; each server layer's
release runs:

1. `Drain` (once per process, `krun-process-runtime`): set `draining` on
   the `Readiness` `Ref` before any sleep, so the admin `/readyz` answers
   503. `/v1` and `/internal/v1`
   keep serving normally and never answer `NOT_READY` (docs/API.md:342,
   INTERNAL-API.md:286).
2. `Effect.sleep(KRUN_SHUTDOWN_DELAY)` (default `5s`, SPEC.md:1235): a
   fixed delay, not a resettable quiet period (knative lesson in SKILL.md).
3. Complete `shuttingDown` (`Deferred`): every SSE handler ends its stream
   (no shutdown event; SPEC.md:256-258) and every pending wait answers
   with the current row.
4. `app.close()` under `Effect.promise`. SPEC lists "closes the
   listeners, ends open SSE streams, answers waits" as one step; Fastify's
   `close()` waits for in-flight requests and does not end hijacked
   streams, which is why step 3 comes first
   (measured: a close with one open SSE stream or one pending wait blocked
   for seconds; with them ended first it took 2 ms). As a second guard, a
   `preClose` hook completes the same `Deferred`.
5. With `return503OnClosing: false` a request that slips in on a
   kept-alive connection during close is served normally with
   `Connection: close`, not answered with Fastify's plain 503.
6. Finalizers run in reverse acquisition order: the Notifier fiber stops,
   then the pool closes last, so step 3 could still read the current row.
7. Exit code: `runMain`'s default teardown returns 130 for an
   interrupt-only exit (measured with `@effect/platform-node` 4.0.6). SPEC
   requires exit 0, so `main.ts` passes a `teardown` that maps
   interrupt-only to 0 (owned by `krun-process-runtime`, shared with the
   scheduler).

The whole drain fits the 30 s termination grace (SPEC.md:1206, 1274):
5 s delay plus close; nothing in it waits on a client.

## 5. Tests the handlers must pass

`@effect/vitest` `it.effect` (scoped, `TestClock` provided). Build the app
inside the test so handlers run on the test clock; `app.inject` under
`Effect.promise`; SSE tests that read incrementally may `listen` on port 0
with `it.live` for the socket part only, still without sleeps (await the
bytes).

- P5.1 (PLAN.md:628-630): a fake store emitting a transition resolves the
  wait; `WaitRun` returns the run at timeout without error
  (`TestClock.adjust` past the timeout); the drain ends a wait early
  (complete `shuttingDown` or close the layer scope).
- P5.2 (PLAN.md:634-637): a client reads a `state` event, a `status`
  event, then EOF; `data` has no `input`; terminal at connect yields one
  message then EOF; `TestClock.adjust("15 seconds")` yields one keepalive.
- P3.7 (PLAN.md:436-441): with `KRUN_SHUTDOWN_DELAY=2s` a `/v1` request
  after `/readyz` turned 503 still answers 200, and the process exits 0
  within 5 s of SIGTERM.
- Phase 5 gate (PLAN.md:618-623): e2e `CreateRun?wait=30s` returns 201
  with `state: SUCCEEDED` and the inline `result`; `POST ...:wait` on the
  same run returns 200 with the same terminal run.
