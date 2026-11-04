---
title: CLI reference
description: Every krun command, flag, default, environment variable, output stream and exit code, read from the CLI and server source.
sidebar:
  order: 2
---

The `krun` CLI (`packages/cli`, planned npm package `@krun/cli`, not yet published)
requires Node.js 26. Arguments are parsed strictly: unknown flags are errors. For a
task-oriented walkthrough, see [Using the CLI](/krun/guides/cli/).

## krun

```text title="Usage"
Usage: krun <init|deploy|validate> [arguments]
```

`krun --help` prints the usage on stdout and exits 0. A missing or unknown command
prints it on stderr and exits 1.

From a checkout, run `make build` and invoke `node packages/cli/dist/main.js`. The
platform container image dispatches a wider set of commands:

```text title="Platform image usage"
Usage: krun <gateway|scheduler|migrate|validate|init|deploy> [arguments]
```

## krun init

```text title="Usage"
Usage: krun init [--help] --lang node|python [--name <function>] <dir>
```

Scaffolds a function project into `<dir>`.

| Argument | Default | Notes |
|---|---|---|
| `--lang node\|python` | prompt on a TTY | Required on a non-interactive terminal. |
| `--name <function>` | the base name of `<dir>` | DNS-1123 label of at most 63 characters. |
| `<dir>` | required | Exactly one directory; it must be absent, or contain only dotfiles other than `.gitignore` and `.dockerignore`. |
| `--help` | | Prints the usage on stdout. |

Generated files:

| Language | Files |
|---|---|
| `node` | `handler.js`, `handler.test.js`, `package.json`, `Dockerfile`, `.dockerignore`, `.gitignore`, `function.yaml`, `README.md` |
| `python` | `handler.py`, `tests/test_handler.py`, `pyproject.toml`, `Dockerfile`, `.dockerignore`, `.gitignore`, `function.yaml`, `README.md` |

- The SDK dependency is pinned to the CLI's own version: `"@krun/sdk": "^X.Y.Z"` for
  Node.js and `krun~=X.Y.Z` for Python.
- `function.yaml` uses `image: REPLACE_WITH_DIGEST`, a starter `inputSchema` and
  `heartbeatTimeout: 5m`. The generated file is checked against the starter schema
  before `init` reports success.
- Existing files are never overwritten. On failure, every file and directory `init`
  created is removed again.
- On success `init` prints the next steps to stderr: `npm install; npm test` or
  `uv sync; uv run pytest`.

| Exit code | Meaning |
|---|---|
| 0 | Project created, or `--help`. |
| 1 | Invalid arguments, invalid name, non-empty target, missing `--lang` without a TTY, or a write failure. |
| 130 | The language prompt was cancelled. |

## krun deploy

```text title="Usage"
Usage: krun deploy [--no-apply] [--namespace <ns>] [--api-url <url>] [--registry <registry>] [dir]
```

Builds, pushes, pins, validates and applies a function project, then waits for it to
become Ready.

| Argument | Environment fallback | Default | Notes |
|---|---|---|---|
| `--registry <registry>` | `KRUN_REGISTRY` | required | Repository prefix without credentials, scheme or tag. |
| `--namespace <ns>` | `KRUN_NAMESPACE` | `krun` | DNS label; the krun namespace that holds Functions. |
| `--api-url <url>` | `KRUN_API_URL` | none | `http` or `https`, without credentials, query or fragment. Used only in the printed commands. |
| `--no-apply` | | off | Build, push, pin and validate only; no cluster access. |
| `[dir]` | | `.` | The project directory containing `function.yaml`. At most one. |
| `--help` | | | Prints the usage and the defaults on stdout. |

Other environment variables:

| Variable | Default | Effect |
|---|---|---|
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | Namespace used in the printed `kubectl logs` command; must be a DNS label. |
| `KRUN_MAX_QUEUED`, `KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS`, `KRUN_WEBHOOK_ALLOWED_HOSTS` | platform defaults | Ceilings for the built-in `krun validate` step. |
| `NO_COLOR` | unset | When set, progress is plain text instead of a spinner. |

The CLI never reads `KRUN_GATEWAY_URL` and never reads `KRUN_API_KEY`; the printed
commands reference `$KRUN_API_KEY` literally.

Steps, in order:

1. Read `function.yaml`, which must hold exactly one valid `krun.io/v1alpha1`
   `Function` with `metadata.name` and `spec.image`. A `metadata.namespace`, if
   present, must equal the selected namespace.
2. `docker build -t <registry>/<name>:krun-<uuid> <dir>`.
3. `docker push` of that tag.
4. Take the digest from the push output when it names exactly one, otherwise from
   `docker inspect` `RepoDigests`.
5. Write `spec.image: <registry>/<name>@sha256:<digest>` into `function.yaml`,
   preserving comments. The write is atomic and fails if the file changed meanwhile.
6. Validate the pinned file as `krun validate` does; the result lines and the
   ceilings line go to stderr.
7. With `--no-apply`: print the pinned image to stdout and stop.
8. `kubectl apply -f function.yaml -n <namespace>` with your current kubectl context.
9. Poll `kubectl get functions.krun.io <name> -n <namespace> -o json` every second
   until the current generation reports `Ready=True`. Fail at once on `Ready=False`,
   or after 120 seconds.
10. Print to stdout: a first-run `curl` against `/v1/functions/<name>/runs` with input
    `{"input":{"name":"world"}}`, `kubectl logs -f -n <jobs namespace> 'job/krun-<id>'`,
    and a GetRun `curl`.

Progress goes to stderr: a spinner on an interactive terminal, or one line per step
with `(still working)` every 10 seconds otherwise. Failures print the message and a
`Try this:` hint on stderr and exit 1.

| Exit code | Meaning |
|---|---|
| 0 | Deployed and Ready, `--no-apply` finished, or `--help`. |
| 1 | Any failure: arguments, `function.yaml`, Docker, digest, validation, kubectl, or readiness. |

## krun validate

```text title="Usage"
Usage: krun validate [--help] <path>...
```

Runs the CRD schema and the platform's second-layer checks over every `Function`
document in the given paths. It never contacts a cluster or reads configuration files.

- Files are read in argument order. For a directory, its immediate entries ending in
  `.yaml` or `.yml` are read in sorted order; subdirectories are not searched.
- Documents whose `kind` is not `Function` are skipped. Multi-document YAML is
  supported.
- Ceilings come from `KRUN_MAX_QUEUED`, `KRUN_MAX_ACTIVE_DEADLINE`,
  `KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS` and
  `KRUN_WEBHOOK_ALLOWED_HOSTS`, with the platform defaults when unset.

Output:

| Stream | Content |
|---|---|
| stdout | `OK "<absolute file>": <name>` or `FAIL "<absolute file>": <name>: <reason>: <message>` for each Function. |
| stderr | `krun validate ceilings: {...}` with the values used, then any file or YAML errors. |

`<reason>` is `CRDSchema` for a document that fails the CRD schema, or a `Ready`
reason such as `SchemaInvalid`, `DeadlineAboveCeiling` or `RegistryNotAllowed` for the
second layer. An unreplaced starter image fails with
`spec.image is REPLACE_WITH_DIGEST; replace it with the deployed image digest`.

| Exit code | Meaning |
|---|---|
| 0 | Every Function passed, or `--help`. |
| 1 | Any failure, an unreadable path, invalid YAML, no Function document at all, invalid ceilings, or no paths. |

## Server commands

The gateway and scheduler take environment variables only; the only flag is `--help`.

```text title="Usage"
Usage: krun gateway [--help]
Usage: krun scheduler [--help]
Usage: krun migrate
```

- `krun gateway` serves the public, internal and admin listeners.
- `krun scheduler` serves the admin listener and, as leader, runs the loops. It
  requires `KRUN_POD_NAME`.
- `krun migrate` reads only the `KRUN_DB_*` variables and applies pending migrations.
  It warns and exits 0 when the database has migrations unknown to the binary and
  nothing pending, and exits 1 when unknown migrations coexist with pending ones.

See the [configuration reference](/krun/reference/configuration/) for every variable.
