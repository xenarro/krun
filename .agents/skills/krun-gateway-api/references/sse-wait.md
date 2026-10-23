# `wait`, `WaitRun` and `WatchRun` (SSE): rules and shutdown interaction

Serves P5.1 (PLAN.md:605-610) and P5.2 (PLAN.md:611-617). SSE is written in
house on `reply.raw`; no package (PLAN.md:70-72). Everything here reads runs
through `toRun(row)` / `toRunSummary(row)` from `packages/shared/src/store`,
the only row-to-wire mappers (SPEC.md:264-265, SPEC.md:529-534).

## 1. Notify fan-out (P5.1)

- One `store.subscribe(signal)` consumer per gateway process; it yields
  `{ id, kind: "state" | "status" | "job_status" }` (SPEC.md:514). Fan out
  by run id to the waiting `wait` promises and open SSE streams.
- Postgres: `LISTEN krun_runs`, payload `<id>:<state>`; `setRuntimeStatus`
  publishes `<id>:status`, `setJobStatus` `<id>:job_status`
  (SPEC.md:344-347, SPEC.md:541). SQLite: `run_events` polled by rowid every
  1 s from `max(rowid)` at subscribe time, `from_state = to_state` rows are
  `job_status`, others `state`; runtime status reaches SSE only through the
  handler's 1 s re-read (SPEC.md:541-545).
- Both modes keep a 1 s poll fallback inside the wait and SSE handlers
  (SPEC.md:545-546): on every wake-up (notify or 1 s tick) re-read the run
  with `getRun(id)` and act on the row, never on the notify payload alone.
- `CreateRun` with `wait`: register the waiter for the run id before
  `createRun` inserts the row so no event is missed (SPEC.md:295-296,
  PLAN.md:605).

## 2. `wait` on `CreateRun` and `WaitRun`

| Rule | Source |
|---|---|
| `wait` (query on `CreateRun`) and `timeout` (body of `WaitRun`) are durations `^\d+(ms\|s\|m\|h)$`; bad grammar is 400 `REQUEST_INVALID` | docs/API.md:23-26, docs/API.md:324 |
| Cap both at `KRUN_MAX_WAIT` (default `60s`, exposed as `Function.maxWait`); `WaitRun` with no `timeout` uses the cap as default | SPEC.md:232, SPEC.md:1202, docs/API.md:83, docs/API.md:253 |
| `CreateRun` answers 201 whether the run became terminal or the wait elapsed; `WaitRun` answers 200; neither errors on timeout; the client reads `state` | SPEC.md:232-233, docs/API.md:212-217, docs/API.md:253-256 |
| The response body is the FULL `Run` as it is now | docs/API.md:123-125 |
| An idempotent replay with `wait` also waits | SPEC.md:230-231, docs/API.md:207-209 |
| Client disconnect never cancels the run; just drop the waiter | SPEC.md:296-297, docs/API.md:220-221 |
| At shutdown the server answers in-flight waits at once with the current state (still 201 / 200) | SPEC.md:233, SPEC.md:1169-1170, PLAN.md:608 |
| `WaitRun` needs scope `runs:read` and owner scoping like `GetRun` | SPEC.md:207, SPEC.md:215-217 |

Implementation shape: `waitForTerminal(id, deadline, shutdownSignal)` that
resolves on (a) a fan-out event for `id` whose re-read row is terminal, (b)
the 1 s tick finding a terminal row, (c) the deadline, (d) the shutdown
signal. Do not use Fastify `handlerTimeout` for this: the wait already has
its own deadline, and a server-level `handlerTimeout` cannot be opted out
per route (node-stack-facts.md:481-485).

## 3. `WatchRun` SSE message rules (P5.2)

Source: SPEC.md:253-258 and docs/API.md:285-295.

| Rule | Detail |
|---|---|
| Headers | `reply.hijack()` then `reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-request-id": <id> })`; headers set with `reply.header()` are not applied to `raw` writes (node-stack-facts.md:524-533) |
| First message | one `event: state` with the current BASIC run (`toRunSummary`) on connect |
| Terminal at connect | that one `state` event, then `end()` |
| Subsequent messages | one event per changed field group: `event: state`, `event: status`, `event: job_status`; `data:` is the BASIC run as one line of JSON |
| `id:` | the field's own time: `createTime` / `scheduleTime` / `startTime` / `endTime` for `state` (the read time for `CANCELLING`, which has no column); `runtimeStatus.reportTime` for `status`; `jobStatus.observeTime` for `job_status` |
| Change detection | compare the re-read row with the last sent snapshot per group (`state`, `runtime_status.at`, `job_status` minus `observedAt`); emit only when the group changed, so a 1 s poll tick without change sends nothing |
| Keepalive | `: keepalive\n\n` every 15 s |
| Close | after the terminal `state` event; on server shutdown; on client disconnect (`raw` `close` event) |
| `Last-Event-ID` | ignored; a reconnecting client gets the snapshot again; a stream ending without a terminal event is not an error |
| Never | `input`, `result`, `logTail`, `error.details` in `data` (BASIC view, docs/API.md:123-126); no Fastify serialisation of the stream |

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
PLAN.md:413-421):

1. `/readyz` returns 503 (readiness flag flipped; `/v1` and `/internal/v1`
   keep serving normally and never answer `NOT_READY` during the drain,
   docs/API.md:342, docs/INTERNAL-API.md:286).
2. Keep serving for `KRUN_SHUTDOWN_DELAY` (default `5s`, SPEC.md:1203). A
   fixed sleep, not a resettable quiet period (see the knative lesson in
   SKILL.md).
3. Close the listeners: `await Promise.all([pub.close(), internal.close(),
   admin.close()])`.
4. In a `preClose` hook on the public instance: write a final message to
   every open SSE stream, then `end()` each `reply.raw`; Fastify's `close()`
   waits for in-flight requests and does not end streams you hijacked
   (node-stack-facts.md:534-540). SPEC fixes no shutdown event name; closing
   without a terminal `state` event is explicitly fine for the client
   (SPEC.md:256-258).
5. Resolve every pending `wait` with the current row (step 2 of section 2
   above): the shutdown signal is one of the wake-ups.
6. `onClose`: abort the `subscribe` signal, close the pool, exit 0.

Keep one `Set<ServerResponse>` of active SSE streams and one
`Set<() => void>` of wait resolvers on the app instance so steps 4 and 5
are O(open streams) and need no polling. All of this fits in the 30 s
termination grace (SPEC.md:1174, SPEC.md:1238).

## 5. Tests the handlers must pass

- P5.1 (PLAN.md:608-610): a fake store emitting a transition resolves the
  wait; `WaitRun` returns the run at timeout without error; SIGTERM ends the
  wait early.
- P5.2 (PLAN.md:614-617): a client reads a `state` event, a `status` event,
  then EOF; `data` has no `input`; terminal-at-connect yields one message
  then EOF.
- Phase 5 gate (PLAN.md:598-601): e2e `CreateRun?wait=30s` returns 201 with
  `state: SUCCEEDED` and the inline `result`; `POST ...:wait` on the same
  run returns 200 with the same terminal run.
