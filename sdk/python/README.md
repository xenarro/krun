# krun Python function SDK

Python 3.11 or newer, standard library only. No runtime dependencies. The SDK
speaks `/internal/v1`; installing or importing it does not execute a handler.

```python
from krun import run


def handle(input, ctx):
    ctx.status("loading", 0.1)
    ctx.log({"stage": "compute"})
    return {"rows": 42}


if __name__ == "__main__":
    run(handle)
```

`run` is a plain call, not a decorator. It invokes a synchronous handler once and
exits; it never returns. `ctx.runId` and `ctx.function` identify the run.
`ctx.status(message, progress=None, data=None)` replaces the latest status.
Progress must be finite and within 0..1; data must be a JSON object. Status
messages, data and exception fields are bounded by compact JSON UTF-8 byte size,
including escaping. Invalid/oversized data is omitted with a diagnostic.
`ctx.log(value)` writes one JSON line.

## Local execution

Without `KRUN_GATEWAY_URL`, `python handler.py input.json` reads the named JSON
file; `python handler.py` reads stdin. Only a non-None result goes to stdout.
Status, logs and bounded errors go to stderr. A None return produces no result
and exits zero. Handler exceptions and invalid non-void JSON results exit one.
Non-finite numbers are not JSON and fail serialization in both modes.

## In a function container

The scheduler supplies `KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`,
`KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`, and optionally
`KRUN_HEARTBEAT_TIMEOUT` and `KRUN_RESULT_UPLOAD_URL`.

The SDK fetches input, invokes the handler and stores its JSON result before
exiting. Results above the inline byte cap use the presigned URL with exact
Content-Length, no bearer or checksum headers, and no following redirects.
A missing/rejected upload or rejected inline result reports ResultWriteError
and exits one. User exceptions report their type, bounded message and up to
20 stack lines, then exit one.

One condition-driven daemon thread serializes status requests, coalesces pending
updates, spaces attempts at least one second apart and retains a 429 for the
next slot. No eager `started` request is sent. When a heartbeat window is set,
the thread schedules the latest payload every third of it, including while
fetching input and writing a result/error. A status caller waits at most three
seconds and never throws; it may return while its latest payload remains queued.
Terminal completion drops queued work without joining the daemon. Native code
holding the GIL can starve heartbeat execution.

`urllib.request` timeout arguments remain 10 seconds for input/result/error,
3 seconds for status, and 300 seconds for upload. Each complete attempt also
has a monotonic deadline covering interpreter startup, DNS, connect, send,
headers and body, even when the peer continually trickles bytes. One owned
short-lived Python subprocess performs the standard-library urllib attempt;
request metadata and payloads travel through private pipes, not command-line
arguments. On deadline expiry it is killed and reaped before retrying. Terminal
completion, a 401 and SIGTERM also kill/reap outstanding attempts. This adds
one interpreter startup per attempt, included in the existing budget, rather
than leaving uninterruptible DNS or abandoned request threads running.
Input/result/error/upload retry connection failures, timeouts and 5xx three
times, after 1, 2 and 4 seconds.
Status is one attempt. Other HTTP failures are not retried or redirected.
A 401 from any request, including a heartbeat, or SIGTERM exits one immediately.
Transport diagnostics never print URLs, response bodies or credentials.

## Development and local packaging

From the repository root:

```sh
uv sync --directory sdk/python --frozen
uv run --directory sdk/python pytest
uv run --directory sdk/python ruff check .
uv run --directory sdk/python ruff format --check .
uv run --directory sdk/python mypy --strict
uv build sdk/python
```

Tests use real local HTTP listeners and child processes, including unscaled
10-second timeout/retry cases. `KRUN_TEST_PYTHON` can select a different runtime
for child consumers without changing their transport or scheduling budgets.
`make test` and `make check` include this suite. The pinned uv build backend is
build-only; wheels include the typed standard-library SDK with no runtime
dependencies. Packing is local preparation, not publication or proof of package
ownership. Shared bilingual scenarios and SDK-built Kubernetes functions are
covered by the repository's conformance and end-to-end suites.
