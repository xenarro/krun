---
title: Contributing
description: Set up the toolchain, run the checks, follow the commit and branch conventions and the spec-first decision process, and preview this site locally.
sidebar:
  order: 1
---

krun is developed spec-first. [SPEC.md](https://github.com/xenarro/krun/blob/main/SPEC.md)
is the source of truth for behavior,
[PLAN.md](https://github.com/xenarro/krun/blob/main/PLAN.md) holds the build order,
and [docs/STACK.md](https://github.com/xenarro/krun/blob/main/docs/STACK.md) lists every
approved library. Read them before changing behavior.

:::note
A license has not been published yet, so the terms for contributions are not defined.
See [License](/krun/project/license/). Report problems and ideas in
[GitHub issues](https://github.com/xenarro/krun/issues).
:::

## Toolchain

| Tool | Version | Pinned in |
|---|---|---|
| Node.js | 26.7.0 | `.node-version` |
| pnpm | 12.14.0 | `package.json` (`packageManager`) |
| uv | 0.13.1 | CI workflows |
| Python | 3.11 or newer for the SDK (CI tests 3.11 and 3.13) | `sdk/python/pyproject.toml` |
| Helm | 4 (CI uses 4.3.0) | CI workflows |
| Docker | current | for `make docker`, `make e2e` |
| kind | v0.33.0 | `.kind-version`, for the e2e suites |
| kubectl | 1.37 | `test/e2e/README.md` |

Install the locked dependencies with the existing supply-chain policy:

```sh title="Terminal"
pnpm install --frozen-lockfile
make build
```

## Checks

`make check` is the default goal and must pass before every commit.

| Target | What it runs |
|---|---|
| `make check` | `lint`, `test`, then `pnpm exec knip` for unused code and dependencies. |
| `make lint` | Biome and `tsc --noEmit` in every package, then Ruff (check and format) and `mypy --strict` for the Python SDK. |
| `make test` | Every package's Vitest suite, the root tooling tests, and the Python SDK's pytest suite. |
| `make build` | `pnpm -r build`. |
| `make generate` | Every `scripts/gen-*.ts`: the CRD, the editor JSON Schema, both OpenAPI documents and the chart README. |
| `make docker` | Builds the platform image (`IMAGE ?= krun:local`). |
| `make helm-lint` | Lints the chart in both modes and validates the alert rules with promtool. |
| `make e2e` | The native scenario corpus on a disposable kind cluster, in both modes. |
| `make e2e-quickstart` | The README quickstart on a fresh cluster per mode. |
| `make bench` | The native Job benchmark; separate from `make e2e`. |
| `make kind-up`, `make kind-down` | Create or remove the owned disposable cluster and registry. |

### Generated files

These files are generated and committed; CI runs `make generate` and fails on any diff
or untracked output. Change their sources, regenerate, and commit both:

- `deploy/crds/functions.krun.io.yaml` and
  `deploy/helm/krun/templates/crd-functions.yaml`, from
  `packages/shared/src/functions/schema.ts`;
- `docs/schemas/function-v1alpha1.json`, the editor schema;
- `docs/api/openapi-public.json` and `docs/api/openapi-internal.json`, from the routes;
- `deploy/helm/krun/README.md`, from `README.md.gotmpl` and `values.yaml` through
  helm-docs 1.14.2. Never edit it by hand.

## Commits and branches

- **Conventional Commits** for every commit, pull request title and squash merge:
  `<type>(<optional-scope>): <short-imperative-description>`, for example
  `feat(store): claim query with lease`. Mark breaking changes with `!` and a
  `BREAKING CHANGE:` footer.
- **Branch names** follow `<type>/<short-kebab-case-description>`, using `feat/`,
  `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `build/`, `ci/` or `perf/`, for
  example `feat/admin-health-telemetry`. Do not use bare task-id branch names.
- Open a pull request to `main` and merge it when CI is green. Never push to `main`
  directly; auto-merge is not enabled. Only the owner creates `v*` tags.
- Never commit secrets. Tests generate their own keys.

## The decision process

- A change that contradicts SPEC.md needs its row in SPEC.md section 15 (Decisions)
  added or rewritten first, then the code. The table holds only the decisions in
  force; history lives in git.
- A new dependency needs a Decisions row with a one-line reason and an entry in
  docs/STACK.md before it is added.
- Never build anything SPEC.md section 1 lists as a non-goal, and add no options,
  flags or abstractions that no task asks for. Anything not in SPEC.md is out of
  scope until a Decisions row adds it.
- Some decisions belong to the owner only: published package names, the public API
  shape, the security policy in SPEC.md section 9 and the non-goals.

## CI

Pull requests run `.github/workflows/ci.yml`: SDK jobs on Python 3.11 and 3.13 and
Node.js 22 and 26, a `verify` job (`make check`, a clean `make generate`, the image
build and smoke tests, `make helm-lint`, `pnpm audit` and a Trivy scan) and a `kind` job
running `make e2e`. Changes to the README, the CLI, the Node SDK, the chart or the
quickstart scripts also run the 30-minute-per-mode quickstart matrix. Workflows use
read-only default permissions and actions pinned by commit SHA.

## Work on this site

The site lives in `site/` (Astro Starlight). Hand-written pages are under
`site/src/content/docs/`. The long references (`docs/API.md`, `docs/INTERNAL-API.md`,
`docs/OPERATIONS.md`, `docs/RELEASE.md`, the chart README and both SDK READMEs) are
mirrored, never copied by hand: edit the source file and regenerate.

```sh title="Terminal"
pnpm install --frozen-lockfile
pnpm --filter @krun/site run dev          # local preview
pnpm --filter @krun/site run site:check   # production build and link check
node site/scripts/sync-docs.ts --check    # are the mirrored pages current?
```

Site links are written with the `/krun/` base path, for example
`/krun/guides/cli/`. Mark anything not implemented as planned, and ground every
command, option and default in the code.
