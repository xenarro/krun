# Dockerfile, ci.yml, renovate, release.yml, benchmarks

Generic technique: `dockerfile-optimise` (multi-stage, distroless, digest
pinning) and `github-actions-advanced` (SHA-pinned actions, least-privilege
`permissions`, OIDC trusted publishing). This file holds the krun-specific
rules with their PLAN/SPEC lines; where a generic skill disagrees, PLAN wins.

## Dockerfile (P0.3, PLAN.md:166-171)

| Rule | Why |
|---|---|
| Multi-stage: `build` stage on a Node 24 image pinned by digest runs `pnpm install --frozen-lockfile` and `pnpm -r build` (TypeScript 7 native `tsc` emitting `dist/` per package) | reproducible `dist/` per package (PLAN.md:41-42, 166-167) |
| The build tsconfig excludes `**/*.test.ts` and `vitest.config.ts` | test code never reaches `dist/` or the image; `tsc --noEmit` in `make lint` still type-checks it |
| Then `pnpm install --prod --frozen-lockfile` in the build stage (or a `deps` stage) so the runtime tree has no dev dependencies (`vitest`, `@effect/vitest`, `fast-check`, testcontainers, `typescript`, Biome) | PLAN.md:167, 76-78 |
| Copy every workspace package's `dist/`, `packages/cli/dist` included, plus the pruned `node_modules` and `bin/krun.js` onto the final stage | `krun validate` dispatches to `packages/cli/dist/validate.js` (PLAN.md:168, 354-356; SPEC.md:54-55) |
| Final base: distroless Node.js, glibc, pinned by digest | `better-sqlite3` prebuilt binary links glibc (PLAN.md:168-169); digest pin feeds Renovate (PLAN.md:176) |
| `USER 65532`, `ENTRYPOINT ["node", "bin/krun.js"]` | non-root matches the chart securityContext (SPEC.md:1320-1321); four entrypoints by argument (SPEC.md:54-55) |
| Read-only root filesystem works: nothing writes outside `/tmp` and `KRUN_DB_PATH` | the chart mounts `/tmp` as emptyDir (SPEC.md:1322-1323) |
| `.dockerignore` excludes `test/`, `.git`, `node_modules` of the host, `deploy/`, `docs/` | smaller context, the fake kube never ships |
| Build args `KRUN_VERSION`, `KRUN_COMMIT` into OCI labels `org.opencontainers.image.{version,revision,source}` | `release.yml` stamping (PLAN.md:217-219); support reads them from the image |

Acceptance: `make docker` builds; `docker run <image> gateway` prints
`gateway` (PLAN.md:170-171); from P2.5 `docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
prints one line and exits 1 (PLAN.md:359-361).

Open points: if better-sqlite3 ships no Node 24 prebuilt (UNVERIFIED,
docs/research/node-stack-facts.md:670-675) the build stage needs `python3`, `make`, `g++`;
with pnpm 10 add `onlyBuiltDependencies: [better-sqlite3]` to
`pnpm-workspace.yaml` (UNVERIFIED, docs/research/node-stack-facts.md:805-809). Confirm in
P0.1 with `node -e "require('better-sqlite3')"` inside the image.

## `ci.yml` (P0.4, PLAN.md:172-178; P4.12, PLAN.md:609-611)

Triggers: `push` to `main` and `pull_request`. Top-level `permissions: contents: read`;
jobs raise only what they need. Every `uses:` pinned to a commit SHA with a
version comment (`github-actions-advanced`).

| Job | Steps | Notes |
|---|---|---|
| `check` | checkout, pnpm + Node 24 from `.node-version`, `uv`, `pnpm install --frozen-lockfile`, `make check` (Biome, `tsc --noEmit`, `pnpm -r exec vitest run`, pytest) | the Phase 0 gate (PLAN.md:146); Postgres and MinIO via testcontainers need Docker on the runner; set `TESTCONTAINERS_RYUK_DISABLED=true` if Ryuk cannot run privileged (docs/research/node-stack-facts.md:785-786) |
| `generate` | `make generate && git diff --exit-code` | catches a stale CRD, OpenAPI document or chart README (PLAN.md:173, 208, 385, 456, 756) |
| `docker` | `make docker`, Trivy `--severity CRITICAL --ignore-unfixed --exit-code 1` on the image | PLAN.md:173-175 |
| `helm-lint` | install Helm 4 pinned to the Makefile's `HELM_VERSION` (SHA-pinned setup action with an explicit `version`), `make helm-lint` including the chart render tests; from P7.7 also `promtool check rules` on the rendered PrometheusRule | PLAN.md:52-54, 174, 775 |
| `audit` | `pnpm audit --prod --audit-level=critical` | PLAN.md:174 |
| `actionlint` | `actionlint` on `.github/workflows/` | P0.4 acceptance (PLAN.md:177) |
| `kind-e2e` (P4.12) | `helm/kind-action` pinned to the same kind version as the Makefile, the same pinned Helm 4, `make kind-up`, `make e2e` (Vitest with `test/e2e/vitest.config.ts`), upload gateway and scheduler logs as artifacts on failure | PLAN.md:609-611; runs on pull requests and main; from P9.4 budget 2 x 1800 s for the quickstart (PLAN.md:883-884) |
| `release-dry-run` (P0.9) | the `release.yml` dry-run job invoked on pull requests | PLAN.md:221-222 |

- Cache pnpm store keyed on `pnpm-lock.yaml`; never cache `node_modules`.
- `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`
  on pull requests only.
- Secrets in CI: none for `ci.yml`; tests generate their own keys
  (PLAN.md:33). `GITHUB_TOKEN` only in `release.yml`.
- `actionlint` and `gh run watch` are the acceptance (PLAN.md:177-178).

## `renovate.json` (P0.4, PLAN.md:176)

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":pinDigests", "helpers:pinGitHubActionDigests"],
  "enabledManagers": ["npm", "dockerfile", "github-actions", "pep621", "helm-values", "kubernetes"],
  "packageRules": [
    { "matchManagers": ["npm"], "rangeStrategy": "bump", "matchDepTypes": ["dependencies", "devDependencies"] },
    { "matchPackageNames": ["effect", "@effect/platform-node", "@effect/vitest"], "groupName": "effect" },
    { "matchDepNames": ["kind", "kindest/node"], "groupName": "kind" }
  ]
}
```

Scope is npm, Docker digests and Actions (PLAN.md:176). `package.json`
keeps the ranges from docs/STACK.md (`~4.0.6` for Effect, carets
elsewhere) and `pnpm-lock.yaml` pins exact versions, so Renovate bumps
ranges instead of pinning them. Effect packages move together in one pull
request, always the same version (docs/STACK.md section 6); a major of any
runtime dependency needs a Decisions row before merge. The `kubernetes`
manager covers `test/e2e/*.yaml` image digests (MinIO, Postgres, registry).
`kind` and `helm/kind-action` must move together (PLAN.md:56-57): group
them. Renovate itself is a CI tool, not a dependency (PLAN.md:56).

## `release.yml` (P0.9 PLAN.md:213-222; P9.5 PLAN.md:885-892; SPEC.md:1413-1417)

### Owner preconditions: BLOCKED when unmet (PLAN.md:213-217, 23-26)

| Precondition | Fallback | Who decides |
|---|---|---|
| npm scope `@krun` available (`@krun/sdk`, `@krun/cli`, SPEC.md:660-662, 770-771) | `@xenarro/krun-sdk` (PLAN.md:216) | owner, Decisions row |
| PyPI project `krun` available (SPEC.md:661-662) | `krun-sdk` (PLAN.md:216) | owner, Decisions row |
| GHCR owner `xenarro` for `ghcr.io/xenarro/krun` and `oci://ghcr.io/xenarro/charts/krun` (SPEC.md:1226-1229) | none | owner |
| npm and PyPI OIDC trusted publishing configured for the repository | none | owner |
| `GITHUB_TOKEN` with `packages: write` for GHCR | n/a | workflow `permissions` |

Write `BLOCKED P0.9: <which precondition>` and continue (PLAN.md:27-28).
The dry-run job must still pass on pull requests without any of them.

### Jobs

| Job | Trigger | Steps |
|---|---|---|
| `dry-run` | `pull_request`, and reused by `ci.yml` | stamp the version from a synthetic `v0.0.0-pr<N>` into every `package.json`, `sdk/python/pyproject.toml`, `deploy/helm/krun/Chart.yaml` `version` and `appVersion` (PLAN.md:217-219); `pnpm -r build`; `pnpm pack` both packages; `uv build`; `helm package`; `make docker`; `git diff --stat` printed; no push, no publish |
| `release` | `push` tags `v*` (owner-only, PLAN.md:22) | `permissions: { contents: write, packages: write, id-token: write }`; stamp the tag; build; push the image to GHCR by digest; `cosign sign --yes <image>@<digest>` keyless; `syft <image>@<digest> -o spdx-json`; `cosign attest --yes --type spdxjson --predicate sbom.spdx.json <image>@<digest>`; `helm package` then `helm push` to `oci://ghcr.io/xenarro/charts`; `cosign sign` the chart digest; publish `@krun/sdk` and `@krun/cli` with `npm publish --provenance --access public` under OIDC; `uv publish` with OIDC; create the GitHub release with the `CHANGELOG.md` section for the tag |

- Version stamping is a script (`scripts/stamp-version.ts`) with a Vitest
  test that `make test` collects (`pnpm -r` skips the workspace root, so
  `make test` also runs the root config's project for `scripts/`):
  given `v1.2.3` every file carries `1.2.3` and `Chart.yaml` `appVersion`
  equals `version`; `v` prefix stripped; a tag not matching SemVer fails.
- One SemVer version per tag for image, chart, SDKs and CLI
  (SPEC.md:1413-1415); the templates' pinned SDK version must equal the
  workspace version (knative-func lesson in SKILL.md).
- `CHANGELOG.md` per tag (PLAN.md:221-222): the release pull request adds
  the section; the workflow fails when the tag's section is missing.
- Post-release acceptance (P9.5, PLAN.md:889-892): `helm install` from the
  OCI chart, `npx @krun/cli init`, `pip install krun`, `cosign verify` with
  `--certificate-identity-regexp` for the workflow and
  `--certificate-oidc-issuer https://token.actions.githubusercontent.com`.
- Never store a long-lived npm or PyPI token in the repository secrets when
  OIDC is the precondition; if the owner has not configured OIDC the job is
  BLOCKED, not worked around.

## Benchmarks (P9.3, PLAN.md:867-870)

- `scripts/bench.ts` submits 500 runs of a 10 s `curlimages/curl` function on
  kind, records per run: submit time, first `RUNNING` observation (poll
  `GetRun` or `WatchRun`), terminal time; one batch of `exit 1` runs for
  failure-detection latency.
- Report p50 and p95 submit-to-`RUNNING`, p95 failure detection, sustained
  runs per second; compare with docs/PROBLEM.md:79-81 (p95 under 15 s,
  crash to failed under 10 s) and SPEC.md:1421-1425.
- Write the numbers with the conditions (kind node count, runner size,
  image cached) into README and docs/OPERATIONS.md (PLAN.md:869-870);
  `krun_terminal_detect_seconds` from `/metrics` is the second source.
- Keep the script out of `make e2e`; it is run on demand and in the P9.3
  pull request.
