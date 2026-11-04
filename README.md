# krun

HTTP-triggered functions executed as one-off Kubernetes Jobs. Submit JSON over
HTTP; receive durable status, an inline or object-storage result, and classified
failures without giving callers Kubernetes credentials.

A gateway authenticates and admits Runs. One elected scheduler creates Jobs,
observes their actual exits, persists transitions and sends optional signed
webhooks. Function definitions are Kubernetes `Function` resources, not HTTP
create/update endpoints. Node.js and Python SDKs implement the small internal
HTTP contract; any container with an HTTP client can implement it instead.

## When to use krun

Use krun for bounded, isolated batch work, internal report generation and
HTTP-triggered compute that already belongs on Kubernetes. Choose Postgres for
replicated gateway/scheduler processes and a separately operated database.
Choose embedded SQLite for a single shared Pod and PVC, accepting downtime
on restart/upgrade; optional Litestream replication is an operations concern.

## When not to use krun

- Not an always-warm, sub-second request handler: every run creates a Job.
- Not a workflow/DAG engine, cron scheduler, automatic retry engine, broker,
  autoscaler, multi-region control plane or dashboard.
- Not hostile-code multitenancy. Function authors and the platform team share
  a trust boundary; PSA, quotas and default-deny networking reduce blast radius,
  but function-image signature verification belongs to platform admission.
- Not a Kubernetes replacement or an SDK-only local gateway emulator. SDK local
  mode runs a handler once without network access.
- Not an assertion that package names, OCI artifacts or a release are published.
  P0.9/P9.5 publication prerequisites and release acceptance remain separate.

The normative design and boundaries are [SPEC.md](SPEC.md), the
[public API](docs/API.md), [internal API](docs/INTERNAL-API.md),
[stack](docs/STACK.md) and [operations guide](docs/OPERATIONS.md).
The [chart reference](deploy/helm/krun/README.md) lists every value.
Historical implementation receipts moved unchanged to
[DEVELOPMENT-HISTORY.md](DEVELOPMENT-HISTORY.md); they are not current status claims.

## Quick start: both database modes on disposable kind

This is a source-checkout rehearsal, not a production installer. It uses only
`kind-krun-test-e2e`, a private kubeconfig and the checkout-owned loopback
registry. It refuses an existing platform/namespace, foreign registry or
non-loopback cluster. It never uses your ambient Kubernetes context.

Prerequisites: the pinned Node 26, pnpm, Helm 4, kind and kubectl versions,
Docker, npm, GNU `timeout` and uv from [the e2e guide](test/e2e/README.md). Kubernetes 1.33+
and a CNI that actually enforces NetworkPolicy are required. Work from this
checkout, retain its private TMPDIR state during recovery and install the
locked dependencies with their existing supply-chain policy:

```sh
pnpm install --frozen-lockfile
make build
```

Run the complete acceptance (fresh cluster per mode; unchanged 1,800-second
budget per mode, with a positive open/deny/reopen network-policy control):

```sh
make e2e-quickstart
```

It invokes the actual `scripts/quickstart.sh` with the local chart, pushed
platform image, workspace CLI, current packed Node SDK and local registry.
The script installs the platform, uses `krun init`, vendors the SDK before
`krun deploy`, tests the generated project, waits for current-generation
`Ready=True`, submits a real Run and verifies `{ "rows": 42 }` through GetRun.
Both modes use the same Node function; Postgres mode provisions the pinned,
restricted disposable Postgres 18 fixture. API keys and database credentials
are generated, passed only through private Secret inputs, and never printed.
The demo needs only an inline result: S3 and webhook configuration are not
silently inferred or enabled. The existing complete native corpus separately
covers both SDK languages, object storage, webhooks and other failures.

To invoke a single mode yourself with the exact unpublished-artifact overrides:

```sh
make kind-up
mkdir -p "$TMPDIR/krun-test-quickstart-sdk"
pnpm --dir sdk/node pack --pack-destination "$TMPDIR/krun-test-quickstart-sdk"
KRUN_CHART="$PWD/deploy/helm/krun" \
KRUN_IMAGE=localhost:5001/krun:e2e \
KRUN_CLI="node $PWD/packages/cli/dist/main.js" \
KRUN_SDK_VENDOR="$TMPDIR/krun-test-quickstart-sdk" \
KRUN_REGISTRY=localhost:5001 \
  scripts/quickstart.sh embedded
make kind-down
```

Repeat on a fresh `make kind-up` with `scripts/quickstart.sh postgres` and the
same overrides. `TMPDIR` must name an existing writable private directory;
use the same value for setup, rehearsal and cleanup. The vendor directory must
contain exactly one Node SDK `.tgz`; use a new empty directory for a new pack.
The script automatically removes its own chart, generated project, credentials,
CRD and demo namespaces on normal success/failure. The acceptance driver also
removes its cluster/registry. After a normally joined manual run, use
`make kind-down`; never delete an unrelated cluster or change an ambient context.
A shared foundation lease prevents setup/teardown from racing another job;
busy locks fail closed. A hard interruption requires verifying that every
owning/borrowing process has stopped before exclusive lock recovery, as
explained in the e2e guide.
This disposable cleanup deliberately disables the chart's CRD/jobs-namespace
`keep` values; do not copy that setting into a durable installation.

| Variable | Script default | Local acceptance override |
|---|---|---|
| `KRUN_CHART` | `oci://ghcr.io/xenarro/charts/krun` | local `deploy/helm/krun` path |
| `KRUN_IMAGE` | unset; chart image/tag defaults | pushed `localhost:5001/krun:e2e` (`repository:tag`) |
| `KRUN_CLI` | `npx @krun/cli` | `node /absolute/checkout/packages/cli/dist/main.js` |
| `KRUN_SDK_VENDOR` | unset; generated project resolves its published SDK | directory containing the current Node SDK `.tgz` |
| `KRUN_REGISTRY` | `localhost:5001` | same owned loopback registry; this demo refuses remote publication |

`KRUN_CLI` is an executable plus plain space-separated arguments, not a shell
program: no `eval`, pipes, substitutions or quoting. Use an executable wrapper
when a path contains spaces. Chart URLs must not contain userinfo, query
strings or fragments: keep authentication in Helm's private configuration,
never a chart reference copied to argv or logs. Local paths and credential-free
HTTP(S)/OCI references retain their exact spelling. Published defaults are configurable interfaces,
not evidence that registry/package ownership or publication has been accepted.
Use the explicit local overrides until release prerequisites are verified.

### Measured quickstart durations

Actual local repair qualification, 2026-11-04 (seconds, rounded to three decimals):

| Mode | `quickstart.sh` incl. demo cleanup | Fresh setup, rehearsal and infrastructure cleanup | Exit |
|---|---:|---:|---:|
| embedded | 119.026 | 325.989 | 0 |
| postgres | 39.688 | 291.738 | 0 |

Both complete fresh-mode commands and the scripts finished below the unchanged
1,800-second per-mode limit. The complete duration includes kind/registry and
MinIO provisioning, freshly generated/packed SDK fixtures, the stock chart's
positive CNI control, the actual script, and owned cluster/registry removal.
The script's own clock starts after that control release is removed; its
platform image is consequently cached in the node. Host Docker layer caches
were also warm. These are measured local Node-template rehearsals, not a
cold-cache guarantee, a hosted CI result, package-publication acceptance or a
production-capacity claim. No public mutation was retried.

## Golden path on an operated platform

The platform team supplies a registry prefix, krun namespace, jobs namespace,
public API URL and a privately delivered API key. Configure your Kubernetes
identity for that approved context; do not set `KRUN_GATEWAY_URL` on your
workstation, because that selects the SDK's in-Pod mode.

```sh
npx @krun/cli init --lang node reports-demo
# Or: npx @krun/cli init --lang python reports-demo
cd reports-demo
npm install
npm test
npx @krun/cli deploy --namespace "$KRUN_NAMESPACE" \
  --api-url "$KRUN_API_URL" --registry "$KRUN_REGISTRY"
```

For Python use `uv sync` and `uv run pytest` instead of npm. Before unpublished
local deployment, copy the SDK archive/wheel into `vendor/` and install it from
there, as in the generated README. Deploy always builds and pushes, obtains the
registry's digest, validates the manifest and applies it; `--no-apply` leaves
application to GitOps. It prints a credential-free first-run curl, in-flight log
command and GetRun hint. Run these with your privately configured key:

```sh
curl --fail-with-body "$KRUN_API_URL/v1/functions/reports-demo/runs?wait=30s" \
  -H "Authorization: Bearer $KRUN_API_KEY" -H 'Content-Type: application/json' \
  --data '{"input":{"name":"reports-demo"}}'
# Set RUN_NAME to the response's full functions/.../runs/... name, then:
curl --fail-with-body "$KRUN_API_URL/v1/$RUN_NAME" \
  -H "Authorization: Bearer $KRUN_API_KEY"
```

The first command waits up to 30 seconds, not necessarily to completion;
use `POST ...:wait` with `{ "timeout": "30s" }` until terminal, or `GET ...:watch`
for BASIC server-sent events. Read `logTail` in a failed FULL Run after the
native Job has gone. Do not echo keys, input, results or signed URLs to logs.

## Platform-team onboarding

1. Install the chart using [OPERATIONS](docs/OPERATIONS.md) and the generated
   chart reference. Create its `apiKeys.existingSecret` before Helm; the chart
   never creates a Secret or Function. Label the release namespace restricted.
   Supply an existing database Secret for Postgres. Verify default-deny CNI
   enforcement, image policy and any S3/receiver egress before handover.
2. Add a key to the private `keys.yaml` document with a unique principal name,
   scopes `functions:read`, `runs:read`, `runs:write`, and only the team's Function
   globs (for example `reports-*`). Preserve other principals; avoid `admin`.
   Update the existing Secret from the private file, never by putting material
   in Helm values, a command argument or a committed manifest. Keys reload on
   a 30-second content-hash poll. For rotation retain the same principal name
   and use a `key` array containing old/new private values in that single entry
   (duplicate names are rejected). Wait for reload, switch clients, then remove
   the old value.
3. Bind the existing namespace Roles to the team's authenticated Kubernetes
   group. These roles intentionally ship without team bindings:

```sh
kubectl --context "$PLATFORM_CONTEXT" -n "$KRUN_NAMESPACE" create rolebinding reports-authors \
  --role=krun-function-author --group=reports-developers
kubectl --context "$PLATFORM_CONTEXT" -n "$KRUN_JOBS_NAMESPACE" create rolebinding reports-logs \
  --role=krun-job-viewer --group=reports-developers
```

4. Hand over the approved context, both namespace names, registry prefix and
   public URL, with the API key through a separate private channel. Kubernetes
   author/log permissions and HTTP API-key scopes are separate grants. Authors
   may manage Function resources and inspect in-flight Job logs; neither Role
   grants secret reads, pod exec, workload creation or cluster-admin access.
   Expose only public port 8080 through the optional HTTPRoute/TLS edge. Keep
   internal 8081 and admin ports private; configure `networkPolicy.metricsFrom`
   explicitly (its empty default allows any source to admin ports).

## Function container contract

- Digest-pinned image, non-root numeric UID/GID, read-only root filesystem,
  dropped capabilities, no service-account token. Write transient files only
  under `/tmp`; there is no persistent per-run filesystem or warm process.
- Fetch input from the internal API, never an environment variable or manifest.
  `KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL` and a per-run `KRUN_TOKEN`
  identify/authenticate the execution. Input is JSON-equivalent to submission.
- Optionally report progress; write the result before exit, or upload a large
  result through the scoped `KRUN_RESULT_UPLOAD_URL` when configured. Do not
  send the run token with an object-store upload. A per-run token is dead from
  `CANCELLING` onward or any terminal transition, and is also bounded by its
  active-deadline lifetime. A waiting client's disconnect does not revoke it.
- Exit 0 means success; nonzero means failure. Report an application error
  before nonzero exit. No automatic Job retries. Heartbeats are optional per
  Function; CPU-bound handlers can starve SDK heartbeat processing.
- The Node 22+ and Python 3.11+ SDKs have no runtime dependencies. Without
  `KRUN_GATEWAY_URL`, local mode reads JSON from a file/stdin and writes only
  the result to stdout; progress/logs go to stderr. Neither SDK provides a
  local gateway emulator. See [the internal contract](docs/INTERNAL-API.md).

## Public API summary

All calls use the public `/v1` listener and a scoped bearer API key. JSON fields
are lowerCamelCase, states and failure reasons UPPER_SNAKE_CASE. Ready/allowed
Functions are read-only through HTTP; Kubernetes is their write API.

| Operation | HTTP path (under `/v1`) |
|---|---|
| List/GetFunction | `GET /functions`, `GET /functions/{function}` |
| Create/ListRuns | `POST` / `GET /functions/{function}/runs` |
| GetRun | `GET /functions/{function}/runs/{run}` |
| Wait/CancelRun | `POST /functions/{function}/runs/{run}:wait` / `:cancel` |
| WatchRun | `GET /functions/{function}/runs/{run}:watch` (SSE, BASIC) |
| GetRunResult | `GET /functions/{function}/runs/{run}:getResult` |

GetRun/CreateRun/WaitRun/CancelRun are FULL by default; lists, watches and
webhooks are BASIC and exclude input, result, error details and log tail.
Use the returned resource name, opaque pagination tokens and documented view
rules. An optional `requestId` (at most 128 characters; UUID recommended)
deduplicates CreateRun per key name and Function while the Run row remains;
it is not permission to blindly retry mutations. Queue limits
return 429 with `Retry-After`. Stored results may return an authenticated,
bodyless 307 to a short-lived signed GET URL; never forward the API key to it.
Webhooks are at-least-once, signed over raw BASIC bytes, and require receiver
deduplication. Full routes, errors and examples: [docs/API.md](docs/API.md).

## Verify and operate

`make check` runs types, format/lint, TypeScript/Python tests and unused-code
checks. `make e2e` runs the complete existing native scenario corpus in both
modes; `make e2e-quickstart` separately owns a fresh cluster for each README
rehearsal without changing that corpus's timeouts/retry policy. CI has a separate
30-minute-per-mode quickstart matrix with always-run owned infrastructure
cleanup. Implementation-local qualification is not a claim of hosted delivery.

For durable installs, capacity, backup/restore, upgrades, key rotation, telemetry,
alerts, object-store lifecycle and keep/adoption consequences, read
[OPERATIONS](docs/OPERATIONS.md). The Phase 9 release dry-run/publication gate
remains separate from quickstart and benchmark qualification.

## Measured native Job benchmark (P9.3)

Measured 2026-11-03 on local kind (not a CI runner): one Kubernetes 1.37.0
control-plane node, Node 26.7.0, AMD Ryzen 7 5700X 8-Core Processor
(16 visible logical CPUs), 60.7 GiB host RAM. These are host
resources, not a dedicated runner reservation. The unchanged chart installs
one combined gateway/scheduler Pod in embedded mode and two replicas of each
process in Postgres mode, with Postgres 18 and the existing MinIO fixture.
Default-deny enforcement is positively verified before each measurement.

Each mode completes 500 successful runs of the pinned curl-based function
whose measured workload is `sleep 10`, followed by 20 actual `exit 1` runs
of that function. One excluded successful warmup caches the exact image.
The load is closed-loop with 10 clients and Function `maxConcurrency: 10`,
not a simultaneous 500-run burst, an idle-single-run SLO test, or a measurement
of maximum capacity. Existing credential/Pod privacy observers remain active.

| Store mode | Submit→first RUNNING p50 (s) | p95 (s) | Exit→observed FAILED p95 (s) | Completed runs/s |
|---|---:|---:|---:|---:|
| embedded | 2.414 | 6.103 | 11.345 | 0.494 |
| postgres | 1.433 | 13.979 | 8.943 | 0.459 |

Percentiles use nearest rank over the complete populations (500 success and
20 crash samples), without interpolation or dropping failures. Submit time
is recorded immediately before CreateRun. GetRun observes first RUNNING at
200 ms intervals; WaitRun observes terminal state. Throughput is 500 divided
by the full window from first submission to last successful terminal response,
not HTTP admission rate. Failed outcomes must carry `EXIT_CODE`. Detection
latency subtracts the actual native container `finishedAt` from the client's
first terminal observation; kind and client share the host clock. Native exit
timestamps have Kubernetes' timestamp precision, and observation/transport
latency is included. This is not the backdated Run `endTime` or the ten-second
function duration.

The documented under-15-second startup target is met by both loaded samples;
the idle-cluster target is not independently certified by this load test.
Embedded failure-detection p95 is **11.345 seconds**, above the documented
under-10-second aspiration: do not treat that target as demonstrated. The
scheduler's exact-Function `krun_terminal_detect_seconds` histogram is an
independent second source: its counts advance 1→501→521 in each mode. The
20-crash histogram count/sum deltas are
embedded: 20 / 153.064 seconds; postgres: 20 / 107.192 seconds.
These sums are not p95 estimates. The script rejects missing series, resets,
wrong counts, duplicate Runs, missed RUNNING, wrong terminal reasons or
negative/nonfinite timing evidence. The driver never retries public API
mutations; the fixture retains its existing bounded internal curl transport
behavior. No workload, deadline, security rule or test allowance was relaxed
to produce the numbers.

Reproduce with `make bench` then `make kind-down`, using the pinned tools in
`test/e2e/README.md`. This is separate from `make e2e` and can take roughly
20–25 minutes per mode. `make bench-build` compiles `scripts/bench.ts` into
`dist/bench/scripts/bench.js`; individual modes can use the existing
`cluster.ts install <mode>`, `cluster.ts verify`, compiled script, and
`cluster.ts uninstall` lifecycle. The script emits sanitized raw per-Run
observations and the summary only after verified owned cleanup; API keys,
input, tokens and connection details never enter the output. The dedicated
`benchmark.yml` workflow runs this same fixed workload on pull requests that
change the benchmark and on demand, with least-privilege permissions and
always-run owned cluster cleanup. Hosted results remain a separate exact-head
delivery gate; these local numbers are not attributed to GitHub Actions.

No Phase 9 release gate, publication or production capacity guarantee is
claimed by this measurement.
