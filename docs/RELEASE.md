# Release preparation and owner boundary

P9.5 prepares v0.1.0; it does not establish publication or registry ownership.
P0.9 remains the owner-reserved namespace/permission/trusted-publisher checkpoint.
The checked-in `release-ownership.json` deliberately refuses publication. The
remaining operational drill and full Phase 9 acceptance are separate.

## Credential-free rehearsal

From the working checkout, with the pinned Node/pnpm, uv, Helm and Docker tools:

```sh
pnpm install --frozen-lockfile
node scripts/release-dry-run.ts 97
```

The argument is a positive synthetic PR number, not a tag. The resulting stable
numeric version `0.0.97` is exactly representable by npm, PEP440, Helm and Docker;
no invalid `-pr97` Python version or silently coerced tag is used. To rehearse the
actual stable target without publishing anything:

```sh
RELEASE_VERSION=0.1.0 node scripts/release-dry-run.ts 97
```

Only stable `vX.Y.Z` / `X.Y.Z` versions are supported by this first-release tool.
Malformed values fail before a stamp. Prerelease conversion is not implemented
or advertised. All workspace/package, Python/template and chart versions are
prevalidated and stamped in a private `krun-test-release-*` snapshot, not in the
product checkout. Source manifests stay private. There is no commit, tag,
registry login, upload or publication in the rehearsal.

The script performs a guarded frozen install, builds the real sources, runs
publint and strict `attw --pack` on both prepared Node package directories,
packs them, builds the Python wheel/sdist and Helm chart, installs the actual
SDK/CLI archives in a clean guarded consumer and exercises ESM/CommonJS loading,
CLI help, both author templates and validation. It separately installs the
wheel without dependencies, builds the actual non-root image, checks its
version/revision/user, runs its hardened help smoke and saves an image archive.
Existing test-image tags are refused, not adopted. Only the newly built owned
image is removed on completion; package/image archives and private command logs
remain in the printed workspace.

`manifest.json` records archive SHA256 values, stamp inventory and the base
commit. Local uncommitted preparation is explicitly `sourceDirty: true` and
cannot pass the publisher's clean-source gate. CI's readonly PR dry-run uploads
only verified distribution artifacts, not the snapshot, consumer or private
logs. The same checksum-bound archives are consumed on an authorized tag;
publication does not rebuild a different image. Before any registry operation,
the publisher requires exactly those six regular artifact files plus a regular
manifest in a real directory; extras, directories and symlinks are rejected.
Python publication receives the two exact checksum-validated version paths,
never directory globs. Both Node tarball manifests must carry the canonical
`git+https://github.com/xenarro/krun.git` repository and their exact monorepo
directory (`sdk/node` or `packages/cli`) before provenance-enabled publication.

## Packaging decisions

The SDK has no runtime dependencies. The approved TypeScript compiler derives
native ESM and CommonJS runtime/declaration pairs from its one ESM source.
The sole file-URL metadata lookup receives the equivalent CommonJS file URL;
strict source checking is unchanged. Explicit import/require exports and legacy
main/types pass attw's complete resolution matrix with no profiles or exclusions.

The CLI's private shared implementation is vendored inside the release artifact,
not published as a third package. Its frozen patched Ajv and format adapter are
vendored as well; module specifiers are rewritten relative to those copies.
A permanent semantic regression checks D48's `__proto__` property validation.
A consumer must not reapply the checkout's patch declarations to packages absent
from its graph. Its release-age, strict-age, peer-install and script-denial
controls remain unchanged; there is no unused-patch exception or relaxed audit.
Root workspace patch declarations and actual patched runtime sources are intact.

## Required owner evidence before a tag

Do not infer any of these from an HTTP 200/404, an empty scope response or Git
push access. Do not choose a replacement name:

- Control and publication permission for both `@krun/sdk` and `@krun/cli` in
  the npm `@krun` scope, with public access and provenance.
- Control of PyPI project `krun`, or the explicit owner resolution of its
  pre-existing registration. The existing project is not evidence of access.
- GHCR write permission and public anonymous-read behavior for image
  `ghcr.io/xenarro/krun` and chart `ghcr.io/xenarro/charts/krun`.
- Exact npm/PyPI trusted-publisher configuration bound to repository
  `xenarro/krun`, workflow file `release.yml` and environment `release`, with
  the protected release environment's approval policy reviewed by its owner.
- Public, non-secret evidence references covering those grants/bindings in
  `release-ownership.json`, explicitly confirmed by the owner. Never put tokens,
  credentials, publisher secrets or screenshots containing them in this file.

After owner verification, review/merge the release preparation and all pending
parent PRs normally. Obtain exact-head green hosted CI including the readonly
release dry-run. Replace the prepared changelog status with the actual release
record, review it, and let the owner create the stable `v0.1.0` tag on accepted
main. This implementation job neither enables that gate nor creates the tag.

The release job rechecks the tag actor, exact repository/workflow/tag identity,
main ancestry, clean source, complete archive inventory, checksums and package
exports before registry writes. It uses the job-scoped GitHub token only for
GHCR/GitHub and rejects long-lived npm/PyPI credential fallbacks. npm provenance
and uv's `--trusted-publishing always` use OIDC. Image and OCI chart are signed
at pushed digests, receive their SPDX attestations, and are verified against
the exact tagged workflow identity and GitHub OIDC issuer. A release is never
claimed when a later operation fails; partial registry publication is a failure
requiring investigation, not a reason to forge a successful receipt.

## Post-publication acceptance is still mandatory

Only after the owner-authorized tag and successful registry readback:

```sh
cosign verify --certificate-identity https://github.com/xenarro/krun/.github/workflows/release.yml@refs/tags/v0.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/xenarro/krun:0.1.0
cosign verify-attestation --type spdxjson --certificate-identity https://github.com/xenarro/krun/.github/workflows/release.yml@refs/tags/v0.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/xenarro/krun:0.1.0
helm show chart oci://ghcr.io/xenarro/charts/krun --version 0.1.0
npx --yes @krun/cli@0.1.0 --help
```

Also install `@krun/sdk@0.1.0` into fresh ESM and CommonJS consumers, install
`krun==0.1.0` into a fresh Python 3.11+ venv, and exercise their real Run contract.
Use the complete owned disposable [README quickstart](../README.md), fetching
that exact OCI chart version to a private chart file, selecting the published
image and CLI, to verify an actual Helm install and successful Run in both modes.
Never point it at a production cluster or adopt another workflow's foundation.
Retain exact registry digests, signatures/attestations, package metadata, fresh
install receipts and hosted URLs. Those assertions are not supplied by a local
pack, an unsigned image, an unmerged PR or this document.
