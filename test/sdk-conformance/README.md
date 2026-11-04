# Shared SDK wire conformance

`scenarios.json` is the single data-only table read by Vitest in
`sdk/node/src/conformance.test.ts` and pytest in
`sdk/python/tests/test_conformance.py`. Both execute `runner.ts`, the same
standard-library Node HTTP fake, against a real SDK child process. Python uses
the interpreter selected by its suite; Node uses its suite's Node executable.
The fake needs no pnpm packages. Its two listeners bind only to ephemeral
loopback ports. This is a test fixture, not a local gateway emulator.

The table contains 19 scenarios: success, void, status followed by heartbeat,
two immediate statuses, slow result with heartbeat, oversized status/error,
status 429, no eager started, heartbeat during input, upload success/retry/403,
missing upload URL, thrown error, input 503/timeout retries, status 401 and
equivalent-number upload spelling. Each suite adds a real reversed-status-call
negative control, nine native media-type controls and matcher negative controls,
for 30 cases per language. Existing per-language acceptance, local-mode stream tests,
whole-attempt deadline/resource tests and package tests remain intact.

## Table and matcher grammar

- `name` uniquely identifies the case. `handler` selects a small language-specific
  fixture; the JSON contains no code. `input` is returned by GET input.
- `env` contains SDK settings, not test clock multipliers. `upload: true` supplies
  the second owned listener as the upload URL. No credential is in the table.
- `responses` is keyed by method and endpoint (`GET input`, `POST status`,
  `PUT result`, `PUT error`, `PUT upload`). Responses are consumed per endpoint;
  its last response repeats. Defaults are input 200, upload 200, otherwise 204.
  `hang: true` leaves that response unanswered; the SDK's real 10-second input
  deadline and real 1-second first backoff are exercised.
- A response's `until: {route, count}` holds it until that many responses on
  another route finish. `releaseHandlerAfter` uses the same barrier to release a
  handler blocked on its private stdin. These are server-side event barriers,
  independent of `expect`: there are no sleeps choosing when handlers return,
  no synthetic SDK calls and no SDK clock hooks. The separate media regression
  controls intentionally alter headers at the real transport boundary in an
  isolated fixture process; ordinary wire cases do not install those hooks.
- `expect.requests` is the exact ordered list, with `method`, `path`, `target`
  (`internal` or `upload`) and `body` for every write. `{run}` represents the
  fixed fixture run id. There is no unordered/repeat/extra-request wildcard.
  Bodies compare parsed JSON recursively, including exact object key sets;
  whitespace/key order and integral-number spelling are not wire differences.
- `details: {"$stack": {"minLines", "maxLines", "detailsBytesMax"}}` is the
  only matcher. Actual details must contain exactly `stack`, a bounded array of
  strings whose complete compact JSON fits the details cap. Stack text is
  language-specific; error type/message and all other fields remain exact.
  The large Unicode vectors pin the precise truncated prefixes independently
  of either SDK's implementation. Oversized status data must be absent.
- `expect.exitCode` pins process completion. `minGapMs: [[i,j,ms]]` pins request
  spacing; 900ms is the tolerance for the real one-second send gate/backoff.
  The first timeout retry waits the native 10-second attempt, not a scaled timer.
  Its lower bound is measured from SDK process launch, not first server receipt:
  Python worker startup consumes part of the whole-attempt budget.
  `during: [[pending,ping]]` requires the ping strictly between a pending
  request's receipt and response completion. `sinceStartMs` rejects eager ticks.
- Every internal call must authenticate and use the exact SDK versioned
  User-Agent. Internal writes require normalized `application/json`; GET may
  omit Content-Type, but a supplied unsupported type fails. Parameters such as
  `charset=utf-8` are ignored exactly as by the gateway. Upload must omit
  Authorization, have a Content-Length equal to the original received Buffer
  length before UTF-8 decoding (never Node re-serialization), JSON Content-Type,
  and use neither chunking nor checksum headers. Credentials
  are generated per exercise, checked as booleans and never recorded in traces.

The heartbeat cases use a six-second SDK heartbeat window (real two-second
ticks) to leave startup headroom. Barriers make exactly one tick relevant to
handler completion or pending I/O, and the strict matcher rejects any extra
request. No operation timeout or retry policy is shortened.

## Commands

    pnpm --filter @krun/sdk build
    pnpm exec vitest run --project sdk-node sdk/node/src/conformance.test.ts
    uv run --directory sdk/python pytest tests/test_conformance.py
    make check

Python tests require the project's Node 26 toolchain for the shared fake, in
addition to Python 3.11+. CI explicitly installs the existing pinned Node version
in the Python matrix; it does not install Node SDK dependencies in that job.
The Node matrix executes its own child SDK on Node 22/26.

To see the actual ordering mutation fail, run either command from the root
(the normal suite asserts this failure; no SDK source is edited):

    node test/sdk-conformance/runner.ts node two-immediate-statuses '' swap-statuses
    node test/sdk-conformance/runner.ts python two-immediate-statuses sdk/python/.venv/bin/python swap-statuses

Each command exits 1 with `body mismatch at request 1`: two real ctx.status
calls send reversed bodies to the same fake. SDK code is not mocked. The shared
matcher additionally rejects swapped endpoints, missing/extra requests, wrong
exit codes, altered/extra body fields, bad authentication and malformed stacks.
It also accepts equivalent exponent/decimal/whitespace JSON byte spellings while
rejecting wrong declared lengths, and checks missing/invalid/parameterized media.
The native `equivalent-number-upload` case preserves both SDK implementations:
Node sends 10 bytes and Python 11 for the same parsed number, each with the
correct Content-Length. The whitespace and wrong-length checks are synthetic
matcher controls, not claims of non-compact SDK output.

For the media controls, Node wraps fetch and Python wraps the SDK request
boundary only within the disposable fixture process. Real SDK calls still use
actual HTTP/urllib and the production source remains untouched. Result, status
and error writes with `text/plain` must fail the oracle; a supplied bad GET type
also fails, including a present empty GET header (not conflated with absence).
Omitting GET media is allowed, but missing JSON media on a write is
rejected. Mixed-case JSON media with charset parameters must pass all three
write scenarios. No scenario response or observed header is forged to obtain
these results.

The runner owns detached SDK process groups, bounds each exercise at 45 seconds,
forwards SIGTERM/SIGINT, escalates cancellation to SIGKILL after two seconds,
waits for child close, clears timers, and closes all owned listeners/connections.
Those are fixture lifecycle bounds, not replacements for SDK operation budgets.

These tests use only local fixtures. Generated-project and Kubernetes integration
tests are documented in `test/e2e/README.md`; no package publication or production
resources are involved.
