# End-to-end tests

The test harness creates a disposable kind cluster and exercises the actual
chart, gateway, scheduler, SDK-built functions and backing services. It is not a
production installer and must not be pointed at an operated cluster.

## Prerequisites

- Docker, kubectl 1.37 and Helm 4.3.0.
- The kind version in `.kind-version` and Node version in `.node-version`.
- uv 0.13.1, Python 3.13 and the locked pnpm dependencies.

`images.json` pins the Kubernetes node, registry and curl images by digest.
The pinned kind release includes a NetworkPolicy-enforcing kindnetd. The
harness verifies enforcement with an open/deny/reopen probe; API acceptance of a
NetworkPolicy alone is not sufficient.

## Run the suite

From the repository root:

```sh
pnpm install --frozen-lockfile
make e2e
make kind-down
```

`make e2e` provisions the foundation and runs both storage modes sequentially.
Always run `make kind-down` after a failed or interrupted manual run, once its
owning processes have exited. CI performs this cleanup under `always()`.

The harness owns only:

- The `krun-test-e2e` cluster and its private `kind-krun-test-e2e` context.
- The ownership-labelled `kind-registry`, bound to `127.0.0.1:5001`.
- Generated namespaces, credentials, manifests and state associated with this
  checkout and its current invocation.

Do not reuse these names for unrelated work. Existing foreign resources are
refused rather than adopted or removed.

## What is installed

`kind-up` configures each node's loopback-registry mirror, builds the current
platform image, and pushes only to the owned registry. Registry-acknowledged
manifest digests identify deployed images. A restricted MinIO namespace runs a
checksum-pinned native binary and initializes a private bucket.

For each storage mode the harness installs the actual chart in a fresh
`krun-test-embedded` or `krun-test-postgres` namespace, with separate jobs,
monitoring and outsider namespaces. The release namespace enforces restricted
Pod Security Admission. The chart owns the jobs namespace's security labels,
RBAC, budgets, policies and digest admission. Test-only `crds.keep=false` and
`jobsNamespace.keep=false` permit complete removal between modes.

Embedded mode uses a real PVC. Postgres mode uses the restricted Postgres 18
fixture in `postgres.yaml`, not a database operator. Credentials are generated
privately and sent through stdin or Secret references, never values or argv.
The chart configures real MinIO egress, scoped webhook hosts/CIDRs and the
scheduler-only signing Secret.

Both language projects are generated through the built CLI. The harness vendors
the current Node SDK package and Python wheel, runs generated tests, and builds
the unchanged project Dockerfiles with `--network=none` after lockfiles exist.
The SDK handlers select success, thrown-error and slow-heartbeat behavior from
input; they do not implement a second internal API client.

## Scenario coverage

The separate Vitest runner fails on an empty suite. Files run sequentially with
bounded test/hook budgets and the configured single retry. Each scenario owns
fresh Function-labelled resources and verifies their removal.

- `success`: fetch input, report status, store an inline result and observe the
  exact public FULL Run.
- `exit_code` and `exit_code_status`: classify native exit failures, retain the
  last accepted report and bounded log tail, and measure terminal observation.
- `image_pull_backoff`: observe a missing digest and classify the native Job
  deadline rather than inventing a container exit.
- `heartbeat_timeout`: observe an accepted report, heartbeat expiry and Job
  removal.
- `wait`: compare CreateRun's bounded wait with WaitRun on the same actual Run.
- `webhook`: observe the real retry schedule, unchanged BASIC payload, delivery
  identity, rotation signatures and attempt trace context.
- `large_result`: upload a one-MiB JSON result through its scoped signed URL,
  verify the stored reference and authenticated bodyless redirect, then check
  the actual object's length and hash without forwarding an API key.
- SDK cases: run success, errors and live heartbeat reports from both generated
  Node and Python function projects.
- `deploy`: exercise the real CLI for both languages, including offline
  `--no-apply`, image digest readback and current-generation readiness.
- `chart`: verify internal/public/admin isolation, MinIO egress, digest
  admission, leader election, upgrades and rollback with retained Run state.
- `backpressure`: distinguish key and Function queue limits from rate limiting,
  verify quota classification and enforce maximum native Job concurrency.
- `security`: exercise cross-run token rejection, cross-principal read isolation,
  invalid Functions, callback denial and actual network denial from Job pods.
- Recovery controls restore a pre-existing Run through real Litestream/MinIO,
  verify the restored database independently and complete another Run.

The full corpus also checks resource ownership, lifecycle failures, process-log
privacy and function Pod manifests. Inputs, run tokens, API keys, webhook keys,
S3 account credentials and unrelated signed URLs must not leak into diagnostics.
Only an identity-validated per-Run upload capability is allowed in its intended
Function environment variable.

Network denial requires an actual bounded remote connection timeout bracketed
by successful controls. DNS, kubectl, exec and listener failures do not prove
isolation. Existing test timeouts and retry policies are not shortened to make
integration failures pass.

## Fresh-cluster quickstart

```sh
make e2e-quickstart
```

Each storage mode gets its own fresh foundation and a 1,800-second budget.
The driver invokes `scripts/quickstart.sh` with the local chart, current image,
workspace CLI, packed Node SDK and owned registry. It runs init, vendored-SDK
installation, generated tests, build/push/deploy, Ready observation, a single
submission and exact result readback. The script removes its chart, project,
credentials, CRD and namespaces; the outer driver removes the foundation.
Cleanup failures fail the command. See the root README for manual overrides.

## Benchmark

```sh
make bench
make kind-down
```

The benchmark is separate from `make e2e`. Each storage mode runs one excluded
warmup, 500 real ten-second successes and 20 exit-1 samples, with ten closed-loop
clients and concurrency ten. Allow roughly 20–25 minutes per mode. Results,
measurement boundaries and limitations are documented in the root README and
`docs/OPERATIONS.md`. The benchmark does not replay failed public mutations or
permit a production target.

## Ownership and recovery

Every kubectl call supplies both a private kubeconfig and the explicit
`kind-krun-test-e2e` context. Kind create, export and delete use that same private
configuration, including partial-setup recovery. The harness never selects or
mutates the ambient current context.

Private state is under `TMPDIR` (or the OS temporary directory), keyed by the
checkout path and protected with mode 0700. It contains generated credentials,
kubeconfig and private manifests. Keep the same checkout and TMPDIR for setup,
verification and cleanup. Never commit or publish this state as a CI artifact.

A shared foundation lease prevents lifecycle commands, quickstarts and
benchmarks from tearing down one another's infrastructure. Busy locks are not
stolen. After a hard interruption, verify every owning and borrowing process
has stopped before recovering an abandoned lock. Preserve the private ownership
state and inspect exact resources before retrying cleanup; never fabricate a
replacement ownership record.

A registry is reused or removed only if its ownership label and loopback port
binding match this checkout. Setup refuses a cluster without matching ownership
state. Cleanup joins owned child processes, verifies namespace/resource removal,
removes the owned cluster and registry storage, and reads back their absence.
It is repeatable and does not remove unrelated local clusters.

`node test/e2e/cluster.ts diagnostics` prints selected Pod status fields, not
Secret contents, kubeconfig or raw application logs.
