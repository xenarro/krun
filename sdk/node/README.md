# @krun/sdk

Dependency-free Node.js 22+ function runtime for the krun internal v1 HTTP contract.
Importing the package does not execute a handler. Call `run(handler)` once from
an entrypoint; it terminates the process with the handler/result outcome.

```js
import { run } from "@krun/sdk";

run(async (input, ctx) => {
  await ctx.status("loading", 0.1);
  ctx.log({ event: "loaded" });
  return { rows: 42 };
});
```

`ctx` exposes `runId`, `function`, `status(message, progress?, data?)` and
`log(value)`. The exported `Context` and `Handler` TypeScript types describe
that surface; no Effect, schema package or other runtime dependency is loaded.

In a Job the scheduler supplies the run environment. The runtime fetches input,
then invokes the handler. A non-null result goes inline up to the configured
byte cap or to the supplied presigned upload URL above it. Uploads have an exact
Content-Length and no bearer authorization or checksum header. A failed result
write reports `ResultWriteError` before exiting 1. Thrown errors are reported
before exit 1; a null/undefined return sends no result and exits 0. Any 401 or
SIGTERM exits 1. Diagnostics never print transport URLs, response bodies or
credentials. Explicit `ctx.log` writes one JSON line to stdout in a Job.

Status messages and errors are truncated by compact JSON UTF-8 byte length,
including escaping and quotes. Oversized/non-serializable status data is omitted.
One monotonic, non-overlapping gate sends the latest status at most once per
second; superseded pending values coalesce. `ctx.status` never rejects and waits
at most three seconds, including queue time. A queued payload may remain pending
after that bounded wait. A 429 keeps it pending for the next slot; other failed
attempts are dropped. The initial `started` status is not sent eagerly.

When configured, an unref heartbeat re-sends the entire last status every third
of the heartbeat window, starting before input fetch and continuing through
result/error retries. Long windows use bounded timer chunks with a monotonic
deadline so Node cannot clamp them into eager one-millisecond pings.
A synchronous CPU-bound handler can starve timers; move
such work off the event loop. Terminal completion drops pending status and
aborts its active request. The heartbeat does not keep a completed process alive.

GetInput/SetResult/SetError use ten-second per-attempt bounds and three retries
at 1/2/4 seconds for connection failures, timeouts and 5xx only. Upload uses a
300-second bound with the same retry policy. Status makes one three-second
attempt; it has no immediate transport retry. No HTTP redirects are followed.

## Local mode

Without `KRUN_GATEWAY_URL`, input is JSON from the first file argument or stdin.
Only the non-null result goes to stdout; `ctx.log`, `ctx.status` and errors go to
stderr. Local context defaults to `runId: "local"` and the entrypoint basename
for `function` (overridable by the corresponding environment fields). No network
is used. Null/undefined returns produce no stdout. Local mode is a one-shot
function runner, not a gateway emulator.

Build with `pnpm --filter @krun/sdk build`; run the SDK tests with
`node node_modules/vitest/vitest.mjs run --project sdk-node sdk/node` after the
build. The HTTP/process suite runs the built artifact on both Node 22 and 26 in
CI. Package archives include only the production `dist` files, package metadata
and this README; packing is local and does not publish anything.
