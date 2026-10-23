---
name: krun-sdk-cli
description: Use when building krun SDKs, krun init or krun deploy. Zero-dependency run(), heartbeat, local mode, conformance table, templates, CLI prompts (clack), colour (picocolors), docker and kubectl via tinyexec, publint and attw before publish.
---

# krun SDKs and CLI (`@krun/sdk`, Python `krun`, `krun init`, `krun deploy`)

Covers SPEC.md section 7.1 (the two function SDKs) and 7.2 (`krun init`
templates and `krun deploy`), plus the shared `test/sdk-conformance` table.
Serves PLAN tasks P8.1-P8.7. `krun validate` (P2.5) belongs to
`krun-functions-crd`; this skill only packages it into `@krun/cli` and
calls it from `deploy`.

Three different worlds, three different stacks:

| Code | Stack | Why |
|---|---|---|
| `packages/sdk-node` | plain TypeScript, no runtime dependencies, no Effect; Vitest as a dev dependency | runs inside other teams' images (docs/STACK.md principle 6) |
| `sdk/python/krun` | Python 3.11+ standard library; `uv`, `ruff`, `pytest`, `mypy --strict` for development | same reason (SPEC.md:660-663) |
| `packages/cli` | an Effect 4 program (`NodeRuntime.runMain`, services, layers, `Clock`) on Node 26, `node:util` `parseArgs`, Zod Function schema, `@clack/prompts`, `picocolors`, `tinyexec` | krun's own process (docs/STACK.md principle 1 and section 2.7, D35, D36) |
| `packages/cli/templates/*` | the function author's project: dependency-free apart from the SDK; Node test with `node --test`, Python test with pytest | not krun code; intentional, see `references/templates.md` |

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
For the CLI, also load the Effect skills docs/STACK.md section 5 lists and
`building-clis`; for the Python SDK `python-patterns`, `python-type-system`,
`pytest-advanced`.

## Read first

- docs/INTERNAL-API.md is normative for both SDKs, all of it: endpoints
  106-206, upload 208-232, container view 234-263, retries 291-306, limits
  308-324. SPEC.md:628-640 pod contract; SPEC.md:658-729 section 7.1 (`run()`
  order 686-721, local mode 723-726, versioning 728-729); SPEC.md:731-772
  section 7.2 (`init` 733-750, `deploy` 752-763, packaging 770-772).
- docs/STACK.md principles 1, 2, 3 and 6, sections 2.5 (`yaml`, `ajv`,
  `parseArgs`), 2.7 (CLI only: `@clack/prompts`, `picocolors`,
  `tinyexec`; non-TTY never prompts), 2.8 (why not commander, execa, ora),
  3 (Vitest, `@effect/vitest`, fast-check, `publint`,
  `@arethetypeswrong/cli`) and 4 (process shape, errors, time).
- SPEC section 14: Node.js 26 for krun's own image, the Node SDK supports
  Node 22 or newer (SPEC.md:664, 1495-1496).
- SPEC.md:299-318 internal API summary; SPEC.md:126-127 and 166-173 (the Zod
  schema and `krun validate` ceilings).
- SPEC.md:19-24 non-goals (no SDKs beyond Node and Python, no local gateway
  emulator); SPEC.md:1413-1416 one SemVer version per tag; D20, D24 and D35
  (SPEC.md:1461, 1465, 1476).
- PLAN.md:778-845 Phase 8 tasks and acceptance; PLAN.md:351-361 (P2.5);
  PLAN.md:42-55 toolchain; PLAN.md:85-86 "the SDKs have no runtime
  dependencies and do not use Effect"; PLAN.md:110-114 layout;
  PLAN.md:135-138 `make test` runs `pnpm -r exec vitest run` and
  `uv run --directory sdk/python pytest`.
- References here: `references/run-sequence.md` (the `run()` state machine
  with timeouts, retries and exit codes, Node and Python specifics),
  `references/limits.md` (byte limits per field and truncation rules),
  `references/templates.md` (every file `krun init` writes per language),
  `references/deploy.md` (`krun deploy` steps, flags, env, printed commands,
  wait rule, digest extraction, error hints), `references/conformance.md`
  (design of the `test/sdk-conformance` table).

## Rules

1. `run(handler)` is a plain call that never returns, never a decorator, so
   tests import `handle` without executing it; in Python `run(handle)` sits
   under `if __name__ == "__main__":` (SPEC.md:686-687, PLAN.md:807-810).
2. No runtime dependencies and no Effect in either SDK: Node uses global
   `fetch`, `AbortSignal.timeout`, `node:fs`, `node:process`; Python uses
   `urllib.request`, `threading`, `json`, `sys` (SPEC.md:660-663,
   PLAN.md:85-86). `package.json` lists no `dependencies` (PLAN.md:803-804);
   `vitest` is a `devDependency` only.
3. Read env in this order and nothing else: `KRUN_RUN_ID`, `KRUN_FUNCTION`,
   `KRUN_GATEWAY_URL`, `KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`,
   `KRUN_HEARTBEAT_TIMEOUT`, `KRUN_RESULT_UPLOAD_URL` (SPEC.md:687-690);
   `KRUN_GATEWAY_URL` unset means local mode (SPEC.md:723).
4. Never post `started` eagerly: the initial payload `{ message: "started" }`
   leaves the SDK only through a heartbeat tick (SPEC.md:690-692) because the
   gateway's rate window starts at the last 204 (docs/INTERNAL-API.md:143-149).
5. One send gate for status: latest payload wins, at most one POST per
   second, stays pending after a 429, dropped once the result or error call
   has returned (SPEC.md:692-694, PLAN.md:786-788).
6. `ctx.status` is one attempt, 3 s timeout, never throws; 4xx, 429 and
   timeouts are logged and dropped (SPEC.md:700-702,
   docs/INTERNAL-API.md:297-300) because the next tick is the retry.
7. Heartbeat only when `KRUN_HEARTBEAT_TIMEOUT` is set: re-post the latest
   payload every third of the window from the start of `run` (before
   `GetInput`) until the result or error call returned, from a timer that
   never keeps the process alive (`setInterval(...).unref()`, daemon thread)
   (SPEC.md:694-699, docs/INTERNAL-API.md:153-160). The window also covers
   result writing.
8. `KRUN_HEARTBEAT_TIMEOUT` is an integer number of seconds (SPEC.md:614),
   `KRUN_MAX_RESULT_BYTES` a decimal byte count; both arrive as strings.
   Never parse the `5m` duration grammar in the SDK; the scheduler converts.
9. Return `undefined`/`null`/`None`: no result request, exit 0
   (SPEC.md:702-703, docs/INTERNAL-API.md:177-179). Any other value: compact
   JSON, `PUT result` when it fits `KRUN_MAX_RESULT_BYTES`, else upload to
   `KRUN_RESULT_UPLOAD_URL`, never both (SPEC.md:703-706,
   docs/INTERNAL-API.md:179-180).
10. Upload: raw JSON bytes, `Content-Type: application/json`,
    `Content-Length`, never chunked, no `Authorization`, no checksum header,
    300 s timeout; 4xx (including 403 expired) is not retried; 5xx and
    connection errors retry 3 times at 1 s, 2 s, 4 s
    (docs/INTERNAL-API.md:214-224). After a 200 the SDK does not call
    `SetResult`.
11. A failed result write after retries, or a result above the cap with no
    upload URL: log the cause, `PUT error` type `ResultWriteError`, exit 1
    (SPEC.md:706-708, docs/INTERNAL-API.md:231-232, 250-252). Call `SetError`
    before exiting, while the token still works.
12. Thrown error or exception: `PUT error` with the error type (constructor
    name / class name), the message, and the first 20 stack lines as
    `details.stack`, then exit 1 (SPEC.md:708-710).
13. Truncate before sending, measured as the field's compact JSON
    serialisation in UTF-8 bytes (the gateway's measure,
    docs/INTERNAL-API.md:90-94), cutting on character boundaries: status
    `message` 1 KB, `data` omitted and logged over 4 KB, error `message` 4 KB,
    `type` 128 bytes, drop `details.stack` lines from the end until `details`
    fits 8 KB (SPEC.md:710-715). Table in `references/limits.md`.
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
    SDK pin (SPEC.md:740-742, 1413-1416); `release.yml` stamps it
    (PLAN.md:217-218). Add a test that the template pin equals the workspace
    version.
21. `krun init` writes exactly the files in SPEC.md:736-750; `krun deploy`
    does exactly the steps in SPEC.md:752-763. No extra flags (PLAN.md:31-32):
    there is no `--image` or `--no-build`. `--name` defaults to the
    basename of `<dir>` and is never prompted for (SPEC.md:737-739). The
    only interactive surface is `krun init` on a TTY when `--lang` is
    missing (clack `select` for the language), plus spinners for `krun
    deploy` steps on a TTY (docs/STACK.md 2.7). A non-TTY run never
    prompts: a missing `--lang` fails with a usage message naming the
    flag, exit 1.
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
    must fail on the placeholder with a clear message (PLAN.md:824-825).
25. The printed first-run curl uses the literal `$KRUN_API_KEY`
    (SPEC.md:757-758); never expand or echo the key. Never log input, result
    or status bodies from the SDK (SPEC.md:1151-1153 lists them as redacted).
26. The CLI is an Effect program: entry `NodeRuntime.runMain`, argv parsed
    with `node:util` `parseArgs` (no `effect/cli`, no commander), `docker`,
    `kubectl`, the filesystem, env, the terminal (TTY check, prompts,
    spinners) and output behind small services provided by layers,
    failures as `Data.TaggedError`s mapped to exit codes and "Try this:"
    blocks at the edge, time from `Clock` (CLAUDE.md rules 6 and 8,
    docs/STACK.md section 4).
27. `krun validate` (in-process, also from `deploy`) parses YAML with
    `yaml`, runs the Zod Function schema from
    `packages/shared/src/functions/schema.ts`, then the shared second-layer
    validator (Ajv2020 only to compile `inputSchema`), with ceilings from
    `KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`, `KRUN_ALLOWED_REGISTRIES`,
    `KRUN_ALLOWED_SERVICE_ACCOUNTS`, `KRUN_WEBHOOK_ALLOWED_HOSTS` at the
    SPEC section 12 defaults, values printed on stderr (SPEC.md:166-173,
    PLAN.md:351-361). It never reads the generated CRD or editor JSON.
28. Child processes go through `tinyexec` only, wrapped in the `Docker` and
    `Kubectl` services with `Effect.tryPromise`, the interruption signal
    passed to the child so Ctrl-C or a timeout kills it; never
    `node:child_process` directly, never execa (docs/STACK.md 2.7, 2.8).
29. Prompts and spinners are `@clack/prompts` behind a `Prompt` service;
    colour is `picocolors` on human status lines only (stderr), never on
    the stdout commands users paste; `NO_COLOR` disables it
    (docs/STACK.md 2.7). A cancelled prompt (clack's cancel symbol) is a
    tagged `Cancelled` failure, exit 130 like Ctrl-C elsewhere.
30. Before publishing, `@krun/sdk` and `@krun/cli` pass `publint` and
    `attw --pack` (PLAN P9.5, docs/STACK.md section 3): `exports` with
    `types` and `import` conditions pointing into `dist/`, `files`
    covering `dist/` (and `templates/` for the CLI), no `src/` paths in
    the published manifest.

## `run()` in one screen

Full state machine with retries, timers and both languages in
`references/run-sequence.md`. The shape (docs/INTERNAL-API.md:236-248):

```
read env → local? ──yes──▶ input from argv[1] or stdin → handler → result to stdout → exit
   │no
start heartbeat timer (T/3, unref/daemon) → GET input (10 s, 3 retries) → handler
   ├─ returns undefined/null/None ──────────────▶ stop timer, exit 0
   ├─ returns value ─ fits cap ─▶ PUT result ───▶ 204: stop timer, exit 0
   │                 └ over cap ─▶ PUT upload URL ▶ 200: stop timer, exit 0
   │                                 └ failure ──▶ PUT error ResultWriteError, stop timer, exit 1
   └─ throws ─▶ PUT error {type, message, details.stack[≤20]} ─▶ stop timer, exit 1
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
expected exit code (PLAN.md:811-818). Both suites (Vitest in
`packages/sdk-node`, pytest in `sdk/python`) load it, spawn the SDK as a
child process against a local `http.createServer` fake (PLAN.md:793), and
compare the recorded sequence in order; reordering one SDK's calls fails its
suite. Design, scenario list and matcher grammar in
`references/conformance.md`.

## Templates (P8.4, P8.5)

File-by-file contents, Dockerfile rules and the README loop in
`references/templates.md`. Non-negotiables: handler plus the tests SPEC
names (Node: one subprocess local-mode test; Python: a pytest importing
`handle` with a fake `ctx` plus one subprocess test, SPEC.md:736-739);
SDK dependency as a caret range at the CLI's own version (SPEC.md:740-742);
Python image `CMD ["python", "handler.py"]` (SPEC.md:739). Acceptance runs
with a packed SDK copied into `vendor/` (PLAN.md:822-823, 827-828), so the
install step must resolve from `vendor/` with no registry. The templates are
the function author's project, not krun code: the Node template's own test
uses `node --test` and nothing else, on purpose, so a generated project has
no dependency besides `@krun/sdk`.

## Deploy (P8.7)

Steps, flags, env, the three printed commands, the wait rule, digest
extraction and "Try this" hints in `references/deploy.md`. Order
(SPEC.md:752-761): build → push → digest → write `image: <repo>@sha256:...`
→ `krun validate` → `kubectl apply -f function.yaml -n <ns>` → wait
`Ready=True` (120 s cap) → print curl, `kubectl logs -f`, `GetRun` curl.
`--no-apply` stops after writing the digest. Shell out to `docker` and
`kubectl` through `tinyexec`; the CLI holds no Kubernetes client and must
not pull the server packages' runtime (SPEC.md:126-127 says `validate`
imports the schema only). On a TTY each step runs under a clack spinner;
off a TTY plain progress lines go to stderr.

## Library facts

Versions from docs/STACK.md; API details marked UNVERIFIED were not executed,
confirm in a REPL before relying on them.

- TypeScript 7 `tsc` type-checks and emits `dist/` per package (PLAN.md:42-44).
  Erasable syntax only: no enums, parameter properties, decorators; `.ts`
  extensions in relative imports; `import type` for types.
- Node never strips TS under `node_modules`: `@krun/sdk` and `@krun/cli`
  publish built `.js` from `dist/`; the templates and `npx @krun/cli` consume
  `dist/`.
- `@krun/sdk` targets Node 22 or newer (SPEC.md:664, section 14): global
  `fetch` and `AbortSignal.timeout` exist there; use no API that Node 22
  lacks in `src/`. CI runs the SDK's Vitest 5 suite on Node 22 and on
  Node 26 (Vitest 5 supports Node 22.12 or newer), so a Node 22 gap fails
  CI. The SDK does not need `undici`: global fetch is enough, and mixing
  the package with the bundled fetch is a known trap.
  `"engines": { "node": ">=22" }`.
- `@clack/prompts` 1.x: `intro`, `outro`, `select`, `text`, `spinner()`
  (`start`, `stop`), `isCancel`, `cancel`. Prompts return a value or the
  cancel symbol; test `isCancel` on every answer. Whether 1.x prompts and
  spinners accept an output stream (so they can write to stderr) is
  UNVERIFIED; check its README. If they cannot, use them only when stdout
  is a TTY and stop the spinner before writing the stdout commands.
- `picocolors`: `createColors(enabled)` returns a colour set; compute
  `enabled` from the stderr TTY and `NO_COLOR` / `FORCE_COLOR` yourself,
  because the default export decides from stdout. UNVERIFIED in detail
  against 1.1; check its README.
- `tinyexec` 1.x: `x(command, args, options)` returns a promise-like
  process with `stdout`, `stderr`, `exitCode` and async iteration over
  output lines; options include `throwOnError`, `timeout`, `signal` and
  `nodeOptions` (`cwd`, `env`). Option names UNVERIFIED against the
  installed README. Pass `throwOnError: false` and classify the exit code
  in the service, so every failure is a tagged error with the stderr
  tail, never a thrown `NonZeroExitError`.
- `publint` and `attw --pack` (`@arethetypeswrong/cli`): an ESM-only
  package makes attw report the CommonJS resolution modes; either accept
  that with attw's ESM-only profile or ship a CJS build. Krun ships ESM
  only (PLAN section 2), so use the profile; check the attw README for
  its exact flag name.
- Gate and heartbeat unit tests: `vi.useFakeTimers()` and
  `vi.advanceTimersByTimeAsync`. The gate takes an injected monotonic
  `now: () => number` (default `performance.now`, never the wall clock) so
  the test drives timers and `now` from one fake. Subprocess conformance
  runs use real time with a small `KRUN_HEARTBEAT_TIMEOUT`.
- "Exits without waiting for the heartbeat timer" (PLAN.md:804-805) must be
  a real child process with a deadline on its exit; an in-process test
  cannot see a non-unref'd timer, and Vitest's own teardown would hide it.
- CLI tests use `@effect/vitest`: `it.effect` with fake `Docker`,
  `Kubectl`, `Fs`, `Prompt` and `Terminal` layers (TTY forced on or off,
  scripted prompt answers including a cancel) and `TestClock` for the
  1 s / 120 s Ready poll (`Schedule.spaced("1 second")` under
  `Effect.timeout("120 seconds")`). No test drives real clack or a real
  `docker`.
- Python (UNVERIFIED, stdlib-stable): `urllib.request.Request(url,
  data=bytes, method='PUT', headers=...)`, `urlopen(req, timeout=10)`;
  `HTTPError` is a subclass of `URLError`, catch it first and read `.code`;
  heartbeat as `threading.Thread(target=loop, daemon=True)` with
  `Event.wait(interval)` for a clean stop; `time.monotonic()` for the gate;
  `uv build` makes sdist plus wheel; `uv run --directory sdk/python pytest`
  from the repo root; ruff `select = ["E","F","I","UP","B"]`.
- Layout is `sdk/python/krun/` (PLAN.md:114), not the `src/` layout `uv init
  --lib` generates; `requires-python = ">=3.11"` per SPEC.md:661 and
  PLAN.md:55.

## Lessons from knative/func (and dapr)

- Refuse `krun init` into a directory that already holds `function.yaml`
  or any visible file; hidden files are fine (func `pkg/functions/client.go:1557-1609`).
  After writing, re-read `function.yaml` from disk and validate it; a
  serialisation bug surfaces at init, not at deploy (`client.go:714-715`).
- Emit `# yaml-language-server: $schema=<versioned URL>` at the top of
  `function.yaml` pointing at `docs/schemas/function-v1alpha1.json`
  (SPEC.md:126), the editor schema generated with `z.toJSONSchema` from the
  same Zod schema as the CRD (func `function.go:636-646`).
- Take the digest from the push, write `repo@sha256:...` with the tag
  stripped, and unit-test the four reference shapes (plain, `:tag`,
  registry with port, existing `@sha256:`) (`function.go:1040-1060`,
  `function_unit_test.go:135-186`); a fast-check property over generated
  references is cheap here. Write it only when the push in this invocation
  succeeded (`cmd/deploy.go:451-454`).
- func makes `--image` and `--registry` mutually exclusive (`cmd/build.go:411-415`);
  krun has no `--image` flag, so the image is always `<registry>/<name>` and
  the lesson is: do not add `--image`.
- Poll the Function every 1 s for up to 120 s and require `Ready=True` and
  `status.observedGeneration == metadata.generation`; a stale Ready from the
  previous apply is func's old-ReplicaSet problem (`pkg/k8s/wait.go:22-146`).
  Fail fast on `Ready=False` with one of the SPEC.md:154-157 reasons rather
  than burning the cap (`pkg/knative/deployer.go:257-293`).
- Progress on stderr, machine results on stdout; on a TTY a clack spinner
  shows that a silent `docker build`/`push` is alive; off a TTY print a
  heartbeat line every 10 s (a forked fiber on `Schedule.spaced("10
  seconds")`, interrupted when the child exits); users kill quiet CLIs
  (`pkg/functions/client.go:742-746`, `:812-836`).
- Wrap errors at the CLI boundary with a "Try this:" block per tagged error;
  keep core messages terse (`cmd/errors.go`, `pkg/functions/errors.go:29-31`).
- Bind every flag to `KRUN_<FLAG>` and say `($KRUN_REGISTRY)` in its help;
  precedence default < env < flag (`cmd/root.go:64-66`, `cmd/deploy.go:684-687`).
  The CLI's own options are a Zod schema over the merged `parseArgs` values
  and env, like every other krun config.
- Put `docker`, `kubectl`, the filesystem, env and stdout/stderr behind
  services so unit tests run the real command with fake layers in a scrubbed
  temp dir (`KRUN_*` cleared) and assert on `function.yaml` re-read from disk
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
  two requests 1 s apart (PLAN.md:799-800).
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
- Vitest's default include matches `**/*.test.*`, so `pnpm exec vitest run
  packages/cli` also finds `packages/cli/templates/node/handler.test.js`,
  which is a `node --test` file for the generated project. Exclude
  `templates/**` in the CLI's Vitest config; test the templates by
  generating a project and running its own `npm test` / `uv run pytest`.
- Python `logging` to stderr is fine in the pod; stdout must stay clean in
  local mode, so the SDK must never `print()` anything but the result there.
- Do not let Effect, Zod or `effect`-based helpers from `packages/shared`
  leak into `packages/sdk-node` through a shared import; the SDK imports
  nothing from the workspace.
- SPEC RISK: `@krun/cli` needs the Function schema and second-layer
  validator from `packages/shared` (SPEC.md:126-127), which legitimately
  bring `effect`, `zod`, `ajv`, `ajv-formats` and `yaml`, but `npx @krun/cli`
  must not pull `pg`, `kysely`, `fastify`, `@kubernetes/client-node`,
  `@aws-sdk/*` or the `@opentelemetry/*` packages along. SPEC and PLAN do not say how
  (subpath export, a schema-only package, or bundling). Add a Decisions row
  or write BLOCKED; do not silently add a dependency (PLAN.md:29-30).
- `krun init` without `--name` uses the directory's basename on a TTY
  and off it alike (SPEC.md:737-739, docs/STACK.md 2.7); only a missing
  `--lang` behaves differently (prompt on a TTY, usage error otherwise).
  Test both: `krun init --lang node t` off a TTY names the function `t`;
  `krun init t` off a TTY exits 1 naming `--lang`.
- SPEC RISK: SPEC.md:758 prints `kubectl logs -f -n <jobs namespace>` but
  the CLI reads only `KRUN_NAMESPACE`, `KRUN_API_URL`, `KRUN_API_KEY`,
  `KRUN_REGISTRY` and the five validation ceilings (SPEC.md:752-762,
  SPEC.md:1219-1221); the jobs namespace default is `krun-jobs`
  (SPEC.md:1196). Print the default and ask for a Decisions row before
  adding a flag or env (PLAN.md:31-32).
- Package names: `@krun/sdk`, `@krun/cli`, PyPI `krun` are owner
  preconditions with fallbacks (PLAN.md:213-216). Keep the SDK package name
  in one constant the templates read so a rename is one change; never pick
  a fallback yourself (PLAN.md:24-26).

## Before marking a task done

- Before a release (P9.5) and whenever `package.json` `exports`, `files`
  or the build output changes: `pnpm --filter @krun/sdk exec publint`,
  the same for `@krun/cli`, and `attw --pack` in each package directory.
- Run the task's acceptance verbatim: P8.1 `pnpm exec vitest run
  packages/sdk-node` with the unit matrix against the local fake
  (PLAN.md:793-805); P8.2 `uv run --directory sdk/python pytest`
  (PLAN.md:809-810); P8.3 both suites green and a deliberate reordering red
  (PLAN.md:817-818); P8.4
  `pnpm pack` then `krun init --lang node t && cd t && mkdir vendor && cp ../krun-sdk-*.tgz vendor/ && npm install ./vendor/krun-sdk-*.tgz && npm test && docker build .`
  plus `krun validate function.yaml` failing on `REPLACE_WITH_DIGEST`
  (PLAN.md:822-825); P8.5 `uv build` then
  `krun init --lang python t && cd t && mkdir vendor && cp ../krun-*.whl vendor/ && uv add ./vendor/krun-*.whl && uv run pytest && docker build .`
  (PLAN.md:827-829); P8.6 `make e2e` (PLAN.md:836-837, harness in
  `krun-testing-ci`); P8.7 `pnpm exec vitest run packages/cli` and
  `krun deploy --registry localhost:5001` ends `Ready=True` with three
  commands, `--no-apply` leaves the cluster untouched (PLAN.md:840-845).
- `make check` (PLAN.md:17-18, CLAUDE.md:5); `make test` includes
  `uv run --directory sdk/python pytest` (PLAN.md:137-138).
- Branch per task id (`p8-1-sdk-node`), Conventional Commits with the
  package as scope (`feat(sdk-node): ...`, `feat(cli): ...`), PR to main,
  never push main (PLAN.md:13-22). Mark `[x]`, append
  `YYYY-MM-DD P8.x <short sha> note` to PLAN.md section 6 (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7, PLAN.md:16).
- Phase 8 gate: both `krun init` projects pass their tests and build against
  vendored SDKs; e2e runs one SDK-built function per language (PLAN.md:780-782).

## Limitations

- This skill does not define the gateway's rate window, token checks or
  413 handling; read `krun-gateway-api` and docs/INTERNAL-API.md:68-104.
- Local mode is a one-shot process, not a gateway emulator (SPEC.md:23).
- Only Node.js and Python SDKs exist; a third language is a non-goal
  (SPEC.md:23-24).
- The e2e harness, kind registry and release stamping live in
  `krun-testing-ci`; this skill names only the Phase 8 acceptance text.
