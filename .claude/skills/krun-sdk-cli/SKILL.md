---
name: krun-sdk-cli
description: Use when building krun SDKs, krun init or krun deploy. Zero-dependency run(), heartbeat, local mode, conformance table, templates, CLI prompts (clack), colour (picocolors), docker and kubectl via tinyexec, publint and attw before publish.
---

# krun SDKs and CLI (`@krun/sdk`, Python `krun`, `krun init`, `krun deploy`)

Covers SPEC.md section 7.1 (two function SDKs), 7.2 (`krun init` templates,
`krun deploy`) and the shared `test/sdk-conformance` table. PLAN tasks
P8.1-P8.7. `krun validate` (P2.5) belongs to `krun-functions-crd`; this skill
only packages it into `@krun/cli` and calls it from `deploy`.

| Code | Stack | Why |
|---|---|---|
| `packages/sdk-node` | plain TypeScript, no runtime dependencies, no Effect; Vitest as dev dependency | runs inside other teams' images (docs/STACK.md principle 6) |
| `sdk/python/krun` | Python 3.11+ standard library; `uv`, `ruff`, `pytest`, `mypy --strict` for development | same (SPEC.md:660-663) |
| `packages/cli` | Effect 4 program (`NodeRuntime.runMain`, services, layers, `Clock`) on Node 26, `node:util` `parseArgs`, Zod Function schema, `@clack/prompts`, `picocolors`, `tinyexec` | krun's own process (docs/STACK.md principle 1 and section 2.7, D35, D36) |
| `packages/cli/templates/*` | function author's project: no dependency besides the SDK; Node test with `node --test`, Python test with pytest | not krun code, on purpose; see `references/templates.md` |

## When to use

- `packages/sdk-node` (`run()`, context, local mode) or `sdk/python/krun`
  (same contract on `urllib.request` and a daemon thread).
- `test/sdk-conformance` scenarios, or a suite wired to them.
- `packages/cli/templates/{node,python}` or the `init`/`deploy` subcommands
  in `packages/cli/src`.
- Debugging a function pod failed as `heartbeat_timeout`, losing its result,
  or exiting 0 with an error report.

Not here: gateway side of `/internal/v1` (`krun-gateway-api`), Function
validation rules (`krun-functions-crd`), kind e2e harness and release
workflow (`krun-testing-ci`), presigned URL creation (`krun-webhooks-objstore`).
Also load: for the CLI, the Effect skills docs/STACK.md section 5 lists plus
`building-clis`; for the Python SDK, `python-patterns`, `python-type-system`,
`pytest-advanced`.

## Read first

- docs/INTERNAL-API.md, all of it, is normative for both SDKs: endpoints
  106-206, upload 208-232, container view 234-263, retries 291-306, limits
  308-324.
- SPEC.md:628-640 pod contract. SPEC.md:658-729 section 7.1 (`run()` order
  686-721, local mode 723-726, versioning 728-729). SPEC.md:731-772 section
  7.2 (`init` 733-750, `deploy` 752-763, packaging 770-772). SPEC.md:299-318
  internal API summary. SPEC.md:126-127 and 166-173 (Zod schema,
  `krun validate` ceilings).
- SPEC section 14: krun's own image runs Node.js 26; the Node SDK supports
  Node 22 or newer (SPEC.md:664, 1495-1496).
- SPEC.md:19-24 non-goals (no SDKs beyond Node and Python, no local gateway
  emulator); SPEC.md:1413-1416 one SemVer version per tag; D20, D24, D35
  (SPEC.md:1461, 1465, 1476).
- docs/STACK.md principles 1, 2, 3, 6; sections 2.5 (`yaml`, `ajv`,
  `parseArgs`), 2.7 (CLI only: `@clack/prompts`, `picocolors`, `tinyexec`;
  non-TTY never prompts), 2.8 (why not commander, execa, ora), 3 (Vitest,
  `@effect/vitest`, fast-check, `publint`, `@arethetypeswrong/cli`), 4
  (process shape, errors, time).
- PLAN.md:778-845 Phase 8 tasks and acceptance; PLAN.md:351-361 (P2.5);
  PLAN.md:42-55 toolchain; PLAN.md:85-86 "the SDKs have no runtime
  dependencies and do not use Effect"; PLAN.md:110-114 layout;
  PLAN.md:135-138 `make test` runs `pnpm -r exec vitest run` and
  `uv run --directory sdk/python pytest`.

| Reference | Holds |
|---|---|
| `references/run-sequence.md` | `run()` state machine: timeouts, retries, exit codes, Node and Python specifics |
| `references/limits.md` | byte limit per field, truncation rules |
| `references/templates.md` | every file `krun init` writes per language |
| `references/deploy.md` | `krun deploy` steps, flags, env, printed commands, wait rule, digest extraction, error hints |
| `references/conformance.md` | design of the `test/sdk-conformance` table |
| `references/library-facts.md` | library API facts and UNVERIFIED notes: `tsc`, Node 22 floor, clack, picocolors, tinyexec, attw, fake timers, Python stdlib |

## Rules

1. `run(handler)` is a plain call that never returns, never a decorator, so
   tests import `handle` without executing it. Python: `run(handle)` sits
   under `if __name__ == "__main__":` (SPEC.md:686-687, PLAN.md:807-810).
2. Neither SDK has runtime dependencies or uses Effect. Node uses global
   `fetch`, `AbortSignal.timeout`, `node:fs`, `node:process`; Python uses
   `urllib.request`, `threading`, `json`, `sys` (SPEC.md:660-663,
   PLAN.md:85-86). `package.json` lists no `dependencies` (PLAN.md:803-804);
   `vitest` is a `devDependency` only. The SDK imports nothing from the
   workspace, so Effect, Zod and `effect`-based helpers from
   `packages/shared` cannot leak in.
3. Read only these env vars, in this order: `KRUN_RUN_ID`, `KRUN_FUNCTION`,
   `KRUN_GATEWAY_URL`, `KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`,
   `KRUN_HEARTBEAT_TIMEOUT`, `KRUN_RESULT_UPLOAD_URL` (SPEC.md:687-690).
   `KRUN_GATEWAY_URL` unset means local mode (SPEC.md:723).
4. Never post `started` eagerly. The initial payload `{ message: "started" }`
   leaves the SDK only through a heartbeat tick (SPEC.md:690-692): the
   gateway's rate window starts at the last 204 (docs/INTERNAL-API.md:143-149).
5. One send gate for status: latest payload wins, at most one POST per
   second, stays pending after a 429, dropped once the result or error call
   has returned (SPEC.md:692-694, PLAN.md:786-788). Two immediate
   `ctx.status` calls make two requests 1 s apart (PLAN.md:799-800).
6. `ctx.status`: one attempt, 3 s timeout, never throws. 4xx, 429 and
   timeouts are logged and dropped; the next tick is the retry
   (SPEC.md:700-702, docs/INTERNAL-API.md:297-300).
7. Heartbeat only when `KRUN_HEARTBEAT_TIMEOUT` is set. Re-post the latest
   payload every third of the window, from the start of `run` (before
   `GetInput`) until the result or error call returned. The timer never
   keeps the process alive (`setInterval(...).unref()`, daemon thread)
   (SPEC.md:694-699, docs/INTERNAL-API.md:153-160). The window also covers
   result writing.
8. Both arrive as strings: `KRUN_HEARTBEAT_TIMEOUT` is integer seconds
   (SPEC.md:614), `KRUN_MAX_RESULT_BYTES` a decimal byte count. Never parse
   the `5m` duration grammar in the SDK; the scheduler converts.
   `heartbeatTimeout: 5m` in `function.yaml` reaches the SDK as `300`: one
   tick every 100 s.
9. Return `undefined`/`null`/`None`: no result request, exit 0
   (SPEC.md:702-703, docs/INTERNAL-API.md:177-179). Any other value: compact
   JSON; `PUT result` when it fits `KRUN_MAX_RESULT_BYTES`, else upload to
   `KRUN_RESULT_UPLOAD_URL`, never both (SPEC.md:703-706,
   docs/INTERNAL-API.md:179-180).
10. Upload: raw JSON bytes, `Content-Type: application/json`,
    `Content-Length`, never chunked, no `Authorization`, no checksum header,
    300 s timeout. 4xx (including 403 expired) is not retried; 5xx and
    connection errors retry 3 times at 1 s, 2 s, 4 s
    (docs/INTERNAL-API.md:214-224). After a 200 the SDK does not call
    `SetResult`.
11. Result write failed after retries, or result above the cap with no
    upload URL: log the cause, `PUT error` type `ResultWriteError`, exit 1
    (SPEC.md:706-708, docs/INTERNAL-API.md:231-232, 250-252). Call `SetError`
    before exit, while the token still works.
12. Thrown error or exception: `PUT error` with the error type (constructor
    name / class name), the message and the first 20 stack lines as
    `details.stack`, then exit 1 (SPEC.md:708-710).
13. Truncate before sending. Measure the field's compact JSON serialisation
    in UTF-8 bytes, the gateway's measure (docs/INTERNAL-API.md:90-94). Cut
    on character boundaries: status `message` 1 KB; `data` over 4 KB is
    omitted and logged; error `message` 4 KB; `type` 128 bytes; drop
    `details.stack` lines from the end until `details` fits 8 KB
    (SPEC.md:710-715). Table in `references/limits.md`.
14. `GetInput`, `SetResult`, `SetError`: 10 s per attempt, 3 retries at 1 s,
    2 s, 4 s backoff, on connection errors, timeouts and 5xx only
    (SPEC.md:715-717, docs/INTERNAL-API.md:293-296). Other 4xx is a bug: no
    retry.
15. A 401 on any call, status reports included, ends the process with exit
    1; so does SIGTERM (SPEC.md:717-718, docs/INTERNAL-API.md:258-262).
16. Exit code is the truth: 0 success, anything else failure (SPEC.md:639).
    An error report plus exit 0 is still `SUCCEEDED`
    (docs/INTERNAL-API.md:204-206).
17. `ctx` exposes exactly `runId`, `function`, `status(message, progress?,
    data?)`, `log`. In the pod `ctx.log` writes one JSON line to stdout
    (SPEC.md:719-721). No other surface (PLAN.md:31-32).
18. Local mode: input from the file named by the first argument, else stdin.
    Stdout holds only the result (nothing for a void handler); `ctx.log` and
    `ctx.status` go to stderr. Same exit codes; no network (SPEC.md:723-726).
    Python `logging` to stderr is fine; the SDK never `print()`s anything
    but the result in local mode.
19. SDK major N speaks `/internal/vN`. Send
    `User-Agent: krun-sdk-node/<version>` and `krun-sdk-python/<version>`
    (SPEC.md:728-729, D24 SPEC.md:1465). The gateway logs it, never gates on
    it (SPEC.md:308-309), like dapr (`pkg/api/http/server.go:370-372`).
20. One workspace version per tag for the SDKs, the CLI and the templates'
    SDK pin (SPEC.md:740-742, 1413-1416); `release.yml` stamps it
    (PLAN.md:217-218). Test that the template pin equals the workspace
    version (func `Makefile:35-48`, `pkg/scaffolding/middleware_version.go`).
21. `krun init` writes exactly the files in SPEC.md:736-750; `krun deploy`
    does exactly the steps in SPEC.md:752-763. No extra flags
    (PLAN.md:31-32): no `--image`, no `--no-build`. `--name` defaults to the
    basename of `<dir>`, on a TTY and off it, and is never prompted for
    (SPEC.md:737-739). The only interactive surface: a clack `select` for
    the language when `krun init` runs on a TTY without `--lang`, and
    spinners for `krun deploy` steps on a TTY (docs/STACK.md 2.7). A
    non-TTY run never prompts: missing `--lang` fails with a usage message
    naming the flag, exit 1. Test both: off a TTY,
    `krun init --lang node t` names the function `t`; `krun init t` exits 1
    naming `--lang`.
22. The CLI never reads `KRUN_GATEWAY_URL` (SPEC.md:762-763). That variable
    switches SDKs out of local mode; the templates' subprocess tests need it
    unset.
23. The Dockerfile copies the whole project before installing, so a packed
    SDK in `vendor/` builds unpublished. `.dockerignore` never excludes
    `vendor/`. Numeric `USER 65532:65532`; safe on a read-only root
    filesystem (SPEC.md:743-746). The Job sets `HOME=/tmp` and mounts `/tmp`
    (SPEC.md:607, 621-625); write nowhere else.
24. `function.yaml` ships `image: REPLACE_WITH_DIGEST`, a starter
    `inputSchema`, `heartbeatTimeout: 5m` (SPEC.md:747-748). `krun validate`
    must fail on the placeholder with a clear message (PLAN.md:824-825).
25. The printed first-run curl uses the literal `$KRUN_API_KEY`
    (SPEC.md:757-758); never expand or echo the key. The SDK never logs
    input, result or status bodies (SPEC.md:1151-1153 lists them as
    redacted).
26. The CLI is an Effect program. Entry `NodeRuntime.runMain`; argv parsed
    with `node:util` `parseArgs` (no `effect/cli`, no commander). `docker`,
    `kubectl`, filesystem, env, terminal (TTY check, prompts, spinners) and
    output sit behind small services provided by layers. Failures are
    `Data.TaggedError`s, mapped at the edge to exit codes and "Try this:"
    blocks. Time from `Clock` (CLAUDE.md rules 6 and 8, docs/STACK.md
    section 4).
27. `krun validate` (in-process, also from `deploy`): parse YAML with
    `yaml`, run the Zod Function schema from
    `packages/shared/src/functions/schema.ts`, then the shared second-layer
    validator (Ajv2020 only to compile `inputSchema`). Ceilings come from
    `KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`, `KRUN_ALLOWED_REGISTRIES`,
    `KRUN_ALLOWED_SERVICE_ACCOUNTS`, `KRUN_WEBHOOK_ALLOWED_HOSTS` at the SPEC
    section 12 defaults; print the values on stderr (SPEC.md:166-173,
    PLAN.md:351-361). It never reads the generated CRD or editor JSON.
28. Child processes go through `tinyexec` only, wrapped in the `Docker` and
    `Kubectl` services with `Effect.tryPromise`. Pass the interruption
    signal to the child so Ctrl-C or a timeout kills it. Never
    `node:child_process` directly, never execa (docs/STACK.md 2.7, 2.8).
29. Prompts and spinners: `@clack/prompts` behind a `Prompt` service.
    Colour: `picocolors` on human status lines only (stderr), never on the
    stdout commands users paste; `NO_COLOR` disables it (docs/STACK.md 2.7).
    A cancelled prompt (clack's cancel symbol) is a tagged `Cancelled`
    failure, exit 130 like Ctrl-C.
30. Before publishing, `@krun/sdk` and `@krun/cli` pass `publint` and
    `attw --pack` (PLAN P9.5, docs/STACK.md section 3): `exports` with
    `types` and `import` conditions pointing into `dist/`; `files` covering
    `dist/` (plus `templates/` for the CLI); no `src/` paths in the
    published manifest.

## `run()` in one screen

Full state machine in `references/run-sequence.md`. Shape
(docs/INTERNAL-API.md:236-248):

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


Heartbeat timer and status gate share one `latest` payload. A tick posts
whatever is there: `{ message: "started" }` before the first `ctx.status`.
Once the result or error call has returned, the gate drops everything, so a
late tick never fires a 401 and never delays exit.

## Conformance, templates, deploy

- P8.3: one JSON table under `test/sdk-conformance/`. Both suites (Vitest
  in `packages/sdk-node`, pytest in `sdk/python`) spawn the
  SDK as a child process against a local `http.createServer` fake
  (PLAN.md:793) and compare the request sequence in order; reordering one
  SDK's calls fails its suite (PLAN.md:811-818). See `references/conformance.md`.
- P8.4, P8.5: rules 20-24 plus `references/templates.md`. Node ships one
  subprocess local-mode test; Python a pytest importing `handle` with a fake
  `ctx` plus one subprocess test (SPEC.md:736-739). Acceptance
  installs a packed SDK copied into `vendor/` (PLAN.md:822-823, 827-828):
  the install step must resolve from `vendor/` with no registry.
- P8.7: rules 21-29 plus `references/deploy.md`. Order (SPEC.md:752-761):
  build, push, digest, write `image: <repo>@sha256:...`, `krun validate`,
  `kubectl apply -f function.yaml -n <ns>`, wait `Ready=True` (120 s cap),
  print curl, `kubectl logs -f` and `GetRun` curl. `--no-apply` stops after
  writing the digest. The CLI holds no Kubernetes client and must not pull
  the server packages' runtime (SPEC.md:126-127: `validate` imports the
  schema only).

## Lessons from knative/func

| func lesson (source) | krun rule |
|---|---|
| refuse a directory with `function.yaml` or any visible file (func `pkg/functions/client.go:1557-1609`); re-read and validate after writing (`client.go:714-715`) | `krun init` steps 3 and 5 in `references/templates.md` |
| editor schema header (func `function.go:636-646`) | `function.yaml` starts with `# yaml-language-server: $schema=<versioned URL>` pointing at `docs/schemas/function-v1alpha1.json`, generated with `z.toJSONSchema` from the CRD's Zod schema (SPEC.md:126) |
| digest from the push, tag stripped (`function.go:1040-1060`, `function_unit_test.go:135-186`); write only after this invocation's push succeeded (`cmd/deploy.go:451-454`) | write `repo@sha256:...`; test four reference shapes (plain, `:tag`, registry with port, existing `@sha256:`) plus a fast-check property |
| `--image` and `--registry` mutually exclusive (`cmd/build.go:411-415`) | krun has no `--image`; image is always `<registry>/<name>`. Do not add `--image` |
| stale Ready from the old ReplicaSet (`pkg/k8s/wait.go:22-146`); fail fast (`pkg/knative/deployer.go:257-293`) | poll 1 s up to 120 s; require `Ready=True` and `status.observedGeneration == metadata.generation`; fail fast on `Ready=False` with a SPEC.md:154-157 reason |
| users kill quiet CLIs (`pkg/functions/client.go:742-746`, `:812-836`) | progress on stderr, results on stdout; clack spinner on a TTY shows a silent `docker build`/`push` is alive; off a TTY a heartbeat line every 10 s from a fiber on `Schedule.spaced("10 seconds")`, interrupted when the child exits |
| "Try this:" block at the boundary, terse core messages (`cmd/errors.go`, `pkg/functions/errors.go:29-31`) | one block per tagged error |
| flags bound to env (`cmd/root.go:64-66`, `cmd/deploy.go:684-687`) | bind every flag to `KRUN_<FLAG>`, write `($KRUN_REGISTRY)` in its help; precedence default < env < flag; options are a Zod schema over merged `parseArgs` values and env |
| commands behind injectable clients (`cmd/client.go:45-54`, `pkg/testing/testing.go:332-363`) | `docker`, `kubectl`, filesystem, env, stdout/stderr behind services; unit tests run the real command with fake layers in a scrubbed temp dir (`KRUN_*` cleared), asserting on `function.yaml` re-read from disk |

## Pitfalls

- A heartbeat re-sends the full last status. `runtimeStatus` is replaced
  wholesale, so `{ message }` without `progress` erases progress
  (docs/INTERNAL-API.md:138-139).
- A CPU-bound synchronous handler or a GIL-holding extension starves the
  heartbeat (SPEC.md:698-699); say so in the template README.
- The input is re-serialised: compare parsed values, never bytes
  (docs/INTERNAL-API.md:113-118).
- `PUT result` after the pod is terminal is 401 and lost; a rejected
  `SetResult` must still end non-zero (docs/INTERNAL-API.md:250-254).
- Vitest's default include matches `**/*.test.*`, so
  `pnpm exec vitest run packages/cli` also finds
  `packages/cli/templates/node/handler.test.js`, a `node --test` file for
  the generated project. Exclude `templates/**` in the CLI's Vitest config.
  Test the templates by generating a project and running its own
  `npm test` / `uv run pytest`.
- SPEC RISK: `@krun/cli` needs the Function schema and second-layer
  validator from `packages/shared` (SPEC.md:126-127). Those legitimately
  bring `effect`, `zod`, `ajv`, `ajv-formats` and `yaml`. But `npx @krun/cli`
  must not pull `pg`, `kysely`, `fastify`, `@kubernetes/client-node`,
  `@aws-sdk/*` or the `@opentelemetry/*` packages along. SPEC and PLAN do
  not say how (subpath export, schema-only package, or bundling). Add a
  Decisions row or write BLOCKED; never silently add a dependency
  (PLAN.md:29-30).
- SPEC RISK: SPEC.md:758 prints `kubectl logs -f -n <jobs namespace>`, but
  the CLI reads only `KRUN_NAMESPACE`, `KRUN_API_URL`, `KRUN_API_KEY`,
  `KRUN_REGISTRY` and the five validation ceilings (SPEC.md:752-762,
  SPEC.md:1219-1221). The jobs namespace default is `krun-jobs`
  (SPEC.md:1196). Print the default; ask for a Decisions row before adding a
  flag or env (PLAN.md:31-32).
- Package names `@krun/sdk`, `@krun/cli` and PyPI `krun` are owner
  preconditions with fallbacks (PLAN.md:213-216). Keep the SDK package name
  in one constant the templates read, so a rename is one change. Never pick
  a fallback yourself (PLAN.md:24-26).

## Before marking a task done

- Before a release (P9.5), and whenever `package.json` `exports`, `files` or
  the build output changes: `pnpm --filter @krun/sdk exec publint`, the same
  for `@krun/cli`, and `attw --pack` in each package directory.
- Run the task's acceptance verbatim:
  - P8.1: `pnpm exec vitest run packages/sdk-node` with the unit matrix
    against the local fake (PLAN.md:793-805).
  - P8.2: `uv run --directory sdk/python pytest` (PLAN.md:809-810).
  - P8.3: both suites green, a deliberate reordering red (PLAN.md:817-818).
  - P8.4: `pnpm pack`, then
    `krun init --lang node t && cd t && mkdir vendor && cp ../krun-sdk-*.tgz vendor/ && npm install ./vendor/krun-sdk-*.tgz && npm test && docker build .`,
    plus `krun validate function.yaml` failing on `REPLACE_WITH_DIGEST`
    (PLAN.md:822-825).
  - P8.5: `uv build`, then
    `krun init --lang python t && cd t && mkdir vendor && cp ../krun-*.whl vendor/ && uv add ./vendor/krun-*.whl && uv run pytest && docker build .`
    (PLAN.md:827-829).
  - P8.6: `make e2e` (PLAN.md:836-837; harness in `krun-testing-ci`).
  - P8.7: `pnpm exec vitest run packages/cli`; `krun deploy --registry
    localhost:5001` ends `Ready=True` with three commands; `--no-apply`
    leaves the cluster untouched (PLAN.md:840-845).
- `make check` (PLAN.md:17-18, CLAUDE.md:5). `make test` includes
  `uv run --directory sdk/python pytest` (PLAN.md:137-138).
- Branch per task id (`p8-1-sdk-node`); Conventional Commits with the
  package as scope (`feat(sdk-node): ...`, `feat(cli): ...`); PR to main;
  never push main (PLAN.md:13-22). Mark `[x]` and append
  `YYYY-MM-DD P8.x <short sha> note` to PLAN.md section 6 (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7,
  PLAN.md:16).
- Phase 8 gate: both `krun init` projects pass their tests and build against
  vendored SDKs; e2e runs one SDK-built function per language
  (PLAN.md:780-782).

## Limitations

- Gateway rate window, token checks and 413 handling are not defined here;
  read `krun-gateway-api` and docs/INTERNAL-API.md:68-104.
- Local mode is a one-shot process, not a gateway emulator (SPEC.md:23).
- Only Node.js and Python SDKs exist; a third language is a non-goal
  (SPEC.md:23-24).
- The e2e harness, kind registry and release stamping live in
  `krun-testing-ci`; this skill names only the Phase 8 acceptance text.
