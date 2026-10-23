---
name: krun-sdk-cli
description: Use when building krun SDKs, krun init or krun deploy. Zero-dependency run(), heartbeat, local mode, conformance table, templates.
---

# krun SDKs and CLI (`@krun/sdk`, Python `krun`, `krun init`, `krun deploy`)

Covers SPEC.md section 7.1 (the two function SDKs) and 7.2 (`krun init`
templates and `krun deploy`), plus the shared `test/sdk-conformance` table.
Serves PLAN tasks P8.1-P8.7. `krun validate` (P2.5) belongs to
`krun-functions-crd`; this skill only packages it into `@krun/cli`.

## When to use

- Writing or changing `packages/sdk-node` (`run()`, context, local mode) or
  `sdk/python/krun` (same contract on `urllib.request` and a daemon thread).
- Writing `test/sdk-conformance` scenarios or wiring a suite to them.
- Writing `packages/cli/templates/{node,python}` or the `init`/`deploy`
  subcommands in `packages/cli/src`.
- Debugging a function pod that is failed as `heartbeat_timeout`, loses its
  result, or exits 0 with an error report.

Not here: the gateway side of `/internal/v1` (`krun-gateway-api`), Function
validation rules (`krun-functions-crd`), the kind e2e harness and release
workflow (`krun-testing-ci`), presigned URL creation (`krun-webhooks-objstore`).

## Read first

- SPEC.md:628-640 pod contract; SPEC.md:658-729 section 7.1 (`run()` order
  686-721, local mode 723-726, versioning 728-729); SPEC.md:731-772 section
  7.2 (`init` 733-750, `deploy` 752-763, packaging 770-772).
- SPEC.md:299-318 internal API summary; docs/INTERNAL-API.md is normative:
  endpoints 106-206, upload 208-232, container view 234-263, retries
  291-306, limits 308-324.
- SPEC.md:19-24 non-goals (no SDKs beyond Node and Python, no local gateway
  emulator); SPEC.md:1413-1416 one SemVer version per tag; D20 and D24
  (SPEC.md:1461, 1465).
- PLAN.md:758-825 Phase 8 tasks and acceptance; PLAN.md:38-45 toolchain;
  PLAN.md:73-74 "the SDKs have no runtime dependencies"; PLAN.md:93-97, 110
  layout; PLAN.md:118-123 `make test` runs `uv run --directory sdk/python pytest`.
- References here: `references/run-sequence.md` (the `run()` state machine
  with timeouts, retries and exit codes, Node and Python specifics),
  `references/limits.md` (byte limits per field and truncation rules),
  `references/templates.md` (every file `krun init` writes per language),
  `references/deploy.md` (`krun deploy` steps, flags, env, printed commands,
  wait rule, digest extraction, error hints), `references/conformance.md`
  (design of the `test/sdk-conformance` table).

## Rules

1. `run(handler)` is a plain call that never returns, never a decorator, so
   tests import `handle` without executing it (SPEC.md:686-687, PLAN.md:787-790).
2. No runtime dependencies in either SDK: Node uses global `fetch`,
   `AbortSignal.timeout`, `node:fs`, `node:process`; Python uses
   `urllib.request`, `threading`, `json`, `sys` (SPEC.md:662-663,
   PLAN.md:73-74). `package.json` lists no `dependencies` (PLAN.md:783-784).
3. Read env in this order and nothing else: `KRUN_RUN_ID`, `KRUN_FUNCTION`,
   `KRUN_GATEWAY_URL`, `KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`,
   `KRUN_HEARTBEAT_TIMEOUT`, `KRUN_RESULT_UPLOAD_URL` (SPEC.md:687-690);
   `KRUN_GATEWAY_URL` unset means local mode (SPEC.md:723).
4. Never post `started` eagerly: the initial payload `{ message: "started" }`
   leaves the SDK only through a heartbeat tick (SPEC.md:690-692) because the
   gateway's rate window starts at the last 204 (docs/INTERNAL-API.md:143-149).
5. One send gate for status: latest payload wins, at most one POST per
   second, stays pending after a 429, dropped once the result or error call
   has returned (SPEC.md:692-694, PLAN.md:766-768).
6. `ctx.status` is one attempt, 3 s timeout, never throws; 4xx, 429 and
   timeouts are logged and dropped (SPEC.md:700-702,
   docs/INTERNAL-API.md:297-300) because the next tick is the retry.
7. Heartbeat only when `KRUN_HEARTBEAT_TIMEOUT` is set: re-post the latest
   payload every third of the window from the start of `run` until the result
   or error call returned, from a timer that never keeps the process alive
   (`setInterval(...).unref()`, daemon thread) (SPEC.md:694-699,
   docs/INTERNAL-API.md:153-160). The window also covers result writing.
8. `KRUN_HEARTBEAT_TIMEOUT` is an integer number of seconds (SPEC.md:614),
   `KRUN_MAX_RESULT_BYTES` a decimal byte count; both arrive as strings.
   Never parse the `5m` duration grammar in the SDK; the scheduler converts.
9. Return `undefined`/`null`/`None`: no result request, exit 0
   (SPEC.md:702-703, docs/INTERNAL-API.md:177-179). Any other value: compact
   JSON, `PUT result` when it fits `KRUN_MAX_RESULT_BYTES`, else upload to
   `KRUN_RESULT_UPLOAD_URL` (SPEC.md:703-706).
10. Upload: raw JSON bytes, `Content-Type: application/json`,
    `Content-Length`, no `Authorization`, no checksum header, 300 s timeout;
    4xx (including 403 expired) is not retried; 5xx and connection errors
    retry 3 times at 1 s, 2 s, 4 s (docs/INTERNAL-API.md:214-224).
11. A failed result write after retries, or a result above the cap with no
    upload URL: log the cause, `PUT error` type `ResultWriteError`, exit 1
    (SPEC.md:706-708, docs/INTERNAL-API.md:231-232, 250-252). Call `SetError`
    before exiting, while the token still works.
12. Thrown error or exception: `PUT error` with the error type (constructor
    name / class name), the message, and the first 20 stack lines as
    `details.stack`, then exit 1 (SPEC.md:708-710).
13. Truncate before sending, measured as compact JSON UTF-8 bytes on
    character boundaries: status `message` 1 KB, `data` omitted and logged
    over 4 KB, error `message` 4 KB, `type` 128 bytes, drop `details.stack`
    lines from the end until `details` fits 8 KB (SPEC.md:710-715). Table in
    `references/limits.md`.
14. `GetInput`, `SetResult`, `SetError`: 10 s per attempt, 3 retries with
    1 s, 2 s, 4 s backoff on connection errors, timeouts and 5xx only
    (SPEC.md:715-717, docs/INTERNAL-API.md:293-296). Other 4xx is a bug: no
    retry.
15. A 401 on any call, including a status report, ends the process with
    exit 1; so does SIGTERM (SPEC.md:717-718, docs/INTERNAL-API.md:258-262).
16. Exit code is the truth: 0 success, anything else failure
    (SPEC.md:639); an error report plus exit 0 still `SUCCEEDED`
    (docs/INTERNAL-API.md:204-206).
17. `ctx` exposes exactly `runId`, `function`, `status(message, progress?,
    data?)`, `log`; `ctx.log` writes one JSON line to stdout in the pod
    (SPEC.md:719-721). No other surface (PLAN.md:31-32).
18. Local mode: input from the file named by the first argument or stdin;
    only the result on stdout (nothing for a void handler); `ctx.log` and
    `ctx.status` on stderr; same exit codes; no network (SPEC.md:723-726).
19. SDK major N speaks `/internal/vN`; send
    `User-Agent: krun-sdk-node/<version>` and `krun-sdk-python/<version>`
    (SPEC.md:728-729, D24 SPEC.md:1465). The gateway logs it, never gates on
    it (SPEC.md:308-309).
20. One workspace version per tag for the SDKs, the CLI and the templates'
    SDK pin (SPEC.md:741-742, 1413-1416); `release.yml` stamps it
    (PLAN.md:196-198). Add a test that the template pin equals the workspace
    version.
21. `krun init` writes exactly the files in SPEC.md:736-750; `krun deploy`
    does exactly the steps in SPEC.md:752-763. No extra flags (PLAN.md:31-32):
    there is no `--image`, `--no-build` or interactive prompt.
22. The CLI never reads `KRUN_GATEWAY_URL` (SPEC.md:762-763): that variable
    switches SDKs out of local mode and the templates' subprocess tests
    rely on it being unset.
23. The Dockerfile copies the whole project before installing so a packed
    SDK in `vendor/` builds unpublished; `.dockerignore` never excludes
    `vendor/`; numeric `USER 65532:65532`; read-only root filesystem safe
    (SPEC.md:743-746). The Job sets `HOME=/tmp` and mounts `/tmp`
    (SPEC.md:607, 621-625); write nowhere else.
24. `function.yaml` ships `image: REPLACE_WITH_DIGEST`, a starter
    `inputSchema`, `heartbeatTimeout: 5m` (SPEC.md:747-748); `krun validate`
    must fail on the placeholder with a clear message (PLAN.md:804-805).
25. The printed first-run curl uses the literal `$KRUN_API_KEY`
    (SPEC.md:757-758); never expand or echo the key. Never log input, result
    or status bodies from the SDK (SPEC.md:1151-1153 lists them as redacted).

## `run()` in one screen

Full state machine with retries, timers and both languages in
`references/run-sequence.md`. The shape (docs/INTERNAL-API.md:236-248):

```
read env → local? ──yes──▶ input from argv[1] or stdin → handler → result to stdout → exit
   │no
GET input (10 s, 3 retries) → start heartbeat timer (T/3, unref/daemon) → handler
   ├─ returns undefined/null/None ──────────────▶ stop timer, exit 0
   ├─ returns value ─ fits cap ─▶ PUT result ───▶ 204: stop timer, exit 0
   │                 └ over cap ─▶ PUT upload URL ▶ 200: stop timer, exit 0
   │                                 └ failure ──▶ PUT error ResultWriteError, exit 1
   └─ throws ─▶ PUT error {type, message, details.stack[≤20]} ─▶ exit 1
any 401 / SIGTERM anywhere ───────────────────────────────────▶ exit 1
```

The heartbeat timer and the status gate share one `latest` payload; a tick
posts whatever is there, including `{ message: "started" }` before the first
`ctx.status`. The gate drops everything after the result or error call has
returned, so a late tick never fires a 401 and never delays exit.

## Conformance table (P8.3)

One JSON table under `test/sdk-conformance/` lists, per scenario, the fake
gateway's scripted responses, the handler to run (by name, implemented as a
fixture in each SDK), the expected requests in order with bodies, and the
expected exit code (PLAN.md:791-798). Both suites load it, spawn the SDK as a
child process against a local `http.createServer` fake (PLAN.md:773), and
compare the recorded sequence in order; reordering one SDK's calls fails
its suite. Design, scenario list and matcher grammar in
`references/conformance.md`.

## Templates (P8.4, P8.5)

File-by-file contents, Dockerfile rules and the README loop in
`references/templates.md`. Non-negotiables: handler plus the tests SPEC
names (Node: one subprocess local-mode test; Python: a pytest importing
`handle` with a fake `ctx` plus one subprocess test, SPEC.md:736-739);
SDK dependency as a caret range at the CLI's own version (SPEC.md:740-742);
Python image `CMD ["python", "handler.py"]` (SPEC.md:739). Acceptance runs
with a packed SDK copied into `vendor/` (PLAN.md:802-803, 807-808), so the
install step must resolve from `vendor/` with no registry.

## Deploy (P8.7)

Steps, flags, env, the three printed commands, the wait rule, digest
extraction and "Try this" hints in `references/deploy.md`. Order
(SPEC.md:752-761): build → push → digest → write `image: <repo>@sha256:...`
→ `krun validate` → `kubectl apply -f function.yaml -n <ns>` → wait
`Ready=True` (120 s cap) → print curl, `kubectl logs -f`, `GetRun` curl.
`--no-apply` stops after writing the digest. Shell out to `docker` and
`kubectl`; the CLI holds no Kubernetes client and must not pull the server
packages' runtime (SPEC.md:126-127 says `validate` imports the schema only).

## Library facts (node-stack-facts.md, VERIFIED/UNVERIFIED kept)

- Node 24 strips types by default; `node --test "packages/**/*.test.ts"`
  needs no flag; `--experimental-strip-types` is gone from the docs (VERIFIED,
  node-stack-facts.md:64-77). Erasable syntax only: no enums, parameter
  properties, decorators; `.ts` extensions in relative imports; `import type`
  for types (VERIFIED, node-stack-facts.md:79-96; PLAN.md:38-41).
- Node never strips TS under `node_modules`: `@krun/sdk` and `@krun/cli`
  publish built `.js` from `dist/`; the templates and `npx @krun/cli` consume
  `dist/` (VERIFIED rule, pnpm-symlink case UNVERIFIED, node-stack-facts.md:99-104).
- `@krun/sdk` targets Node 20+ (SPEC.md:660): global `fetch` and
  `AbortSignal.timeout` exist there; do not use Node 22+ only APIs. The SDK
  does not need `undici`: global fetch is enough (node-stack-facts.md:748-751
  warns against mixing the package with the bundled fetch).
- `mock.timers.enable({ apis: ['setTimeout','setInterval','Date'] })` for
  gate and heartbeat unit tests; mock `Date` too or the 1 s gate disagrees
  with the timers (VERIFIED, node-stack-facts.md:164-173). Subprocess
  conformance runs use real time with a small `KRUN_HEARTBEAT_TIMEOUT`.
- `--test-force-exit` masks a non-unref'd heartbeat timer; do not use it in
  the SDK suite, the "exits without waiting for the timer" case must be real
  (PLAN.md:784-785; flag described node-stack-facts.md:138-139).
- Python (all UNVERIFIED, node-stack-facts.md:813-839): `urllib.request.
  Request(url, data=bytes, method='PUT', headers=...)`, `urlopen(req,
  timeout=10)`; `HTTPError` is a subclass of `URLError`, catch it first and
  read `.code`; heartbeat as `threading.Thread(target=loop, daemon=True)`
  with `Event.wait(interval)` for a clean stop; `uv build` makes sdist plus
  wheel; `uv run --directory sdk/python pytest` from the repo root; ruff
  `select = ["E","F","I","UP","B"]`.
- Layout is `sdk/python/krun/` (PLAN.md:97), not the `src/` layout `uv init
  --lib` generates; `requires-python = ">=3.11"` per SPEC.md:661 while the
  toolchain tests on 3.12 (PLAN.md:45).

## Lessons from knative/func (and dapr)

- Refuse `krun init` into a directory that already holds `function.yaml`
  or any visible file; hidden files are fine (func `pkg/functions/client.go:1557-1609`).
  After writing, re-read `function.yaml` from disk and validate it; a
  serialisation bug surfaces at init, not at deploy (`client.go:714-715`).
- Emit `# yaml-language-server: $schema=<versioned URL>` at the top of
  `function.yaml` pointing at `docs/schemas/function-v1alpha1.json`
  (SPEC.md:126), the schema generated from the same TypeBox model as the CRD
  (func `function.go:636-646`).
- Take the digest from the push, write `repo@sha256:...` with the tag
  stripped, and unit-test the four reference shapes (plain, `:tag`,
  registry with port, existing `@sha256:`) (`function.go:1040-1060`,
  `function_unit_test.go:135-186`). Write it only when the push in this
  invocation succeeded (`cmd/deploy.go:451-454`).
- func makes `--image` and `--registry` mutually exclusive (`cmd/build.go:411-415`);
  krun has no `--image` flag, so the image is always `<registry>/<name>` and
  the lesson is: do not add `--image`.
- Poll the Function every 1 s for up to 120 s and require `Ready=True` and
  `status.observedGeneration == metadata.generation`; a stale Ready from the
  previous apply is func's old-ReplicaSet problem (`pkg/k8s/wait.go:22-146`).
  Fail fast on `Ready=False` with one of the SPEC.md:154-157 reasons rather
  than burning the cap (`pkg/knative/deployer.go:257-293`).
- Progress on stderr, machine results on stdout; print a heartbeat line
  every 10 s during a silent `docker build`/`push`, users kill quiet CLIs
  (`pkg/functions/client.go:742-746`, `:812-836`).
- Wrap errors at the CLI boundary with a "Try this:" block per command;
  keep core messages terse (`cmd/errors.go`, `pkg/functions/errors.go:29-31`).
- Bind every flag to `KRUN_<FLAG>` and say `($KRUN_REGISTRY)` in its help;
  precedence default < env < flag (`cmd/root.go:64-66`, `cmd/deploy.go:684-687`).
- Inject `{docker, kubectl, fs, env, clock, stdout, stderr}` into the
  command so unit tests run the real command with fakes in a scrubbed temp
  dir (`KRUN_*` cleared) and assert on `function.yaml` re-read from disk
  (`cmd/client.go:45-54`, `pkg/testing/testing.go:332-363`).
- Stamp the CLI version at build and test that the template-pinned SDK
  version equals it (`Makefile:35-48`, `pkg/scaffolding/middleware_version.go`).
- dapr logs the incoming `User-Agent` and never gates on it
  (dapr `pkg/api/http/server.go:370-372`); krun does the same (SPEC.md:308-309).

## Pitfalls

- A heartbeat re-sends the full last status; `runtimeStatus` is replaced
  wholesale, so `{ message }` without `progress` erases progress
  (docs/INTERNAL-API.md:138-139).
- 429 on status is dropped, not retried; the gate keeps the payload pending
  for the next slot (SPEC.md:692-694). Two immediate `ctx.status` calls are
  two requests 1 s apart (PLAN.md:779-780).
- A CPU-bound synchronous handler or a GIL-holding extension starves the
  heartbeat (SPEC.md:698-699); say so in the template README.
- `KRUN_HEARTBEAT_TIMEOUT` in the pod is seconds, `heartbeatTimeout` in
  `function.yaml` is `5m`; the SDK sees `300` and ticks every 100 s.
- The input is re-serialised: compare parsed values, never bytes
  (docs/INTERNAL-API.md:113-118).
- `PUT result` after the pod is terminal is 401 and lost; a rejected
  `SetResult` must still end non-zero (docs/INTERNAL-API.md:250-254).
- `.dockerignore` with `vendor/` or a `COPY package*.json` first then
  `npm install` breaks the vendored acceptance (SPEC.md:743-745).
- `node --test` discovers `**/test/**/*.*`; keep template fixtures out of a
  directory named `test` inside the SDK package, or pass explicit globs
  (node-stack-facts.md:120-129).
- Python `logging` to stderr is fine in the pod; stdout must stay clean in
  local mode, so the SDK must never `print()` anything but the result there.
- SPEC RISK: `@krun/cli` needs the Function schema from `packages/shared`
  (SPEC.md:126-127) but `npx @krun/cli` must not pull `pg`, `kysely`,
  `@kubernetes/client-node`, `@aws-sdk/*` along. SPEC and PLAN do not say how
  (subpath export, a schema-only package, or bundling). Add a Decisions row
  or write BLOCKED; do not silently add a dependency (PLAN.md:29-30).
- SPEC RISK: SPEC.md:758 prints `kubectl logs -f -n <jobs namespace>` but
  the CLI reads only `KRUN_NAMESPACE`, `KRUN_API_URL`, `KRUN_API_KEY`,
  `KRUN_REGISTRY` (SPEC.md:752-762); the jobs namespace default is
  `krun-jobs` (SPEC.md:1196). Print the default and ask for a Decisions row
  before adding a flag or env (PLAN.md:31-32).
- Package names: `@krun/sdk`, `@krun/cli`, PyPI `krun` are owner
  preconditions with fallbacks (PLAN.md:192-195). Keep the SDK package name
  in one constant the templates read so a rename is one change; never pick
  a fallback yourself (PLAN.md:24-26).

## Before marking a task done

- Run the task's acceptance verbatim: P8.1/P8.2 the unit matrix against the
  local fake (PLAN.md:773-785, 789-790); P8.3 both suites green and a
  deliberate reordering red (PLAN.md:797-798); P8.4
  `pnpm pack` then `krun init --lang node t && cd t && mkdir vendor && cp ../krun-sdk-*.tgz vendor/ && npm install ./vendor/krun-sdk-*.tgz && npm test && docker build .`
  plus `krun validate function.yaml` failing on `REPLACE_WITH_DIGEST`
  (PLAN.md:802-805); P8.5 `uv build` then
  `krun init --lang python t && cd t && mkdir vendor && cp ../krun-*.whl vendor/ && uv add ./vendor/krun-*.whl && uv run pytest && docker build .`
  (PLAN.md:807-808); P8.6 `make e2e` (PLAN.md:816-817, harness in
  `krun-testing-ci`); P8.7 `krun deploy --registry localhost:5001` ends
  `Ready=True` with three commands, `--no-apply` leaves the cluster
  untouched (PLAN.md:821-825).
- `make check` (PLAN.md:17-18, CLAUDE.md:5); `make test` includes
  `uv run --directory sdk/python pytest` (PLAN.md:120-121).
- Branch per task id (`p8-1-sdk-node`), Conventional Commits with the
  package as scope (`feat(sdk-node): ...`, `feat(cli): ...`), PR to main,
  never push main (PLAN.md:13-22). Mark `[x]`, append
  `YYYY-MM-DD P8.x <short sha> note` to PLAN.md section 6 (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7, PLAN.md:16).
- Phase 8 gate: both `krun init` projects pass their tests and build against
  vendored SDKs; e2e runs one SDK-built function per language (PLAN.md:760-762).

## Limitations

- This skill does not define the gateway's rate window, token checks or
  413 handling; read `krun-gateway-api` and docs/INTERNAL-API.md:68-104.
- Local mode is a one-shot process, not a gateway emulator (SPEC.md:23).
- Only Node.js and Python SDKs exist; a third language is a non-goal
  (SPEC.md:23-24).
- The e2e harness, kind registry and release stamping live in
  `krun-testing-ci`; this skill names only the Phase 8 acceptance text.
