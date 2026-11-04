---
title: Using the Node.js SDK
description: Write, test and package a krun function with @krun/sdk, the dependency-free Node.js 22+ runtime for the internal v1 contract.
sidebar:
  order: 2
---

`@krun/sdk` is a dependency-free Node.js runtime for the krun internal v1 HTTP
contract. It requires Node.js 22 or newer, ships ESM and CommonJS builds with
TypeScript declarations, and loads no runtime dependencies.

:::caution[Not on npm yet]
`@krun/sdk` is the planned npm package name, but it is **not published**. Until the
first release, build and pack the SDK from a checkout and install the archive from
your project's `vendor/` directory, as shown below.
:::

## Install from a checkout

```sh title="In the krun checkout"
pnpm install --frozen-lockfile
pnpm --filter @krun/sdk build
mkdir -p /tmp/krun-sdk-pack
pnpm --dir sdk/node pack --pack-destination /tmp/krun-sdk-pack
```

```sh title="In your function project"
mkdir -p vendor
cp /tmp/krun-sdk-pack/krun-sdk-*.tgz vendor/
npm install ./vendor/krun-sdk-*.tgz
```

The Dockerfile that `krun init` generates copies the whole project, including
`vendor/`, before installing dependencies, so the vendored archive also works in
the image build.

## The handler

```js title="handler.js"
import { pathToFileURL } from "node:url";
import { run } from "@krun/sdk";

export async function handle(input, ctx) {
  await ctx.status("loading", 0.1);
  ctx.log({ event: "loaded" });
  return { rows: 42 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(handle);
}
```

Importing the package never executes a handler. Call `run(handler)` once from your
entrypoint; it terminates the process with the handler's outcome. The guard above
lets tests import `handle` without starting the runtime.

## API

```ts title="@krun/sdk"
export interface Context {
  readonly runId: string;
  readonly function: string;
  status(message: string, progress?: number, data?: Record<string, unknown>): Promise<void>;
  log(value: unknown): void;
}

export type Handler<Input = unknown, Output = unknown> = (
  input: Input,
  context: Context,
) => Output | Promise<Output>;

export function run<Input = unknown, Output = unknown>(
  handler: Handler<Input, Output>,
): Promise<never>;
```

| Member | Behavior |
|---|---|
| `ctx.runId` | The run id from `KRUN_RUN_ID`; `"local"` in local mode unless set. |
| `ctx.function` | The function name from `KRUN_FUNCTION`; the entrypoint's base name in local mode unless set. |
| `ctx.status(message, progress?, data?)` | Replaces the latest status report. Never rejects, and waits at most three seconds. |
| `ctx.log(value)` | Writes one JSON line: to stdout in a Job, so `logTail` stays readable, and to stderr in local mode. |

## What `run` does in a Job

1. Reads `KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`, `KRUN_TOKEN`,
   `KRUN_MAX_RESULT_BYTES`, `KRUN_HEARTBEAT_TIMEOUT` and `KRUN_RESULT_UPLOAD_URL`.
2. Fetches the input, then calls your handler.
3. On return:
   - `undefined` or `null` sends no result and exits 0;
   - any other value is serialized as JSON and sent inline when it fits
     `KRUN_MAX_RESULT_BYTES`, otherwise uploaded to the presigned URL with an exact
     `Content-Length` and no authorization or checksum header;
   - if the result cannot be written, the SDK reports a `ResultWriteError` and exits
     1.
4. On a thrown error, reports its type, message and the first 20 stack lines as
   `details.stack`, then exits 1.
5. Exits 1 on any 401 (the run was cancelled or is over) and on SIGTERM.

### Status and heartbeats

- One gate sends the latest status at most once per second. Newer values replace
  pending ones; a 429 keeps the payload pending for the next slot, and other failed
  attempts are dropped. The initial `started` status is not sent eagerly.
- When `KRUN_HEARTBEAT_TIMEOUT` is set, an unref'd timer re-sends the entire last
  status every third of the window, from before the input fetch until the result or
  error call has returned. It never keeps a finished process alive.
- A synchronous CPU-bound handler starves timers. Keep `heartbeatTimeout` longer than
  the longest gap between event-loop turns, or move heavy work off the event loop.

### Limits, timeouts and retries

- Status messages and errors are truncated to the contract limits, measured as
  compact JSON in UTF-8 bytes. Oversized or non-serializable status data is omitted.
- Input, result and error calls use a 10-second bound per attempt and retry three
  times, after 1, 2 and 4 seconds, on connection failures, timeouts and 5xx only.
  The upload uses a 300-second bound with the same retry policy.
- Status is one three-second attempt with no immediate retry. HTTP redirects are
  never followed.
- Diagnostics never print transport URLs, response bodies or credentials.
- Every request sends `User-Agent: krun-sdk-node/<version>`.

## Local mode

Without `KRUN_GATEWAY_URL`, `run` reads the input as JSON from the first file argument
or from stdin, prints only a non-null result to stdout, and sends `ctx.log`,
`ctx.status` and errors to stderr. No network is used, and exit codes match a Job.

```sh title="Terminal"
printf '%s\n' '{"name":"world"}' | node handler.js
node handler.js input.json
```

:::danger[Never set KRUN_GATEWAY_URL on a workstation]
`KRUN_GATEWAY_URL` switches the SDK from local mode to in-Pod mode. Leave it unset
for local runs and tests. Local mode is a one-shot runner, not a gateway emulator.
:::

## Testing

The generated `handler.test.js` uses the built-in `node:test` runner. It starts
`handler.js` as a subprocess with every `KRUN_*` variable removed, pipes in
`{"name":"world"}`, and asserts exit code 0, a stdout result of `{"rows":42}`, and
the `loading` status on stderr:

```sh title="Terminal"
npm install
npm test
```

## Packaging

The generated multi-stage Dockerfile builds on a digest-pinned
`node:26.7.0-bookworm-slim` image, installs production dependencies with install
scripts disabled (`npm ci` when `package-lock.json` exists), sets `HOME=/tmp`, runs as
the numeric user `65532:65532` and starts `node handler.js`. It works with the
read-only root filesystem of a krun Job. Deploy it with
[`krun deploy`](/krun/guides/cli/#ship-it-with-krun-deploy).

The complete package reference is mirrored at
[Node.js SDK reference](/krun/reference/generated/node-sdk/).
