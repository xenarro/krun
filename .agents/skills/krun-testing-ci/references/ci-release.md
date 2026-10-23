# Dockerfile, ci.yml, renovate, release.yml, benchmarks

Generic technique: `dockerfile-optimise` (multi-stage, distroless, digest
pinning) and `github-actions-advanced` (SHA-pinned actions, least-privilege
`permissions`, OIDC trusted publishing). This file holds the krun-specific
rules with their PLAN/SPEC lines; where a generic skill disagrees, PLAN wins.

## Dockerfile (P0.3, PLAN.md:147-152)

| Rule | Why |
|---|---|
| Multi-stage: `build` stage on a Node 24 image pinned by digest runs `pnpm install --frozen-lockfile` and `pnpm -r build` | reproducible `dist/` per package (PLAN.md:38-39, 147-148) |
| Then `pnpm install --prod --frozen-lockfile` in the build stage (or a `deps` stage) so the runtime tree has no dev dependencies | PLAN.md:148 |
| Copy every workspace package's `dist/`, `packages/cli/dist` included, plus the pruned `node_modules` and `bin/krun.js` onto the final stage | `krun validate` dispatches to `packages/cli/dist/validate.js` (PLAN.md:149, 335-337; SPEC.md:54-55) |
| Final base: distroless Node.js, glibc, pinned by digest | `better-sqlite3` prebuilt binary links glibc (PLAN.md:149-150); digest pin feeds Renovate (PLAN.md:157) |
| `USER 65532`, `ENTRYPOINT ["node", "bin/krun.js"]` | non-root matches the chart securityContext (SPEC.md:1320-1321); four entrypoints by argument (SPEC.md:54-55) |
| Read-only root filesystem works: nothing writes outside `/tmp` and `KRUN_DB_PATH` | the chart mounts `/tmp` as emptyDir (SPEC.md:1322-1323) |
| `.dockerignore` excludes `test/`, `.git`, `node_modules` of the host, `deploy/`, `docs/` | smaller context, the fake kube never ships |
| Build args `KRUN_VERSION`, `KRUN_COMMIT` into OCI labels `org.opencontainers.image.{version,revision,source}` | `release.yml` stamping (PLAN.md:196-198); support reads them from the image |

Acceptance: `make docker` builds; `docker run <image> gateway` prints
`gateway` (PLAN.md:151-152); from P2.5 `docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
prints one line and exits 1 (PLAN.md:340-342).

Open points: if better-sqlite3 ships no Node 24 prebuilt (UNVERIFIED,
node-stack-facts.md:670-675) the build stage needs `python3`, `make`, `g++`;
with pnpm 10 add `onlyBuiltDependencies: [better-sqlite3]` to
`pnpm-workspace.yaml` (UNVERIFIED, node-stack-facts.md:805-809). Confirm in
P0.1 with `node -e "require('better-sqlite3')"` inside the image.

## `ci.yml` (P0.4, PLAN.md:153-159; P4.12, PLAN.md:589-591)

Triggers: `push` to `main` and `pull_request`. Top-level `permissions: contents: read`;
jobs raise only what they need. Every `uses:` pinned to a commit SHA with a
version comment (`github-actions-advanced`).

| Job | Steps | Notes |
|---|---|---|
| `check` | checkout, pnpm + Node 24 from `.node-version`, `uv`, `pnpm install --frozen-lockfile`, `make check` | the Phase 0 gate (PLAN.md:129); Postgres contract suite via testcontainers needs Docker on the runner; set `TESTCONTAINERS_RYUK_DISABLED=true` if Ryuk cannot run privileged (node-stack-facts.md:785-786) |
| `generate` | `make generate && git diff --exit-code` | catches a stale CRD, OpenAPI document or chart README (PLAN.md:154, 188, 366, 436, 736) |
| `docker` | `make docker`, Trivy `--severity CRITICAL --ignore-unfixed --exit-code 1` on the image | PLAN.md:154-156 |
| `helm-lint` | `make helm-lint`; from P7.7 also `promtool check rules` on the rendered PrometheusRule | PLAN.md:155, 755 |
| `audit` | `pnpm audit --prod --audit-level=critical` | PLAN.md:155 |
| `actionlint` | `actionlint` on `.github/workflows/` | P0.4 acceptance (PLAN.md:158) |
| `kind-e2e` (P4.12) | `helm/kind-action` pinned to the same kind version as the Makefile, `make kind-up`, `make e2e`, upload gateway and scheduler logs as artifacts on failure | PLAN.md:589-591; runs on pull requests and main; from P9.4 budget 2 x 1800 s for the quickstart (PLAN.md:863-864) |
| `release-dry-run` (P0.9) | the `release.yml` dry-run job invoked on pull requests | PLAN.md:200-201 |

- Cache pnpm store keyed on `pnpm-lock.yaml`; never cache `node_modules`.
- `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`
  on pull requests only.
- Secrets in CI: none for `ci.yml`; tests generate their own keys
  (PLAN.md:33). `GITHUB_TOKEN` only in `release.yml`.
- `actionlint` and `gh run watch` are the acceptance (PLAN.md:158-159).

## `renovate.json` (P0.4, PLAN.md:157)

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":pinDigests", "helpers:pinGitHubActionDigests"],
  "enabledManagers": ["npm", "dockerfile", "github-actions", "pep621", "helm-values", "kubernetes"],
  "packageRules": [
    { "matchManagers": ["npm"], "rangeStrategy": "pin", "matchDepTypes": ["dependencies", "devDependencies"] },
    { "matchDepNames": ["kind", "kindest/node"], "groupName": "kind" }
  ]
}
```

Scope is npm, Docker digests and Actions (PLAN.md:157); the `kubernetes`
manager covers `test/e2e/*.yaml` image digests (MinIO, Postgres, registry).
`kind` and `helm/kind-action` must move together (PLAN.md:46-47): group
them. Renovate itself is a CI tool, not a dependency (PLAN.md:46).

## `release.yml` (P0.9 PLAN.md:192-201; P9.5 PLAN.md:865-872; SPEC.md:1413-1417)

### Owner preconditions: BLOCKED when unmet (PLAN.md:192-196, 23-26)

| Precondition | Fallback | Who decides |
|---|---|---|
| npm scope `@krun` available (`@krun/sdk`, `@krun/cli`, SPEC.md:660-662, 770-771) | `@xenarro/krun-sdk` (PLAN.md:195) | owner, Decisions row |
| PyPI project `krun` available (SPEC.md:661-662) | `krun-sdk` (PLAN.md:195) | owner, Decisions row |
| GHCR owner `xenarro` for `ghcr.io/xenarro/krun` and `oci://ghcr.io/xenarro/charts/krun` (SPEC.md:1226-1229) | none | owner |
| npm and PyPI OIDC trusted publishing configured for the repository | none | owner |
| `GITHUB_TOKEN` with `packages: write` for GHCR | n/a | workflow `permissions` |

Write `BLOCKED P0.9: <which precondition>` and continue (PLAN.md:27-28).
The dry-run job must still pass on pull requests without any of them.

### Jobs

| Job | Trigger | Steps |
|---|---|---|
| `dry-run` | `pull_request`, and reused by `ci.yml` | stamp the version from a synthetic `v0.0.0-pr<N>` into every `package.json`, `sdk/python/pyproject.toml`, `deploy/helm/krun/Chart.yaml` `version` and `appVersion` (PLAN.md:196-198); `pnpm -r build`; `pnpm pack` both packages; `uv build`; `helm package`; `make docker`; `git diff --stat` printed; no push, no publish |
| `release` | `push` tags `v*` (owner-only, PLAN.md:22) | `permissions: { contents: write, packages: write, id-token: write }`; stamp the tag; build; push the image to GHCR by digest; `cosign sign --yes <image>@<digest>` keyless; `syft <image>@<digest> -o spdx-json`; `cosign attest --yes --type spdxjson --predicate sbom.spdx.json <image>@<digest>`; `helm package` then `helm push` to `oci://ghcr.io/xenarro/charts`; `cosign sign` the chart digest; publish `@krun/sdk` and `@krun/cli` with `npm publish --provenance --access public` under OIDC; `uv publish` with OIDC; create the GitHub release with the `CHANGELOG.md` section for the tag |

- Version stamping is a script (`scripts/stamp-version.ts`) with a test:
  given `v1.2.3` every file carries `1.2.3` and `Chart.yaml` `appVersion`
  equals `version`; `v` prefix stripped; a tag not matching SemVer fails.
- One SemVer version per tag for image, chart, SDKs and CLI
  (SPEC.md:1413-1415); the templates' pinned SDK version must equal the
  workspace version (knative-func lesson in SKILL.md).
- `CHANGELOG.md` per tag (PLAN.md:200-201): the release pull request adds
  the section; the workflow fails when the tag's section is missing.
- Post-release acceptance (P9.5, PLAN.md:869-872): `helm install` from the
  OCI chart, `npx @krun/cli init`, `pip install krun`, `cosign verify` with
  `--certificate-identity-regexp` for the workflow and
  `--certificate-oidc-issuer https://token.actions.githubusercontent.com`.
- Never store a long-lived npm or PyPI token in the repository secrets when
  OIDC is the precondition; if the owner has not configured OIDC the job is
  BLOCKED, not worked around.

## Benchmarks (P9.3, PLAN.md:847-850)

- `scripts/bench.ts` submits 500 runs of a 10 s `curlimages/curl` function on
  kind, records per run: submit time, first `RUNNING` observation (poll
  `GetRun` or `WatchRun`), terminal time; one batch of `exit 1` runs for
  failure-detection latency.
- Report p50 and p95 submit-to-`RUNNING`, p95 failure detection, sustained
  runs per second; compare with docs/PROBLEM.md:79-81 (p95 under 15 s,
  crash to failed under 10 s) and SPEC.md:1421-1425.
- Write the numbers with the conditions (kind node count, runner size,
  image cached) into README and docs/OPERATIONS.md (PLAN.md:849-850);
  `krun_terminal_detect_seconds` from `/metrics` is the second source.
- Keep the script out of `make e2e`; it is run on demand and in the P9.3
  pull request.
