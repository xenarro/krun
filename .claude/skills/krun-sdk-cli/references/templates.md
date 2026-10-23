# `krun init` templates (P8.4, P8.5)

Source of truth: SPEC.md:733-750 (what `krun init` writes), PLAN.md:819-829
(acceptance). Templates live in `packages/cli/templates/<lang>/` and are
copied verbatim except for the name substitution.

The templates are the function author's project, not krun code, and follow
different rules on purpose: no dependency besides the SDK (no Effect, no
Zod, no Vitest), so the Node template's own test uses `node --test` and the
Python template's uses pytest importing `handle`. The krun stack rules
(docs/STACK.md) apply to the CLI that writes them, not to what it writes.

## Command

`krun init --lang node|python [--name <function>] <dir>` (SPEC.md:733).
No other flags (PLAN.md:31-32). `--name` defaults to the basename of `<dir>`.

Order (lessons from knative/func `pkg/functions/client.go:647-716`):

1. Validate `--lang` (only `node`, `python`).
2. Validate the name as a DNS-1123 label with the name regex exported next
   to the Zod schema in `packages/shared/src/functions/schema.ts` (one
   constant, imported, never copied); reject a leading `-` with a specific
   hint, it is a mistyped flag (func `cmd/create.go:621-647`).
3. Create `<dir>`; refuse if it contains `function.yaml` or any visible
   (non-dot) entry; hidden files such as `.git` are fine (func
   `client.go:1557-1609`). Error text names the offending file.
4. Copy the template tree, substitute the name and the SDK version.
5. Re-read `function.yaml` from disk and parse it with the Zod Function
   schema (with the placeholder image allowed); a serialisation bug fails
   here, not at deploy (func `client.go:714-715`).
6. Print the next steps on stderr; print nothing on stdout except an
   optional `--json` result if a later task asks for one (none does today).

`init` is an Effect program like the rest of the CLI: argv from
`node:util` `parseArgs`, file writes through the CLI's `Fs` service, each
failure a tagged error rendered as a "Try this:" block.

Never resolve templates relative to `process.cwd()`; use
`new URL("../templates/", import.meta.url)` from the built `dist/` file and
check the published `@krun/cli` tarball contains `templates/` (`files` in
`package.json`).

## Files per language

### Node (`packages/cli/templates/node/`)

| File | Content |
|---|---|
| `handler.js` (or `.mjs`) | `import { run } from "@krun/sdk"; export async function handle(input, ctx) { ... }` plus `if (import.meta.url === pathToFileURL(process.argv[1]).href) run(handle)` so tests can import `handle` without executing (SPEC.md:686-687) |
| `handler.test.js` | ONE subprocess local-mode test (SPEC.md:736-737): spawn `node handler.js` with `KRUN_GATEWAY_URL` deleted from the env, pipe a JSON input on stdin, assert exit 0 and `JSON.parse(stdout)` deep-equals the expected result, assert stderr is not parsed as result |
| `package.json` | `"type": "module"`, `"dependencies": { "@krun/sdk": "^<cli version>" }` (SPEC.md:740-742), `"scripts": { "test": "node --test", "start": "node handler.js" }` (the generated project's own runner, intentionally not Vitest), `"engines": { "node": ">=20" }`, no `devDependencies` |
| `Dockerfile` | see Dockerfile rules |
| `.dockerignore` | `node_modules`, `.git`; never `vendor/` (SPEC.md:745) |
| `.gitignore` | `node_modules/` |
| `function.yaml` | see below |
| `README.md` | see below |

Plain JavaScript keeps the template buildable with no TypeScript toolchain;
if a TS template is wanted later it is a Decisions row, not a flag.

### Python (`packages/cli/templates/python/`)

| File | Content |
|---|---|
| `handler.py` | `from krun import run`, `def handle(input, ctx): ...`, `if __name__ == "__main__": run(handle)` (SPEC.md:675-684) |
| `tests/test_handler.py` | a pytest importing `handle` and calling it with a fake `ctx` (`runId`, `function`, `status`, `log` stubs), plus ONE subprocess local-mode test running `python handler.py` with stdin input (SPEC.md:737-739) |
| `pyproject.toml` | `[project] requires-python = ">=3.11"`, `dependencies = ["krun~=<cli version>"]` (compatible release, SPEC.md:740-741), pytest in a dev group, not in runtime deps (func's template mixes them; do not copy that) |
| `Dockerfile` | `CMD ["python", "handler.py"]` (SPEC.md:739) |
| `.dockerignore`, `.gitignore` | `.venv/`, `__pycache__/`, `.pytest_cache/`; never `vendor/` |
| `function.yaml`, `README.md` | as below |

Importing `handler.py` must execute nothing (PLAN.md:810); the test suite
proves it by importing and asserting no request was made.

## Dockerfile rules (both languages)

- Multi-stage; copy the **whole project** before installing dependencies so
  a packed SDK in `vendor/` resolves without a registry (SPEC.md:743-745).
  `COPY package*.json` then `npm install` then `COPY .` is the anti-pattern:
  it breaks the vendored acceptance in PLAN.md:823.
- Install from the lockfile when present; when `vendor/` holds the SDK the
  dependency spec points at the file (the acceptance does `npm install
  ./vendor/krun-sdk-*.tgz` / `uv add ./vendor/krun-*.whl` before building).
- Base: distroless or slim (SPEC.md:746), pinned by digest in the template.
  Node: `node:24-slim` build, distroless `nodejs24-debian12:nonroot` or slim
  runtime. Python: `python:3.13-slim` (func uses the same,
  `pkg/oci/python_builder.go:19-38`).
- Numeric `USER 65532:65532` (SPEC.md:745): PSA `restricted` and
  `runAsNonRoot` need a numeric UID; the Job also sets 65532 (SPEC.md section 7).
- Read-only root filesystem safe: write only under `/tmp`; the Job sets
  `HOME=/tmp` and mounts an emptyDir there. Python: set
  `PYTHONDONTWRITEBYTECODE=1` and `PYTHONUNBUFFERED=1`; npm/pip caches are
  build-stage only.
- `STOPSIGNAL SIGTERM` (default, state it), optional
  `LABEL org.opencontainers.image.revision=$GIT_SHA` via build-arg.

## `function.yaml` starter

```yaml
# yaml-language-server: $schema=<versioned URL of docs/schemas/function-v1alpha1.json>
apiVersion: krun.io/v1alpha1
kind: Function
metadata:
  name: <name>
spec:
  image: REPLACE_WITH_DIGEST
  inputSchema:
    type: object
    required: [name]
    properties:
      name: { type: string, minLength: 1 }
    additionalProperties: false
  heartbeatTimeout: 5m
```

`image: REPLACE_WITH_DIGEST` and `heartbeatTimeout: 5m` are required by
SPEC.md:747-748. `krun validate function.yaml` must fail on the placeholder
with a message naming the field and telling the user to run `krun deploy`
(PLAN.md:824-825). The schema header URL points at the editor schema
generated from the Zod schema with `z.toJSONSchema` (SPEC.md:126); pin it
to the tag, not `main`.

## README loop (SPEC.md:749-750)

1. Test locally: `npm test` / `uv run pytest`; run once with
   `echo '{"name":"x"}' | node handler.js` (local mode, no cluster).
2. `krun deploy --registry <registry>` (or `KRUN_REGISTRY`).
3. POST a run with the curl `krun deploy` prints (uses `$KRUN_API_KEY`
   literally, never an inline key).
4. Manual steps behind `krun deploy`: `docker build`, `docker push`, copy
   the digest into `image:`, `krun validate function.yaml`,
   `kubectl apply -f function.yaml -n krun`,
   `kubectl get kfn <name> -n krun -w`.
5. Note that a CPU-bound synchronous handler starves the heartbeat timer
   (SPEC.md:698-699) and that `heartbeatTimeout` must exceed the longest
   gap between event-loop turns.

## Version coupling

- The template's SDK pin is the CLI's own version, one workspace version
  per tag (SPEC.md:740-742, 1413-1416). Read it from the CLI's
  `package.json` at build time, never hard-code.
- Unit test: rendered template pin == workspace version; fails the build if
  `release.yml` stamping missed a file (func
  `pkg/scaffolding/middleware_version.go`).

## Tests for the CLI itself

Vitest with `@effect/vitest`, gate `pnpm exec vitest run packages/cli`;
the CLI's Vitest config excludes `templates/**` (those are `node --test`
files for the generated project).

- Provide fake `Fs`, `Env` and output layers, or the real `Fs` over an
  `fs.mkdtemp` dir; run `init` with `it.effect`.
- Cases: valid node, valid python, existing `function.yaml`, visible file
  present, hidden file present (allowed), name with uppercase, leading `-`,
  name too long for `krun-<name>-...` labels if a length cap applies.
- After init, assert the rendered `function.yaml` parses with the Zod
  schema, its `metadata.name` equals the requested name and the SDK pin
  equals the workspace version.
- The templates themselves are tested only by the P8.4 and P8.5 acceptance:
  generate a project, install the vendored SDK, run its own `npm test` or
  `uv run pytest`.
