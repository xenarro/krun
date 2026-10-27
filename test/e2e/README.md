# Disposable kind/e2e foundation

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
`Ready=True` before setup succeeds. No function Run is submitted here.

`make e2e` always runs the mandatory infrastructure verification before invoking
the separate Vitest configuration. Verification uses two restricted Pods in a
fresh `krun-test-probe-*` namespace: a real connection succeeds, default-deny
must block it, and removing that policy must restore the same connection.
Only an explicit remote client timeout counts as denial; kubectl/API/exec
failures never count as enforcement. The scratch namespace is removed even
when verification fails. An authenticated request also checks the gateway's
real Function projection, and both process logs are checked against the
generated API credential without printing it.

P4.12 intentionally has zero behavioural scenario files. The Vitest runner's
`passWithNoTests` does not skip the preceding mandatory infrastructure checks.
P4.13 adds the lifecycle/failure/SSE/capacity scenarios and the complete Phase 4
gate. A passing foundation alone is not acceptance of that phase.

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
