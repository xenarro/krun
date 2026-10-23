# `run()` sequence: state machine, timeouts, retries, exit codes

Source of truth: SPEC.md:686-729 and docs/INTERNAL-API.md sections 3-5 and
7 (lines 106-263, 291-306). Same behaviour in `packages/sdk-node` and
`sdk/python/krun`; language notes at the end.

## 1. Environment (SPEC.md:687-690)

| Variable | Type as read | Meaning | Absent |
|---|---|---|---|
| `KRUN_RUN_ID` | string | run id, path segment of every call | required in cluster mode |
| `KRUN_FUNCTION` | string | exposed as `ctx.function` | required in cluster mode |
| `KRUN_GATEWAY_URL` | string | base, calls go to `$KRUN_GATEWAY_URL/internal/v1/runs/$KRUN_RUN_ID/...` | unset = local mode (SPEC.md:723) |
| `KRUN_TOKEN` | string | `Authorization: Bearer <token>` on gateway calls only | required in cluster mode |
| `KRUN_MAX_RESULT_BYTES` | decimal string → int | inline result cap (SPEC.md:613) | treat as default 262144 (docs/INTERNAL-API.md:313) |
| `KRUN_HEARTBEAT_TIMEOUT` | decimal seconds string → int | heartbeat window (SPEC.md:614) | no heartbeat timer |
| `KRUN_RESULT_UPLOAD_URL` | string | presigned PUT (SPEC.md:612) | over-cap result is `ResultWriteError` |

Missing required variables in cluster mode: write one line to stderr and
exit 1; there is nothing to report to.

## 2. Headers on every gateway call

- `Authorization: Bearer <KRUN_TOKEN>` (SPEC.md:628-629).
- `User-Agent: krun-sdk-node/<version>` or `krun-sdk-python/<version>`
  (SPEC.md:729). Version comes from the package's own metadata, stamped by
  `release.yml` (PLAN.md:196-198).
- `Content-Type: application/json` on POST/PUT (415 otherwise,
  docs/INTERNAL-API.md:283).
- Never on the presigned upload: no `Authorization`
  (docs/INTERNAL-API.md:218-219).

## 3. State machine

```
S0  read env; local mode → section 6
S1  GET input            10 s/attempt, retry 3 (1 s, 2 s, 4 s) on connect error, timeout, 5xx
                         401 → exit 1; other 4xx → log, PUT error? no: log and exit 1 (caller bug)
S2  start heartbeat      only if KRUN_HEARTBEAT_TIMEOUT set; interval = window/3 s; unref/daemon
S3  call handler(input, ctx)
      ctx.status(m, p?, d?) → latest = truncate({message:m, progress:p, data:d}); gate.kick()
      ctx.log(obj)          → one JSON line on stdout
S4a handler returned undefined/null/None → S6 (no result request)
S4b handler returned v → bytes = compactJSON(v)
      bytes.length <= KRUN_MAX_RESULT_BYTES → PUT result (10 s, retry 3) → 204 → S6
                                            → 401 → exit 1
                                            → exhausted/other → S5(ResultWriteError)
      bytes.length >  KRUN_MAX_RESULT_BYTES → no upload URL → S5(ResultWriteError)
                                            → PUT upload URL (300 s; retry 3 on connect/5xx; 4xx no retry)
                                              → 200 → S6 ; else → S5(ResultWriteError)
S4c handler threw e → S5(e)
S5  PUT error {type, message, details:{stack}} truncated (limits.md), 10 s, retry 3; then exit 1
    (whatever the PUT outcome; log it)
S6  stop heartbeat, drop status gate, exit 0
Any SIGTERM → exit 1 immediately (SPEC.md:718). Any 401 → exit 1 (docs/INTERNAL-API.md:258-262).
```

Notes:

- `PUT error` in S5 for a thrown error uses the error's type name
  (`err.constructor.name` / `type(exc).__name__`), `String(err.message)`,
  and `details.stack` = first 20 lines of the stack (SPEC.md:708-710). For
  `ResultWriteError` the message is the cause (status code or error text);
  log the cause too (SPEC.md:706-708).
- The result or error call must have *returned* before exit; the exit is
  what the scheduler reacts to (docs/INTERNAL-API.md:250-252).
- Backoff is fixed 1 s, 2 s, 4 s (docs/INTERNAL-API.md:295); no jitter is
  specified, do not add configuration for it.

## 4. Status gate and heartbeat (SPEC.md:690-702)

```
latest   = { message: "started" }         # never posted eagerly
lastSent = -inf
pending  = false
closed   = false                           # true once result/error call returned

ctx.status(...)  → latest = truncated payload; pending = true; schedule()
heartbeat tick   → pending = true; schedule()        # re-sends latest as is
schedule()       → if closed: return
                   if now - lastSent >= 1 s: send()
                   else: arm a one-shot timer for (lastSent + 1 s), unref'd
send()           → pending = false; POST status latest, 3 s timeout, one attempt
                   204 → lastSent = now
                   429 → pending = true (re-sent at the next slot, >= 1 s later)
                   401 → exit 1
                   other 4xx, timeout, connect error → log and drop
close()          → closed = true; clear timers
```

- Heartbeat interval: `KRUN_HEARTBEAT_TIMEOUT / 3` seconds, first tick one
  interval after `run` started, until `close()` (SPEC.md:694-697). The run
  window is measured from pod `Running`, so start-up work counts
  (docs/INTERNAL-API.md:155-158); do not wait for the handler to call
  `ctx.status` before ticking.
- `ctx.status` blocks at most 3 s and never throws (SPEC.md:700-702). In
  Node it returns a promise that always resolves; in Python it returns
  `None` and swallows every exception.
- A tick while a send is in flight sets `pending` and does nothing else.
- Unit-test with fake timers (`mock.timers` with `Date` enabled); the
  subprocess conformance scenarios use `KRUN_HEARTBEAT_TIMEOUT=3` (1 s
  ticks) and real time with tolerance (conformance.md).

## 5. Exit codes

| Situation | Exit | Source |
|---|---|---|
| handler returned, result accepted or nothing to return | 0 | SPEC.md:702-708 |
| handler threw; error reported (or report failed) | 1 | SPEC.md:708-710 |
| result write failed after retries / over cap without upload URL | 1 after `PUT error ResultWriteError` | SPEC.md:706-708 |
| any 401 | 1 | SPEC.md:717-718 |
| SIGTERM | 1 | SPEC.md:718 |
| missing required env in cluster mode | 1 | implied; nothing to report to |
| local mode | same codes | SPEC.md:726 |

The process must exit without waiting for the heartbeat timer
(PLAN.md:784-785): `unref()` / daemon thread, and `close()` before exit.

## 6. Local mode (SPEC.md:723-726)

- Trigger: `KRUN_GATEWAY_URL` unset. No network at all.
- Input: file named by the first argument (`process.argv[2]`, `sys.argv[1]`),
  else all of stdin, parsed as JSON.
- `ctx.runId`: `"local"`; `ctx.function`: `KRUN_FUNCTION` or the handler
  file's base name. (SPEC does not fix these; keep them stable and document
  them in the template README.)
- `ctx.status` and `ctx.log`: one JSON line each on stderr.
- Result: compact JSON of the return value on stdout, nothing for
  `undefined`/`null`/`None`. No truncation to `KRUN_MAX_RESULT_BYTES` is
  specified locally; keep stdout exactly the result.
- Thrown error: the error JSON (same shape as `PUT error`) on stderr, exit 1.
- Never writes files; never touches `function.yaml`.

## 7. Node specifics (`packages/sdk-node`)

- ESM, `"type": "module"`, built to `dist/` for publishing
  (node-stack-facts.md:99-104); tests `*.test.ts` next to the source run on
  the sources with `node --test`.
- HTTP: global `fetch` with `signal: AbortSignal.timeout(ms)`; a timeout is
  a `DOMException` named `TimeoutError`; connection failures are
  `TypeError: fetch failed` with a `cause`. Classify both as retryable.
- Body: `JSON.stringify(value)` (compact); `Buffer.byteLength(str)` for the
  byte count; upload via `fetch(url, { method: 'PUT', body: Buffer,
  headers: { 'content-type': 'application/json', 'content-length': String(n) } })`
  so the body is not chunked (docs/INTERNAL-API.md:217-218).
- Heartbeat: `setInterval(tick, ms).unref()`; gate timer
  `setTimeout(...).unref()`.
- `process.on('SIGTERM', () => process.exit(1))` registered at `run` start.
- Exit with `process.exit(code)` only after the final gateway call has
  returned; never `process.exit` inside a `finally` that could run before
  `await`.
- `ctx.log(obj)`: `process.stdout.write(JSON.stringify(obj) + "\n")` in the
  pod, `process.stderr.write` locally.
- Node 20+ API surface only (SPEC.md:660).

## 8. Python specifics (`sdk/python/krun`)

- Package `krun`, module `krun/__init__.py` exporting `run`; layout
  `sdk/python/krun/` (PLAN.md:97); `requires-python = ">=3.11"`
  (SPEC.md:661); tooling `uv`, `ruff`, `pytest` (PLAN.md:45); stdlib only.
- HTTP: `urllib.request.Request(url, data=body, method="PUT", headers=h)`,
  `urllib.request.urlopen(req, timeout=10)`. `HTTPError` first (has
  `.code`), then `URLError`/`TimeoutError` as connection failures
  (node-stack-facts.md:815-821, UNVERIFIED in that report, stdlib-stable).
- Body: `json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()`;
  the byte length is `len(body)`. `urllib` sets `Content-Length` for a
  `bytes` body; set `Content-Type` yourself.
- Heartbeat: `threading.Thread(target=loop, daemon=True)` with
  `threading.Event().wait(interval)`; `close()` sets the event. The gate's
  one-shot delay can reuse the same thread (sleep until the slot).
- `signal.signal(signal.SIGTERM, lambda *_: os._exit(1))`; use `os._exit`
  so a blocked main thread cannot delay it.
- Handler may be sync or a coroutine function: if
  `inspect.iscoroutinefunction(handle)`, run it with `asyncio.run`.
- `ctx.log(obj)`: `sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()`
  in the pod, stderr locally. Flush: the pod's log tail is read after exit
  (SPEC.md:720-721 "so logTail stays readable").
- `if __name__ == "__main__": run(handle)` in the template; importing the
  module executes nothing (PLAN.md:790).
