# `wait`, `WaitRun` and `WatchRun` (SSE): rules and shutdown interaction

Serves P5.1 (PLAN.md:625-630) and P5.2 (PLAN.md:631-637). SSE is written in
house on `reply.raw`; no package (PLAN.md:82-83). Everything here reads runs
through `toRun(row)` / `toRunSummary(row)` from `packages/shared/src/store`,
the only row-to-wire mappers (SPEC.md:264-265, SPEC.md:529-534). Timers are
Effect `Schedule`s and `Effect.sleep`, time comes from `Clock`/`DateTime`,
and tests drive them with `TestClock.adjust`; no test sleeps
(docs/STACK.md 4.3, 4.4).

## 1. Notify fan-out (P5.1)

- One `store.subscribe(signal)` consumer per gateway process, wrapped as a
  `Stream` (`Stream.fromAsyncIterable`) and run by a fiber forked into the
  public listener layer's scope; it yields
  `{ id, kind: "state" | "status" | "job_status" }` (SPEC.md:514). Fan out
  by run id to the waiting `wait` handlers and open SSE streams, e.g. a
  `Map<runId, Set<Queue>>` of sliding queues of capacity 1 (a missed
  wake-up costs nothing: the handler re-reads the row anyway). Closing the
  scope interrupts the fiber and aborts the `subscribe` signal.
- Postgres: `LISTEN krun_runs`, payload `<id>:<state>`; `setRuntimeStatus`
  publishes `<id>:status`, `setJobStatus` `<id>:job_status`
  (SPEC.md:344-347, SPEC.md:541). SQLite: `run_events` polled by rowid every
  1 s from `max(rowid)` at subscribe time, `from_state = to_state` rows are
  `job_status`, others `state`; runtime status reaches SSE only through the
  handler's 1 s re-read (SPEC.md:541-545).
- Both modes keep a 1 s poll fallback inside the wait and SSE handlers
  (SPEC.md:545-546): on every wake-up (notify or the 1 s
  `Schedule.spaced("1 second")` tick) re-read the run with `getRun(id)` and
  act on the row, never on the notify payload alone.
- `CreateRun` with `wait`: register the waiter for the run id before
  `createRun` inserts the row so no event is missed (SPEC.md:295-296,
  PLAN.md:625).

## 2. `wait` on `CreateRun` and `WaitRun`

| Rule | Source |
|---|---|
| `wait` (query on `POST /v1/functions/{function}/runs`) and `timeout` (body of `POST /v1/functions/{function}/runs/{run}:wait`) are durations `^\d+(ms\|s\|m\|h)$`, parsed by the shared Zod refinement into `Duration`; bad grammar is 400 `REQUEST_INVALID` | docs/API.md:23-26, docs/API.md:324 |
| Cap both at `KRUN_MAX_WAIT` (default `60s`, exposed as `Function.maxWait`); `WaitRun` with no `timeout` uses the cap as default | SPEC.md:232, SPEC.md:1202, docs/API.md:83, docs/API.md:253 |
| `CreateRun` answers 201 whether the run became terminal or the wait elapsed; `WaitRun` answers 200; neither errors on timeout; the client reads `state` | SPEC.md:232-233, docs/API.md:212-217, docs/API.md:253-256 |
| The response body is the FULL `Run` as it is now | docs/API.md:123-125 |
| An idempotent replay with `wait` also waits | SPEC.md:230-231, docs/API.md:207-209 |
| Client disconnect never cancels the run; the abort signal interrupts only the wait | SPEC.md:296-297, docs/API.md:220-221 |
| At shutdown the server answers in-flight waits at once with the current state (still 201 / 200) | SPEC.md:233, SPEC.md:1169-1170, PLAN.md:628 |
| `WaitRun` needs scope `runs:read` and owner scoping like `GetRun` | SPEC.md:207, SPEC.md:215-217 |

Implementation shape: `waitForTerminal(id, timeout)`, an Effect that races
(a) a loop over fan-out wake-ups and the 1 s tick that re-reads the row and
completes when it is terminal, (b) `Effect.sleep(timeout)`, (c)
`Deferred.await(shuttingDown)` from the shared shutdown service; whichever
wins, re-read the row once more and answer with it. Do not use Fastify
`handlerTimeout` for this: the wait already has its own deadline, and a
server-level `handlerTimeout` cannot be opted out per route. The insert
before the wait is `Effect.uninterruptible`, so a disconnect during
`CreateRun?wait` never leaves a half-created run.

## 3. `WatchRun` SSE message rules (P5.2)

Source: SPEC.md:253-258 and docs/API.md:283-295. Route: `GET
/v1/functions/{function}/runs/{run}:watch`.

| Rule | Detail |
|---|---|
| Headers | `reply.hijack()` then `reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-request-id": <id> })`; headers set with `reply.header()` are not applied to `raw` writes |
| First message | one `event: state` with the current BASIC run (`toRunSummary`) on connect |
| Terminal at connect | that one `state` event, then `end()` |
| Subsequent messages | one event per changed field group: `event: state`, `event: status`, `event: job_status`; `data:` is the BASIC run as one line of JSON |
| `id:` | the field's own time: `createTime` / `scheduleTime` / `startTime` / `endTime` for `state` (the read time from `DateTime.now` for `CANCELLING`, which has no column); `runtimeStatus.reportTime` for `status`; `jobStatus.observeTime` for `job_status` |
| Change detection | compare the re-read row with the last sent snapshot per group (`state`, `runtime_status.at`, `job_status` minus `observedAt`); emit only when the group changed, so a 1 s poll tick without change sends nothing |
| Keepalive | `: keepalive\n\n` every 15 s from a fiber on `Schedule.spaced("15 seconds")` |
| Close | after the terminal `state` event; on server shutdown; on client disconnect (`raw` `close` event, which aborts the handler's signal) |
| `Last-Event-ID` | ignored; a reconnecting client gets the snapshot again; a stream ending without a terminal event is not an error |
| Never | `input`, `result`, `logTail`, `error.details` in `data` (BASIC view, docs/API.md:123-126); no Fastify serialisation of the stream |

Shape: the SSE handler is one scoped Effect. `Effect.addFinalizer` ends
`reply.raw` (idempotent), so terminal, shutdown, disconnect and defects all
close the stream the same way; the keepalive fiber is forked into that
scope and dies with it.

Wire format per message:

```
event: status
id: 2026-10-22T10:00:12.000Z
data: {"name":"functions/report-generator/runs/019a...","state":"RUNNING",...}

```

(two trailing newlines end a message; docs/API.md:442-456 shows a full
transcript.)

## 4. Shutdown interaction (P3.7, P5.1, P5.2)

Gateway SIGTERM order (SPEC.md:1166-1170, D30 SPEC.md:1471,
PLAN.md:432-441, docs/STACK.md 4.1). `NodeRuntime.runMain` turns SIGTERM
into interruption of the main fiber; `Layer.launch` closes the scope and
the listener layers' releases run:

1. `/readyz` returns 503: `Ref.set` the readiness state to draining.
   `/v1` and `/internal/v1` keep serving normally and never answer
   `NOT_READY` during the drain (docs/API.md:342,
   docs/INTERNAL-API.md:286).
2. Keep serving for `KRUN_SHUTDOWN_DELAY` (default `5s`, SPEC.md:1203):
   `Effect.sleep` on the configured `Duration`, so `TestClock` can drive it.
   A fixed sleep, not a resettable quiet period (see the knative lesson in
   SKILL.md). Steps 1 and 2 run once per process, shared by the three
   releases (SKILL.md pitfalls).
3. Complete the `shuttingDown` `Deferred`: every SSE handler ends its
   stream (SPEC fixes no shutdown event name; closing without a terminal
   `state` event is explicitly fine for the client, SPEC.md:256-258) and
   every pending `wait` answers with the current row (section 2, wake-up
   (c)).
4. Close the listener: `app.close()` under `Effect.promise`. Fastify's
   `close()` waits for in-flight requests and does not end hijacked
   streams, which is why step 3 comes first (or runs from `preClose`).
5. The subscribe fiber is interrupted with the public layer's scope; the
   database pool, acquired before the listeners, is released after them,
   so step 3 can still read the current state. runMain exits 0 on an
   interrupt-only exit.

No hand-kept sets of responses or resolvers are needed: the `Deferred` is
the broadcast, and each handler's own scope ends its stream. All of this
fits in the 30 s termination grace (SPEC.md:1174, SPEC.md:1238).

## 5. Tests the handlers must pass

Write them with `@effect/vitest` (`it.effect` (already scoped)), the app built
inside the test so handlers see `TestClock`, Fastify `inject` under
`Effect.promise` (SSE tests may need a real listen on port 0 to read the
stream incrementally).

- P5.1 (PLAN.md:628-630): a fake store emitting a transition resolves the
  wait; `WaitRun` returns the run at timeout without error
  (`TestClock.adjust` past the timeout); SIGTERM ends the wait early
  (complete the shutdown `Deferred`, or close the layer's scope).
- P5.2 (PLAN.md:634-637): a client reads a `state` event, a `status` event,
  then EOF; `data` has no `input`; terminal-at-connect yields one message
  then EOF.
- Phase 5 gate (PLAN.md:618-622): e2e `CreateRun?wait=30s` returns 201 with
  `state: SUCCEEDED` and the inline `result`; `POST ...:wait` on the same
  run returns 200 with the same terminal run.
