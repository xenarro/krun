# `test/sdk-conformance` (P8.3)

Source of truth: PLAN.md:791-798. One scenario table, read by both SDK test
suites, that pins the exact request sequence an SDK must produce. Its job is
to make the Node and Python SDKs indistinguishable on the wire. Reordering
one SDK's calls must fail that SDK's suite.

## Layout

```
test/sdk-conformance/
  scenarios.json        the table (data only, no code)
  README.md             matcher grammar and how to add a scenario
packages/sdk-node/src/conformance.test.ts     loads ../../../test/sdk-conformance/scenarios.json
sdk/python/tests/test_conformance.py          loads the same file
```

Each suite ships its own handler fixtures keyed by name (`echo`, `void`,
`throws`, `status_then_return`, `two_status`, `big_result`, `slow`, ...);
the table names the fixture, never contains code.

## Scenario shape

```json
{
  "name": "status then heartbeat",
  "handler": "status_then_return",
  "env": { "KRUN_HEARTBEAT_TIMEOUT": "3", "KRUN_MAX_RESULT_BYTES": "262144", "upload": false },
  "input": { "n": 1 },
  "responses": {
    "GET input": [ { "status": 200, "body": { "n": 1 } } ],
    "POST status": [ { "status": 204 } ],
    "PUT result": [ { "status": 204 } ]
  },
  "expect": {
    "requests": [
      { "method": "GET", "path": "/internal/v1/runs/{run}/input" },
      { "method": "POST", "path": "/internal/v1/runs/{run}/status", "body": { "message": "loading", "progress": 0.1 } },
      { "method": "POST", "path": "/internal/v1/runs/{run}/status", "body": { "message": "loading", "progress": 0.1 } },
      { "method": "PUT", "path": "/internal/v1/runs/{run}/result", "body": { "rows": 42 } }
    ],
    "exitCode": 0,
    "minGapMs": [ [1, 2, 900] ]
  }
}
```

- `responses` are consumed in order per route; the last entry repeats.
  An entry may be `{ "hang": true }` to simulate a never-answering gateway
  (for the 10 s / 3 s timeout cases; scale timeouts down only through an
  SDK test hook, never a public option).
- `expect.requests` is the **ordered** list of requests to the fake, with
  `{run}` substituted. A request entry may carry `"body"` (deep-equal after
  JSON parse), `"bodyBytesMax"`, or `"headers"` (subset match, e.g.
  `User-Agent` prefix `krun-sdk-`).
- `minGapMs: [[i, j, ms]]` asserts request j arrived at least `ms` after
  request i (used for the 1 s send gate). Keep tolerances wide (900 ms for
  a 1 s gate) so CI jitter does not flake.
- Upload requests go to a second fake listener; the scenario marks them
  `"target": "upload"`.

## Matcher rules

- Order is strict for the requests listed. Extra heartbeat ticks are the
  usual flake: either pick `KRUN_HEARTBEAT_TIMEOUT` and handler timing so
  the count is deterministic, or mark a request `"repeat": "1+"` meaning
  one or more identical consecutive requests.
- Bodies compare parsed JSON, never bytes (key order and whitespace differ
  between languages).
- Headers: the `Authorization` header carrying the per-run token (scheme Bearer) must be present on every
  internal call and **absent** on the upload (docs/INTERNAL-API.md:217-219).

## Required scenarios (PLAN.md:792-797 plus the P8.1 matrix)

| Scenario | Asserts |
|---|---|
| success | GET input, PUT result, exit 0 |
| void handler | GET input, no result request, exit 0 |
| `ctx.status("loading", 0.1)` then one heartbeat | two identical status bodies |
| two immediate `ctx.status` calls | two requests at least 1 s apart |
| 429 on status | the pending payload is re-sent at the next slot, not retried immediately |
| no eager started | first status request is a heartbeat tick, body `{ "message": "started" }` |
| slow result write | heartbeats continue while PUT result is pending |
| result above cap with upload URL | upload PUT with `Content-Length`, no `Authorization`, no SetResult |
| upload 403 | SetError type `ResultWriteError`, exit 1 |
| result above cap, no upload URL | SetError `ResultWriteError`, exit 1 |
| thrown error | SetError with type, message, `details.stack` (at most 20 lines), exit 1 |
| oversized status | message truncated to 1024 bytes, data omitted |
| oversized error | message 4096, type 128, stack dropped from the end to fit 8192 |
| 503 then 204 on GET input | one retry after about 1 s |
| hanging GET input | timeout then retry |
| 401 on status | process exits 1, no further requests |
| User-Agent | `krun-sdk-node/<v>` or `krun-sdk-python/<v>` on every internal call |

Local-mode stream separation is not a wire scenario; keep it as a per-SDK
unit test (stdout holds only the result, stderr holds log and status lines).

## Proving the table bites

Acceptance requires that reordering one SDK's calls fails its suite
(PLAN.md:797-798). Add a self-test: run the matcher against a recorded
sequence with two requests swapped and assert it reports a mismatch.
Do not leave a deliberately broken SDK branch in the tree.

## Running

- Node: `node --test packages/sdk-node/src/conformance.test.ts` spawns the
  fixture as a child process (`process.execPath`) against
  `http.createServer` fakes bound to `127.0.0.1:0`.
- Python: `uv run --directory sdk/python pytest tests/test_conformance.py`
  spawns `sys.executable` with the fixture module.
- Both use real time with small `KRUN_HEARTBEAT_TIMEOUT` values (3 s gives
  1 s ticks); fake timers do not cross a process boundary.
- `make test` runs both (PLAN.md:120-121).
