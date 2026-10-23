# `krun deploy` (P8.7)

Source of truth: SPEC.md:752-768, PLAN.md:818-825. Golden path from code to
a Ready function. The CLI shells out to `docker` and `kubectl`; it holds no
Kubernetes client library.

## Synopsis

```
krun deploy [--no-apply] [--namespace <ns>] [--api-url <url>] [--registry <reg>] [dir]
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--registry` | `KRUN_REGISTRY` | none: error with a Try-this block | image repo prefix; image is `<registry>/<function name>` |
| `--namespace` | `KRUN_NAMESPACE` | `krun` | namespace for `kubectl apply` and the Ready wait |
| `--api-url` | `KRUN_API_URL` | none: the printed curl uses `$KRUN_API_URL` literally | base URL for the printed first-run curl |
| `--no-apply` | | off | stop after writing the digest into `function.yaml` (GitOps) |
| `dir` | | `.` | project directory containing `function.yaml` |

Precedence: default < env < flag. The CLI reads `KRUN_API_KEY` only to
mention it; it never expands or prints the value. It never reads
`KRUN_GATEWAY_URL` (SPEC.md:762-763). No other flags (PLAN.md:31-32): no
`--image`, `--no-build`, `--tag`, `--context` or prompts.

## Steps, in order (SPEC.md:753-761)

1. Load and parse `dir/function.yaml`; require `metadata.name`.
2. Resolve the registry; build `ref = <registry>/<name>:<tag>` where the tag
   is a throwaway (e.g. `latest` or a timestamp); only the digest is
   recorded.
3. `docker build -t <ref> <dir>`; stream output to stderr, or print a
   heartbeat line every 10 s if quiet (func `client.go:812-836`: users kill
   silent CLIs).
4. `docker push <ref>`; capture stdout.
5. Read the digest (see below). Abort if none was found.
6. Write `image: <registry>/<name>@sha256:<64 hex>` into `function.yaml`,
   editing only that scalar so comments, key order and the schema header
   survive (use the `yaml` package's Document API, `doc.setIn(["spec","image"], v)`,
   then `String(doc)`). Write only if the value changed.
7. Run `krun validate` in-process on the file with the section 3 ceilings
   from env (same code path as the `validate` subcommand); print the values
   used on stderr (SPEC.md:166-172). Stop on error.
8. If `--no-apply`: print the digest line and exit 0. The cluster is not
   touched (PLAN.md:824-825).
9. `kubectl apply -f function.yaml -n <ns>`.
10. Wait for Ready (rule below), cap 120 s.
11. Print three commands (stdout, ready to paste):
    - first-run curl:
      `curl -sS -X POST "$KRUN_API_URL/v1/functions/<name>/runs" -H "Authorization: Bearer $KRUN_API_KEY" -H 'Content-Type: application/json' -d '{"input":{...}}'`
      using `--api-url` when given, the literal `$KRUN_API_KEY` always;
    - in-flight logs: `kubectl logs -f -n <jobs namespace> job/krun-<id>`
      with a note that it works only while the run is `scheduled` or
      `running` (SPEC.md:758-759);
    - `GetRun` curl: `curl -sS "$KRUN_API_URL/v1/runs/<id>" -H "Authorization: Bearer $KRUN_API_KEY"`
      noting `logTail` holds the last lines of a failed run.

## Digest extraction

- Primary: parse `docker push` output with
  `/digest:\s+(sha256:[0-9a-f]{64})/` (func `pkg/docker/pusher.go:263-274`;
  PLAN.md:811 uses the same `digest:` line for e2e).
- Fallback: `docker inspect --format '{{index .RepoDigests 0}}' <ref>` and
  take the part after `@`, but only for a RepoDigest whose repository equals
  `<registry>/<name>`.
- Beware buildx multi-arch pushes: the manifest-list digest differs from a
  platform image digest; pin what was pushed under the tag.
- Only write the digest when the push in **this** invocation succeeded (func
  `cmd/deploy.go:451-454`).

`imageWithDigest(ref, digest)` must handle the four shapes func tests
(`function_unit_test.go:135-186`): `repo` -> `repo@d`; `repo:tag` ->
`repo@d`; `host:5001/repo:tag` -> `host:5001/repo@d` (split on the last `/`
before stripping `:tag`, so the port survives); `repo@sha256:old` ->
`repo@d`.

## Ready wait rule

Poll `kubectl get functions.krun.io <name> -n <ns> -o json` every 1 s for at
most 120 s (func `pkg/k8s/wait.go:22-31` uses 1 s / 120 s):

- Success: `status.observedGeneration == metadata.generation` **and**
  condition `Ready` has `status: "True"`. Without the generation check a
  stale Ready from the previous apply passes instantly (knative-serving
  `revision_lifecycle.go:70-84`).
- Fail fast: same generation and `Ready=False` with one of the SPEC reasons
  (`SchemaInvalid`, `RegistryNotAllowed`, ...): print reason and message,
  exit 1, do not wait out the cap (func `pkg/knative/deployer.go:257-293`).
- Missing condition: Unknown, keep polling.
- Timeout: print the last observed condition (or "no status yet: is the
  scheduler leader running?") and `kubectl describe kfn <name> -n <ns>`;
  exit 1.

Use `functions.krun.io` or `kfn`, never `functions` (ambiguous with
OpenFaaS/Fission, SPEC.md:76-78).

## Output and errors

- Human progress on stderr; the three commands (and in `--no-apply` the
  digest) on stdout.
- Wrap errors at the CLI boundary with a "Try this:" block (func
  `cmd/errors.go`):
  - no registry: `krun deploy --registry ghcr.io/<you>` / `export KRUN_REGISTRY=...`;
  - `docker` missing or daemon down: `docker version`;
  - push denied: `docker login <registry>`;
  - `kubectl` cannot reach a cluster: distinguish "no kubeconfig" from
    "unreachable" and suggest `kubectl cluster-info`,
    `kubectl config get-contexts` (func `cmd/errors.go:289-319`);
  - CRD missing (`the server doesn't have a resource type "functions"`):
    the platform chart is not installed or `crds.install=false`.
- Exit codes: 0 success, 1 error, 130 on Ctrl-C.

## Tests

- Inject `{ exec, fs, env, clock, stdout, stderr }`; fake `docker` returns a
  canned push transcript; fake `kubectl` returns scripted Function JSON per
  poll. Run in an `fs.mkdtemp` copy of the template with `KRUN_*` cleared
  from the injected env (func `pkg/testing/testing.go:332-363`).
- Assert on `function.yaml` re-read from disk: digest written, comments and
  schema header preserved.
- Cases: happy path; `--no-apply` (no kubectl call at all); push transcript
  without a digest; validate failure stops before apply; Ready after N
  polls; stale Ready with lower `observedGeneration` keeps polling;
  `Ready=False` fails fast; 120 s timeout with a fake clock; the printed
  curl contains `$KRUN_API_KEY` and never a key value.
- Acceptance on kind: `krun deploy --registry localhost:5001` in a vendored
  template ends `Ready=True` and prints three commands (PLAN.md:821-823).

## SPEC RISKs recorded

- The printed logs command needs the jobs namespace (SPEC.md:758) but the
  CLI has no flag or env for it; the default is `krun-jobs` (SPEC section
  12). Print the default; a new flag needs a Decisions row.
- `validate` in-process needs the Function schema from `packages/shared`
  without pulling the server runtime into `npx @krun/cli`; SPEC does not
  say how (subpath export, schema-only package, or bundling). Decisions row
  or BLOCKED.
