---
title: Releases
description: The release status of krun. Version 0.1.0 is prepared but not published; nothing is available from a registry yet.
sidebar:
  order: 2
---

:::caution[Nothing is published yet]
There is no tagged release, no GitHub release, no container image, no OCI chart, no
npm package and no PyPI package. Every workspace version is `0.0.0` and the npm
packages are marked private in source. Use a source checkout, as described in the
[quickstart](/krun/start/quickstart/) and [installation](/krun/start/installation/).
:::

## Status

Version 0.1.0 is **prepared, not released**. The checked-in
`release-ownership.json` is unverified, so the publication gate fails closed. The
changelog records the 0.1.0 entry as "Prepared, not published".

Publication is owner-gated and blocked on owner evidence (see the
[roadmap](/krun/project/roadmap/)):

- control of the npm `@krun` scope for `@krun/sdk` and `@krun/cli`;
- control of the PyPI project `krun`: a project with that name already exists (as of
  the 2026-10-24 check), and whether this project controls it is unverified;
- GHCR write permission and anonymous reads for `ghcr.io/xenarro/krun` and
  `ghcr.io/xenarro/charts/krun`;
- npm and PyPI trusted-publisher bindings to this repository, the `release.yml`
  workflow and the protected `release` environment.

## Planned release artifacts

One SemVer version per tag covers the image, the chart, both SDKs and the CLI. After
an owner-created `v0.1.0` tag, `release.yml` is designed to publish:

| Artifact | Planned identity | Status |
|---|---|---|
| Platform image | `ghcr.io/xenarro/krun` | Planned |
| Helm chart | `oci://ghcr.io/xenarro/charts/krun` | Planned |
| Node.js SDK | `@krun/sdk` on npm | Planned |
| CLI | `@krun/cli` on npm (`npx @krun/cli`) | Planned |
| Python SDK | `krun` on PyPI | Planned; a PyPI project named `krun` already exists and its control is unverified |
| Signatures and SBOM | cosign keyless signatures and syft SPDX attestations for the image and chart | Planned |

The public `/v1` API becomes stable once v0.1.0 ships. Until then, treat every
interface as subject to change.

## Rehearse a release

The credential-free rehearsal stamps a private snapshot, builds and installs the real
Node.js, Python, CLI and chart artifacts, checks every SDK export mode and verifies a
non-root image archive. It does not modify the checkout and publishes nothing:

```sh title="Terminal"
pnpm install --frozen-lockfile
node scripts/release-dry-run.ts 97
```

The argument is a positive synthetic pull-request number, which produces the version
`0.0.97`. To rehearse the actual target version:

```sh title="Terminal"
RELEASE_VERSION=0.1.0 node scripts/release-dry-run.ts 97
```

Pull requests run the same rehearsal as the read-only dry-run job in `release.yml`.

## After publication

Only after an owner-authorized tag and a successful registry readback do the
post-publication checks in the release guide apply, for example `cosign verify` on
the image and `helm show chart oci://ghcr.io/xenarro/charts/krun --version 0.1.0`.
They are not valid today. The full procedure is in the
[release preparation guide](/krun/reference/generated/release/).

Watch the [repository](https://github.com/xenarro/krun) for the first tag, and see
[CHANGELOG.md](https://github.com/xenarro/krun/blob/main/CHANGELOG.md) for the
prepared release notes.
