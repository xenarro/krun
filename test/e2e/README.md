# Disposable kind/e2e gate

This harness is local infrastructure, not a production installer. It creates
only the `krun-test-e2e` cluster and an ownership-labelled `kind-registry`
container, bound to `127.0.0.1:5001`. Do not reuse these names for other work.

Prerequisites: Docker, kubectl 1.37, the exact kind version in `.kind-version`,
Node from `.node-version`, and the repository's locked pnpm dependencies.
`images.json` pins the Kubernetes node and registry manifests by digest. CI uses
SHA-pinned `helm/kind-action` with `version_file: .kind-version` and runs the
same Make targets. kind 0.33 includes enforcing kindnetd; no Helm chart or
additional CNI installation is needed for this foundation.

    make kind-up
    make e2e
    make kind-down

`kind-up` is repeatable: it creates/reuses owned infrastructure, writes
`/etc/containerd/certs.d/localhost:5001/hosts.toml` on every kind node, joins the
registry to the kind Docker network, and publishes the standard
`kube-public/local-registry-hosting` ConfigMap. It builds the current Dockerfile,
pushes only to the local registry, and deploys the acknowledged digest. It then
applies the generated Function CRD, raw jobs isolation/RBAC/resource manifests,
and one embedded Pod containing the real gateway and scheduler. An init
container runs explicit SQLite migrations on their shared `emptyDir`. Both
serving containers must become ready, and `function.yaml` must reach current
`Ready=True` before setup succeeds. `kind-up` itself submits no Run;
`make e2e` then submits the five behavioural workloads.

`make e2e` always runs the mandatory infrastructure verification before invoking
the separate Vitest configuration. Verification uses two restricted Pods in a
fresh `krun-test-probe-*` namespace: a real connection succeeds, default-deny
must block it, and removing that policy must restore the same connection.
Only an explicit remote client timeout counts as denial; kubectl/API/exec
failures never count as enforcement. The scratch namespace is removed even
when verification fails. An authenticated request also checks the gateway's
real Function projection, and both process logs are checked against the
generated API credential without printing it.

## Phase 4 scenarios (P4.13)

The separate Vitest runner now requires all five `*.e2e.ts` files; an empty
suite fails. File execution is sequential, with a unique generated Function
per file, the existing bounded test/hook budgets and one visible runner retry.
The phase gate passes locally and in [exact source-head hosted CI](https://github.com/xenarro/krun/actions/runs/40523418351)
for `2f8f5e2` ([PR #59](https://github.com/xenarro/krun/pull/59));
both `verify` and `kind`, including owned cleanup, pass. Independent correctness/
contracts review and the actual Run-credential privacy repair are complete.
Required repository approval/merge remains separate; tracking receives its own
checked commit. This is Phase 4 acceptance, not production or later-phase acceptance.

- `success`: input fetched through the internal API, one accepted status and an
  inline result PUT. The public FULL Run succeeds with the exact opaque result.
- `exit_code`: exit 1, `EXIT_CODE`, non-empty marker-bearing log tail, terminal
  detection within ten seconds of the observed native `finishedAt`.
- `exit_code_status`: two accepted reports spaced by the normative rate limit,
  exit 3, retained second report, exact exit code and bounded terminal log tail.
- `image_pull_backoff`: missing local digest, current scheduled
  `ImagePullBackOff`, native Job deadline 60 seconds, then `DEADLINE_EXCEEDED`.
- `heartbeat_timeout`: one accepted report then silence, a 30-second heartbeat
  window, `HEARTBEAT_TIMEOUT` and log tail, and positively observed Job removal
  within sixty seconds of that report.

The four runnable fixtures are tiny shell entrypoints FROM the curl manifest
pinned in `images.json`; `functions/Dockerfile` does not change the base runtime.
Their scripts use `set -eu`, `--fail-with-body` and bounded GET/PUT retries;
status reports use one attempt. Images are built and pushed only to the owned
loopback registry, using the acknowledged digest, never to a remote registry.
Function v1 has no command/args override, so no API/schema extension is needed.

The public API is reached through a private loopback-only ephemeral
port-forward. Pod WATCH starts from a real LIST resourceVersion before Run
submission, retaining fast native terminal events. Missing/null timestamps from
never-started containers remain unknown; only actual finish timestamps prove
exit latency. API/watch errors cannot prove an absent resource. Each file checks
Pod manifests and process logs for generated credentials/input markers, cancels
unfinished owned runs on cleanup, removes only its Function-labelled resources,
reads back deletion and bounds shutdown of its kubectl children. Raw private
responses, manifests, logs and credentials are not printed as diagnostics.

SSE/webhook scenarios remain Phase 5, capacity scenarios Phase 9 and chart/
admission scenarios Phase 7. The Phase 4 gate does not claim those features.

## Ownership and recovery

Every kubectl call supplies both an isolated kubeconfig and the explicit
`kind-krun-test-e2e` context. The kind create, export and delete commands also
explicitly select that private kubeconfig, including partial-setup recovery;
none may fall back to the ambient configuration. Setup does not select or mutate the ambient
current-context. The private state directory is under `TMPDIR` (or the OS's
temporary directory) and includes a hash of the checkout path. It is mode 0700;
its kubeconfig, generated API credential and rendered manifests are private.
Do not copy those files into the repository or publish them as CI artifacts.
Use the same checkout and `TMPDIR` for setup, verification and cleanup.

A registry with the recipe's fixed name is reused or deleted only when its
ownership label and loopback port binding match this checkout. An existing
cluster without this checkout's private ownership state is refused. A lock
prevents concurrent harness commands from sharing or tearing down an active
setup. Keep the private state when recovering an interrupted run; do not
replace it with fabricated ownership. After the active command has exited,
remove only its stale lock directory if an uncatchable process termination
left it behind, then rerun `make kind-down` or `make kind-up`.

`make kind-down` deletes the owned kind cluster, the owned local registry and
its anonymous storage, confirms their absence, and removes private state.
It is repeatable. CI runs it under `always()`, including after a failed gate.
It does not publish images, change production clusters or remove other local
clusters. `node test/e2e/cluster.ts diagnostics` prints only selected Pod status
fields, never kubeconfig/Secret contents or raw application logs.
