# Dockerfile, ci.yml, renovate, release.yml, benchmarks

Generic technique: `dockerfile-optimise`, `github-actions-advanced`,
`building-ci-pipelines` (docs/STACK.md section 5 "Build and CI" row).
Krun-specific rules only; where a generic skill disagrees, PLAN wins.

## Build facts (re-verified 2026-10-23 against npm tarballs)

- `typescript` 7.0.2 is the native compiler: `bin.tsc` (`bin/tsc`)
  resolves the per-platform optional dependency
  `@typescript/typescript-<platform>-<arch>`. Never install
  with `--no-optional` or a lockfile pruned for another platform. The
  Docker build stage installs on the platform it builds for. The root
  export is only a version file; the compiler API is under
  `./unstable/*`. VERIFIED.
- `vitest` 5.0.5: engines Node `^22.12.0 || ^24.0.0 || >=26.0.0`, which
  covers krun's Node 26 and the Node SDK's Node 22 floor. `vite`
  `^6.4.0 || ^7.0.0 || ^8.0.0` is a non-optional peer, installed by pnpm's
  `autoInstallPeers` (default true); listing `vite` explicitly needs a
  Decisions row (PLAN.md:29-30). Dev-only: never in the runtime image.
  VERIFIED (`package.json`).
- `testcontainers` 12.2.1 needs Node `>= 22.22`; krun runs on Node 26.
- No native addons (D36, STACK.md principle 8). SQLite is Node 26's
  built-in `node:sqlite`; every runtime package is plain JavaScript. The
  build stage needs no python3, make or C++ compiler; the final base has
  no libc constraint. P0.3 proves it: after `pnpm install --prod`,
  `find node_modules -name '*.node'` prints nothing. A hit means a native
  dependency slipped in and needs a Decisions row.
- `node:sqlite` is a release candidate in Node 26. Build and runtime Node
  versions must match `.node-version` exactly (same major and minor), so
  a test run on one minor never ships on another.
- pnpm 12 (`../../pnpm/references/features-supply-chain-security.md`):
  build-script approval is `allowBuilds` in `pnpm-workspace.yaml` (not
  `onlyBuiltDependencies`). With `strictDepBuilds` default true, an
  unreviewed build script fails install (`ERR_PNPM_IGNORED_BUILDS`).
  Approve or deny each one the first install lists. The runtime tree
  should list none. Dev tools may; deny unless the tool fails without it.

## Dockerfile (P0.3, PLAN.md:166-171)

| Rule | Why |
|---|---|
| Multi-stage: `build` stage on a Node 26 image pinned by digest runs `pnpm install --frozen-lockfile` and `pnpm -r build` (TypeScript 7 `tsc` emitting `dist/` per package); no `apt-get install` of build tools in any stage | PLAN.md:42, 170-175; D36 |
| The build tsconfig excludes `**/*.test.ts`, `**/testing/**` and `vitest.config.ts` | test code and test layers never reach `dist/` or the image; `tsc --noEmit` in `make lint` still type-checks them |
| Then `pnpm install --prod --frozen-lockfile` (or `pnpm deploy --prod` per app) so the runtime tree has no dev dependencies: no `typescript`, `vitest`, `vite`, `@effect/vitest`, `fast-check`, testcontainers, Biome | PLAN.md:167, 76-78 |
| Copy every workspace package's `dist/`, `packages/cli/dist` included, plus the pruned `node_modules` and `bin/krun.js` onto the final stage | `krun validate` dispatches to `packages/cli/dist/validate.js` (PLAN.md:168, 354-355; SPEC.md:54-55) |
| Final base: distroless Node.js 26, pinned by digest | PLAN.md:170-175; no native addon, so libc does not matter; the exact distroless repository name for Node 26 is UNVERIFIED, check in P0.3; digest pin feeds Renovate (P0.4) |
| `USER 65532`, `ENTRYPOINT ["node", "bin/krun.js"]` | non-root matches the chart securityContext (SPEC.md:1320-1321); four entrypoints by argument (SPEC.md:54-55) |
| Read-only root filesystem works: nothing writes outside `/tmp` and `KRUN_DB_PATH` | the chart mounts `/tmp` as emptyDir (SPEC.md:1322-1323) |
| `.dockerignore` excludes `test/`, `.git`, host `node_modules`, `deploy/`, `docs/` | smaller context; the fake kube never ships |
| Build args `KRUN_VERSION`, `KRUN_COMMIT` into OCI labels `org.opencontainers.image.{version,revision,source}` | `release.yml` stamping (PLAN.md:217-220) |

Acceptance: `make docker` builds; `docker run <image> gateway` prints
`gateway` (PLAN.md:174-175). From P2.5,
`docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
prints its line and exits 1 (PLAN.md:359-361).

## `ci.yml` (P0.4, PLAN.md:176-182; P4.12, PLAN.md:609-623)

Triggers: `push` to `main` and `pull_request` (PLAN.md:172). Top-level
`permissions: contents: read`; jobs raise only what they need. Pin every
`uses:` to a commit SHA with a version comment (`github-actions-advanced`).

| Job | Steps | Notes |
|---|---|---|
| `check` | checkout, pnpm + Node 26 from `.node-version` (`actions/setup-node` `node-version-file`), `uv` (Python 3.11+), `pnpm install --frozen-lockfile`, `make check` | the Phase 0 gate; `make check` contents in SKILL.md "Runner and type checking" (lint adds `ruff` on `sdk/python`). The store contract suite runs on a `postgres:18` testcontainer and P6.1 on MinIO, so Docker must be on the runner; set `TESTCONTAINERS_RYUK_DISABLED=true` if Ryuk cannot run privileged |
| `sdk-node` | matrix `node: [22, 26]`: checkout, pnpm, `actions/setup-node` with the matrix version, `pnpm install --frozen-lockfile --filter @krun/sdk...` (the SDK and its dev dependencies only), `pnpm --filter @krun/sdk exec vitest run` | the Node SDK supports Node 22 or newer (SPEC.md section 14); Vitest 5 supports Node 22.12 or newer. The only job with a hard-coded Node version list; the rest of the workspace is tested on Node 26 from `.node-version`. Exact filtered-install flags UNVERIFIED against pnpm 12, check in P0.4 |
| `generate` | `make generate && git diff --exit-code` | catches a stale CRD, editor schema, OpenAPI document or chart README (PLAN.md:139-140, 173, 209) |
| `docker` | `make docker`, Trivy `--severity CRITICAL --ignore-unfixed --exit-code 1` on the image | PLAN.md:173-175 |
| `helm-lint` | install Helm 4 at the Makefile's `HELM_VERSION`, `make helm-lint` including the chart render tests; from P7.7 also `promtool check rules` on the rendered PrometheusRule | PLAN.md:52-54, 174, 775 |
| `audit` | `pnpm audit --prod --audit-level=critical` | PLAN.md:174 |
| `actionlint` | `actionlint` on `.github/workflows/` | P0.4 acceptance (PLAN.md:176-177) |
| `kind-e2e` (P4.12) | `helm/kind-action` with `version_file` and `install_only: true`, the same pinned Helm 4, `make kind-up` with a `kindest/node` image of 1.33 or newer pinned by digest, `make e2e`, upload gateway and scheduler logs as artifacts on failure | PLAN.md:55, 609-623; runs on pull requests and main; from P9.4 budget 2 x 1800 s for the quickstart (PLAN.md:880-884) |
| `release-dry-run` (P0.9) | the `release.yml` dry-run job invoked on pull requests | PLAN.md:221-222 |

- Vitest in CI: GitHub Actions sets `CI=true`, so `allowOnly` is false (a
  stray `.only` fails the run) and the `github-actions` reporter is added
  (Vitest 5.0.5 `configDefaults`). JSON reporters write to a file by
  default in Vitest 5; pass `outputFile` when uploading results.
- `pnpm audit --prod --audit-level=critical` fails on a transitive
  critical with no fix. Do not suppress: open a Decisions row or pin
  (PLAN.md:174).
- Trivy with `--ignore-unfixed` still fails on fixable criticals in the
  distroless base. Bump the digest; never widen `--severity` (PLAN.md:180).
- Ryuk cannot run privileged: `TESTCONTAINERS_RYUK_DISABLED=true` (the
  variable exists in testcontainers 12.2.1) plus a `docker rm` cleanup
  step.
- Cache the pnpm store keyed on `pnpm-lock.yaml`. Never cache
  `node_modules`.
- `concurrency: { group: ${{ github.workflow }}-${{ github.ref }},
  cancel-in-progress: true }` on pull requests only.
- Secrets: none for `ci.yml`; tests generate their own keys (PLAN.md:33).
  `GITHUB_TOKEN` only in `release.yml`.
- Acceptance: `actionlint` and `gh run watch` (PLAN.md:176-178).

## `renovate.json` (P0.4, PLAN.md:176)

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":pinDigests", "helpers:pinGitHubActionDigests"],
  "enabledManagers": ["npm", "nodenv", "dockerfile", "github-actions", "pep621", "helm-values", "kubernetes"],
  "packageRules": [
    { "matchManagers": ["npm"], "rangeStrategy": "bump", "matchDepTypes": ["dependencies", "devDependencies"] },
    { "matchPackageNames": ["effect", "@effect/platform-node", "@effect/vitest", "@effect/opentelemetry"], "groupName": "effect" },
    { "matchPackageNames": ["@opentelemetry/**"], "groupName": "opentelemetry" },
    { "matchPackageNames": ["@opentelemetry/sdk-trace-node", "@opentelemetry/sdk-trace-base", "@opentelemetry/sdk-metrics", "@opentelemetry/resources"], "allowedVersions": "<3" },
    { "matchPackageNames": ["@opentelemetry/exporter-prometheus", "@opentelemetry/exporter-trace-otlp-http", "@opentelemetry/api-logs", "@opentelemetry/sdk-logs"], "allowedVersions": "<0.300" },
    { "matchDepNames": ["node"], "groupName": "node" },
    { "matchPackageNames": ["testcontainers", "@testcontainers/postgresql", "@testcontainers/minio"], "groupName": "testcontainers" },
    { "matchUpdateTypes": ["major"], "matchDepTypes": ["dependencies"], "dependencyDashboardApproval": true },
    { "matchDepNames": ["kind", "kindest/node", "helm/kind-action"], "groupName": "kind" }
  ]
}
```

- `package.json` keeps the docs/STACK.md ranges (`~4.0.6` for Effect,
  carets elsewhere, STACK.md:35-36); `pnpm-lock.yaml` pins exact versions;
  Renovate bumps ranges.
- `effect` group: Effect packages, `@effect/opentelemetry` included, move
  together at one version (STACK.md section 6).
- `allowedVersions`: OpenTelemetry SDK stays on the 2.x and 0.2xx lines
  `@effect/opentelemetry` 4.0.6 peers on (STACK.md 2.6).
- Dashboard approval: a runtime-dependency major needs a Decisions row
  (STACK.md section 6).
- Node: the `nodenv` manager bumps `.node-version`; the `dockerfile`
  manager bumps the Node 26 base digests. The `node` group keeps them in
  one pull request, so CI and the image never run different Node versions
  (manager and dep names UNVERIFIED against current Renovate docs; check
  in P0.4).
- Scope is npm, Docker digests and Actions (PLAN.md:176). The `kubernetes`
  manager covers `test/e2e/*.yaml` image digests (MinIO, Postgres,
  registry). The kind version file needs a `customManagers` regex entry
  (shape UNVERIFIED against current Renovate docs; check in P0.4). `kind`
  and `helm/kind-action` must move together (PLAN.md:56-57, 609-610).
  Renovate itself is a CI tool, not a dependency (PLAN.md:56).
- Before v0.1.0, re-check that `effect/sql` is still unstable and
  `@effect/sql-kysely` still Effect 3 only (STACK.md:236-238). Do it in
  the P9.5 release pull request.

## `release.yml` (P0.9 PLAN.md:213-222; P9.5 PLAN.md:885-892; SPEC.md:1410-1417)

### Owner preconditions: BLOCKED when unmet (PLAN.md:213-217, 23-28)

| Precondition | Fallback | Who decides |
|---|---|---|
| npm scope `@krun` available (`@krun/sdk`, `@krun/cli`, SPEC.md:660-662, 770-771) | `@xenarro/krun-sdk` (PLAN.md:216) | owner, Decisions row |
| PyPI project `krun` available (SPEC.md:661-662) | `krun-sdk` (PLAN.md:216) | owner, Decisions row |
| GHCR owner `xenarro` for `ghcr.io/xenarro/krun` and `oci://ghcr.io/xenarro/charts/krun` (SPEC.md:1225-1226, 1229) | none | owner |
| npm and PyPI OIDC trusted publishing configured for the repository | none | owner |
| `GITHUB_TOKEN` with `packages: write` for GHCR | n/a | workflow `permissions` |

Write `BLOCKED P0.9: <which precondition>` and continue (PLAN.md:27-28).
The dry-run job must still pass on pull requests without any of them.

### Jobs

| Job | Trigger | Steps |
|---|---|---|
| `dry-run` | `pull_request`, and reused by `ci.yml` | stamp a synthetic `0.0.0-pr<N>` into every `package.json`, `sdk/python/pyproject.toml`, `deploy/helm/krun/Chart.yaml` `version` and `appVersion` (P0.9); `pnpm -r build`; `pnpm exec publint` and `pnpm exec attw --pack` in `packages/sdk-node` and `packages/cli`; `pnpm pack` both packages; `uv build`; `helm package`; `make docker`; `git diff --stat` printed; no push, no publish |
| `release` | `push` tags `v*` (owner-only, PLAN.md:22) | `permissions: { contents: write, packages: write, id-token: write }`; stamp the tag; build; push the image to GHCR and read its digest; `cosign sign --yes <image>@<digest>` keyless; `syft <image>@<digest> -o spdx-json=sbom.spdx.json`; `cosign attest --yes --type spdxjson --predicate sbom.spdx.json <image>@<digest>`; `helm package` then `helm push` to `oci://ghcr.io/xenarro/charts`; `cosign sign` the chart digest; `publint` and `attw --pack` on `@krun/sdk` and `@krun/cli`, failing the job before anything is published to npm (P9.5); publish both with `npm publish --provenance --access public` under OIDC; `uv publish` with OIDC; create the GitHub release with the `CHANGELOG.md` section for the tag |

- Version stamping is a script (`scripts/stamp-version.ts`) with a Vitest
  test in the root project (`pnpm -r` skips the workspace root, so
  `make test` runs it explicitly). Given `v1.2.3`, every file carries
  `1.2.3` and `Chart.yaml` `appVersion` equals `version`; the `v` prefix
  is stripped; a tag not matching SemVer fails. It is a build tool, not
  application code: run with `node scripts/stamp-version.ts` (type
  stripping; erasable syntax only, STACK.md:123-125).
- `publint` checks `package.json` `exports`, `files` and `types` against
  the packed contents. `attw --pack` (`@arethetypeswrong/cli`) packs the
  package and checks that its types resolve under every module resolution
  mode. That matters for `@krun/sdk`: other teams' builds import it on
  Node 22 or newer (SPEC.md section 14). Both are dev dependencies
  (STACK.md section 3); exact CLI flags UNVERIFIED, check in P0.9.
- One SemVer version per tag for image, chart, SDKs and CLI
  (SPEC.md:1413-1416). The templates' pinned SDK version must equal the
  workspace version.
- `CHANGELOG.md` per tag (PLAN.md:221-222): the release pull request adds
  the section; the workflow fails when the tag's section is missing.
- Post-release acceptance (P9.5, PLAN.md:905-911): `helm install` from the
  OCI chart, `npx @krun/cli init`, `pip install krun`, `cosign verify` with
  `--certificate-identity-regexp` for the workflow and
  `--certificate-oidc-issuer https://token.actions.githubusercontent.com`.
- Never store a long-lived npm or PyPI token in repository secrets when
  OIDC is the precondition. Owner has not configured OIDC? The job is
  BLOCKED, not worked around.

## Benchmarks (P9.3, PLAN.md:867-870)

- `scripts/bench.ts` submits 500 runs of a 10 s `curlimages/curl` function
  on kind. Per run it records submit time, first `RUNNING` observation
  (poll `GetRun` or `WatchRun`) and terminal time. One batch of `exit 1`
  runs measures failure-detection latency. It is a script on real time,
  not a Vitest benchmark.
- Report p50 and p95 submit-to-`RUNNING`, p95 failure detection,
  sustained runs per second. Compare with docs/PROBLEM.md:79-81 (p95 under
  15 s, crash to failed under 10 s) and SPEC.md:1421-1423.
- Write the numbers with the conditions (kind node count, runner size,
  image cached) into README and docs/OPERATIONS.md (PLAN.md:869-870).
  `krun_terminal_detect_seconds` from `/metrics` is the second source.
- Keep the script out of `make e2e`. Run it on demand and in the P9.3
  pull request.
