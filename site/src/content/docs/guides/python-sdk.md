---
title: Using the Python SDK
description: Write, test and package a krun function with the dependency-free Python 3.11+ SDK.
sidebar:
  order: 3
---

The Python SDK implements the krun internal v1 HTTP contract with the standard
library only. It requires Python 3.11 or newer and has no runtime dependencies.
Installing or importing it never executes a handler.

:::caution[Do not run pip install krun]
`krun` is the planned PyPI project name, but the SDK is **not published**. A PyPI
project named `krun` already exists (as of the 2026-10-24 check), and whether this
project controls it is unverified. Until the owner resolves that and the first release
ships, build the wheel from a checkout and install it from your
project's `vendor/` directory.
:::

## Install from a checkout

```sh title="In the krun checkout"
uv build sdk/python --wheel --out-dir /tmp/krun-sdk-wheel
```

```sh title="In your function project"
mkdir -p vendor
cp /tmp/krun-sdk-wheel/krun-*.whl vendor/
uv add ./vendor/krun-*.whl
```

Keep the resulting `uv.lock`: the Dockerfile that `krun init` generates uses a locked
install when the lock file exists, and copies the whole project, including `vendor/`,
before installing.

## The handler

```python title="handler.py"
from krun import run


def handle(input, ctx):
    ctx.status("loading", 0.1)
    ctx.log({"stage": "compute"})
    return {"rows": 42}


if __name__ == "__main__":
    run(handle)
```

`run` is a plain call, not a decorator. It invokes a **synchronous** handler once and
exits; it never returns. Importing `handler` in tests does not start the SDK.

## API

The package exports `run`, `Context` and `Handler`.

```python title="krun"
Handler = Callable[[object, Context], object]

def run(handler: Handler) -> NoReturn: ...

class Context:
    runId: str
    function: str
    def status(
        self, message: str, progress: float | None = None, data: object = None
    ) -> None: ...
    def log(self, value: object) -> None: ...
```

| Member | Behavior |
|---|---|
| `ctx.runId` | The run id from `KRUN_RUN_ID`; `"local"` in local mode unless set. |
| `ctx.function` | The function name from `KRUN_FUNCTION`; the script's file name in local mode unless set. |
| `ctx.status(message, progress=None, data=None)` | Replaces the latest report. `progress` must be finite and within 0 to 1; `data` must be a JSON object. Waits at most three seconds and never raises. |
| `ctx.log(value)` | Writes one JSON line: to stdout in a function pod and to stderr locally. |

Status messages, data and exception fields are bounded by their compact JSON UTF-8
size; invalid or oversized data is omitted with a diagnostic.

## What `run` does in a Job

The scheduler supplies `KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`,
`KRUN_TOKEN` and `KRUN_MAX_RESULT_BYTES`, and optionally `KRUN_HEARTBEAT_TIMEOUT` and
`KRUN_RESULT_UPLOAD_URL`. The SDK then:

1. Fetches the input and calls your handler.
2. Stores a non-`None` JSON result inline when it fits the cap, or uploads it to the
   presigned URL with an exact `Content-Length`, no bearer or checksum headers and no
   redirects. A missing or rejected upload, or a rejected inline result, reports
   `ResultWriteError` and exits 1.
3. Exits 0 when the handler returns `None`.
4. On an exception, reports its type, a bounded message and up to 20 stack lines, then
   exits 1.
5. Exits 1 immediately on any 401, including from a heartbeat, and on SIGTERM.

### Status and heartbeats

One condition-driven daemon thread serializes status requests, coalesces pending
updates, spaces attempts at least one second apart and keeps a 429'd payload for the
next slot. No eager `started` request is sent. When a heartbeat window is set, the
thread re-sends the latest payload every third of it, including while fetching input
and writing a result or error.

:::caution[The GIL can starve heartbeats]
Native code that holds the GIL can starve the heartbeat thread. Set
`heartbeatTimeout` longer than the longest such gap.
:::

### Timeouts and retries

- Input, result and error requests use a 10-second timeout; status uses 3 seconds;
  the upload uses 300 seconds.
- Each attempt runs the standard-library `urllib` request in a short-lived owned
  subprocess with a monotonic deadline covering startup, DNS, connect, send, headers
  and body. On expiry it is killed and reaped before any retry.
- Input, result, error and upload retry connection failures, timeouts and 5xx three
  times, after 1, 2 and 4 seconds. Status is one attempt. Other HTTP failures are not
  retried, and redirects are never followed.
- Diagnostics never print URLs, response bodies or credentials.
- Every request sends `User-Agent: krun-sdk-python/<version>`.

## Local mode

Without `KRUN_GATEWAY_URL`, the SDK reads the input from the file named by the first
argument, or from stdin. Only a non-`None` result goes to stdout; status, logs and
bounded errors go to stderr. Handler exceptions and results that are not valid JSON
exit 1. Non-finite numbers are not JSON and fail serialization in both modes.

```sh title="Terminal"
printf '%s\n' '{"name":"world"}' | uv run python handler.py
uv run python handler.py input.json
```

:::danger[Never set KRUN_GATEWAY_URL on a workstation]
`KRUN_GATEWAY_URL` switches the SDK into in-Pod mode. Leave it unset for local runs
and tests. Local mode is a one-shot runner, not a gateway emulator.
:::

## Testing

The project from `krun init --lang python` includes three pytest tests in
`tests/test_handler.py`: a direct call of `handle` with a fake context, a subprocess
run in local mode with every `KRUN_*` variable removed, and a check that importing
`handler` performs no network I/O.

```sh title="Terminal"
uv sync
uv run pytest
```

## Packaging

The generated Dockerfile copies `uv` 0.13.1 into a digest-pinned
`python:3.13.15-slim-bookworm` build stage, runs `uv sync` without development
dependencies (`--locked` when `uv.lock` exists), and produces a runtime image that
sets `HOME=/tmp`, disables bytecode writes, uses unbuffered output, runs as
`65532:65532` and starts `python handler.py`. The Python project is named
`krun-function-<name>` to avoid a self-dependency when a Function is called `krun`.

Deploy it with [`krun deploy`](/krun/guides/cli/#ship-it-with-krun-deploy). The complete package
reference is mirrored at [Python SDK reference](/krun/reference/generated/python-sdk/).
