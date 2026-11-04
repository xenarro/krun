# Operating krun

Deployment, capacity, monitoring and recovery guidance for the platform team.

## Install and upgrade

- Install: `helm install krun oci://ghcr.io/xenarro/charts/krun` with
  values for `db`, `apiKeys.existingSecret` and, when webhooks are used,
  `webhooks`. The CRD is part of the release (`crds.install`). With
  `crds.install=false`, apply `deploy/crds/functions.krun.io.yaml` first.
- Prerequisites: Kubernetes 1.33 or newer, Postgres 16 or newer in
  postgres mode, and a CNI that enforces NetworkPolicy. Without enforcement the jobs namespace isolation is void;
  verify once with a default-deny policy in a scratch namespace.
- Before `helm install`, label the krun namespace
  `pod-security.kubernetes.io/enforce=restricted`; the chart does not
  label its own namespace.
- With `jobsNamespace.create=false` the namespace must already carry the
  PSA labels, a deny-all NetworkPolicy plus the DNS, gateway-8081 and
  object storage egress rules, a LimitRange with defaults and `max`, and a
  ResourceQuota whose `pods` is at least `config.maxRunning`; the chart's
  quota check is skipped, compare yourself.
- With `crds.install=false`, apply `deploy/crds/functions.krun.io.yaml`
  before every `helm upgrade`.
- `jobsNamespace.keep` (default true) keeps the jobs namespace on
  `helm uninstall`, with its Secrets and in-flight Jobs; krun's LimitRange,
  ResourceQuota and NetworkPolicies are removed. Re-install under the same
  release name and namespace adopts it; otherwise re-annotate it like the
  CRD.
- Upgrade: `helm upgrade`. Postgres mode: the `pre-upgrade` hook runs
  `krun migrate` first; migrations are expand/contract, so N-1 pods keep
  working during the rollout. Embedded mode: one replica, expect a brief
  downtime while the StatefulSet restarts.
- Rollback: `helm rollback` by one minor is supported. A newer database than
  the binary is tolerated: `krun migrate` warns and exits 0.
- Keep scheduler downtime below `config.ttlAfterFinished` (default 24
  hours); beyond it, runs finished during the outage become `job_lost`.
- CRD: `crds.keep` leaves the CRD on uninstall. Deleting the CRD deletes
  every Function. Re-install under the same release name and namespace, or
  update its Helm ownership annotations as described in the chart reference.

The serving scheduler requires `KRUN_POD_NAME` from downward API
`metadata.name` as its Lease identity; do not substitute a shared
constant or infer it from the host name. Run explicit migrations before serving.
Its standby remains ready after database/Function synchronization and reports
`leader: false`; Job/Pod watches and work are acquired only by the leader.
Use a distinct admin address from the gateway when colocating the processes.

## Disposable development cluster

The disposable test cluster is separate from the production Helm workflow.
Use the pinned prerequisites and Make targets in `test/e2e/README.md`:
`make kind-up`, `make e2e`, then `make kind-down`. The harness owns only the
`krun-test-e2e` cluster and its labelled loopback `kind-registry`; all Kubernetes
commands use a private kubeconfig and explicit test context. Keep its private
state during recovery, never publish it or generated credentials, and use the
same checkout/TMPDIR for cleanup. E2E verifies real default-deny enforcement
before exercising result/status round-trips, exit failures, image-pull deadlines,
heartbeat expiry and Job removal. This setup is disposable, not a durable
production deployment.
Each scenario cleans and reads back its own Function-labelled resources. The
curl-based fixtures are built locally from a pinned base and pushed only to the
owned loopback registry; generated credentials and raw private state stay local.

## Capacity

- `config.maxRunning` must not exceed `jobsNamespace.quota.pods`; the chart
  refuses to render otherwise while `jobsNamespace.create` is true. With
  `create=false`, compare it against the existing namespace's ResourceQuota
  yourself.
- Sum over Ready functions of `maxConcurrency` times its requests should
  stay within the jobs namespace ResourceQuota; the chart cannot see
  Functions, so check it with `kubectl get kfn -o yaml` when adding a
  function with large requests.
- Each run costs one Secret and one Job in etcd until the scheduler deletes
  them at the terminal transition. Sustained rate times run duration is the
  live object count.
- Postgres: 5 connections per krun pod plus one `LISTEN` client. Size the
  database pool accordingly.
- Object storage: krun never deletes result objects (`runs/<id>/result.json`).
  Set a bucket lifecycle expiration of at least `config.retention`; object
  age counts from upload, which precedes `finishedAt`.
- Ephemeral storage: `/tmp` plus logs count against the LimitRange
  `ephemeral-storage` limit (default 2Gi); a function exceeding it is
  evicted and classified `evicted`.

## Measured native Job benchmark

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

No publication or production capacity guarantee is
claimed by this measurement.

## Alerts and first checks

Rule names match `metrics.prometheusRule` in the chart.

| Rule | Meaning | First checks |
|---|---|---|
| `KrunNoLeader` | no scheduler holds the Lease, or no scheduler is scraped; nothing is claimed, no transitions happen | `kubectl get lease krun-scheduler -n krun -o jsonpath='{.spec.holderIdentity}'`; scheduler pod logs; API server reachability; a leader that cannot renew exits and restarts |
| `KrunFunctionsNotSynced` | a process cannot list Functions | CRD present and Established; RBAC for `functions.krun.io`; API server |
| `KrunJobLost` | Jobs vanish before krun records them | scheduler downtime vs `config.ttlAfterFinished`; someone deleting Jobs in the jobs namespace; node loss |
| `KrunHeartbeatTimeouts` | functions stop reporting | the run's `error` and `logTail` via `GetRun`; whether `heartbeatTimeout` is shorter than the work it protects |
| `KrunDeliveriesDead` | a webhook endpoint failed for about 15 hours | receiver availability; `webhooks.allowedHosts` and `allowedCIDRs`; DNS; signature verification on the receiver |
| `KrunQuotaRejections` | ResourceQuota or LimitRange refusing Jobs | `kubectl describe quota -n krun-jobs`; function requests vs `limitRange.max` |
| `KrunQueueWaitHigh` | runs wait too long | free slots per function (`krun_runs_current`); `config.maxRunning`; cluster capacity; cold start |

Useful queries: `krun_runs_current` by state and function;
`krun_runs_failed_total` by reason; `krun_job_create_errors_total` by code
(permanent 4xx means a broken Function spec or RBAC, 5xx means the API
server).

Run `node scripts/check-operations-alerts.ts` to compare this complete table
with the actual rendered PrometheusRule in both database modes. The check
fails on missing, undocumented, duplicate or malformed rule evidence and
runs in the normal `make check` tooling tests. It does not test live alert
firing or replace the operator first checks above.

## Logs of a run

`kubectl logs -f -n krun-jobs job/krun-<id>` works only while the run is
`scheduled` or `running`: the scheduler deletes the Job at the terminal
transition. For a finished run, `GetRun`
(`GET /v1/functions/-/runs/{id}`) returns `logTail` on failure only (last 100 lines, 16 KB, may be null when the
container never ran). Successful runs leave no logs in krun; use the
cluster's log aggregation. Function authors get `krun-job-viewer` for the
in-flight case.

## Backup and restore

- Postgres mode: backups belong to the managed service. The `runs` table
  is the only state; `deliveries` and `run_events` cascade from it.
- Embedded mode with Litestream: the native sidecar streams the WAL to object
  storage continuously. Restore drill: scale the StatefulSet to 0; from a
  throwaway pod mounting the PVC delete `krun.db`, `krun.db-wal` and
  `krun.db-shm` (or delete the PVC for the corrupt-volume case); scale back
  to 1; the restore init container removes orphan `-wal` and `-shm` files
  when `krun.db` is absent, pulls the latest replica, then `krun migrate`
  runs. A run created before the drill must be readable after it. Run the
  drill before relying on it.
- Embedded mode without Litestream: the PVC is the only copy; snapshot it
  with the storage class or enable Litestream.

### Measured embedded restore drill

The local unfiltered embedded-mode e2e corpus on 2026-11-04 passed all
22 scenarios, including the actual embedded Litestream restore. Run
`make e2e` to exercise the scenario corpus through the owned disposable
foundation; do not point the fixtures at an operated or production cluster.
These are local recovery measurements, not publication acceptance or a
production recovery-time guarantee.

The drill uses real MinIO and digest-pinned Litestream 0.3.13, not
mocked S3 replies. A test-only native loopback TCP transport adapts that
version's localhost/path-style S3 URL to the owned MinIO Service without
changing chart options or network policy. It does not qualify other
Litestream versions or demonstrate production registry/namespace ownership.

1. Complete a Run before enabling replication. Restore the actual replica to
   a separate temporary database and query that pre-drill Run there before
   deleting primary data. Replica existence alone is insufficient evidence.
2. Stop the exact owned embedded StatefulSet and positively observe its Pod
   absent. A restricted helper mounts only its existing data PVC, verifies
   regular database files, removes the primary DB/WAL/SHM, and leaves deliberate
   orphan WAL/SHM witnesses to exercise the chart's restore-init cleanup.
3. Confirm the removal witness and remove the helper before restarting the
   StatefulSet. Require a new serving Pod UID and public API readiness after
   the chart's actual restore init and migrations.
4. Restore and compare the exact original Pod template, remove the dedicated
   test Secret, read the retained pre-drill Run through the API unchanged, and
   complete another Run. Keep inputs, outputs and credentials out of logs.

Fixture cleanup is part of acceptance, not a best-effort restart. Each
recovery Secret and helper Pod carries a fresh invocation identity. Cleanup
reconciles lost create acknowledgements, verifies ownership and deletes with
an API UID precondition; it never adopts a colliding resource. The workload
stays stopped if helper absence cannot be positively established, including
an unresolved create outcome. No scale-up or Helm rollback is allowed in
that state. Reconcile the exact helper identity and confirm removal before
manually restarting; do not delete an unrelated colliding resource.

| Embedded e2e segment | Seconds | Measurement boundary |
|---|---:|---|
| Independent replica readability | 1.536 | Ready replication workload to a successful separate S3 restore and SQLite Run query |
| Restore-to-Ready downtime | 56.040 | Scale-to-zero request through positive removal, restart, new Pod UID and public API readiness |
| Fixture drill lifecycle | 138.997 | Enable replication through exact original-template restoration and helper/Secret cleanup |

Restore-to-Ready is below the default 24-hour finished-Job TTL. API Run
readback and a successful new Run were separately asserted after restoration
and fixture cleanup; their latency is not included in the downtime row.
This is database-file loss on the retained PVC, not complete PVC loss or an
etcd snapshot/restore rehearsal. Repeat the recovery procedure with the
operated storage, pinned image and backup policy before relying on its RPO/RTO.

## Telemetry

- Set `observability.otlpEndpoint` to an OpenTelemetry collector's
  OTLP/HTTP endpoint to export traces; empty drops them. Sampling is
  parent-based at 10 percent by default (`observability.tracesSampleRatio`).
- Every span about a run carries `krun.run_id`: search the tracing backend
  for it to see the `CreateRun` request, the scheduler iteration that
  created the Job and the pod's internal API calls. Log lines inside a span
  carry `traceId`.
- Metrics stay on the admin port in Prometheus format; scrape as before.

## Security operations

- User namespaces: set `jobsNamespace.userNamespaces=true` only when every
  node supports them (Kubernetes 1.36, or the feature gate on 1.33 to
  1.35, plus a runtime and kernel with ID-mapped mounts). Test one function
  first: images that chown files at start-up can fail.
- The digest admission policy (`jobsNamespace.admissionPolicy`) rejects any
  Job or Pod in the jobs namespace whose image has no `@sha256:`, including
  ones created by hand.

- API key rotation: add the new secret to the key's `key` list in the
  Secret, wait one 30 second reload, switch clients, remove the old one.
  No restart needed.
- Webhook secret rotation: set the `secret` key of `webhooks.existingSecret`
  to `new,old`, then `kubectl rollout restart deployment/krun-scheduler`
  (postgres) or `statefulset/krun` (embedded); roll receivers to accept
  either signature, then drop `old` and restart again. The same restart
  applies to `objectStorage.existingSecret` and `db.postgres.existingSecret`
  edits: these reach the pods as env.
- Webhook targets inside the cluster: list the pod or Service CIDR in
  `webhooks.allowedCIDRs`; everything private is rejected otherwise.
- Internet egress for functions: never a bare `0.0.0.0/0`. Use
  `jobsNamespace.egressCIDRs: [{ cidr: 0.0.0.0/0, except: [10.0.0.0/8,
  172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16] }]` and add
  the node and Service CIDRs when they fall outside those ranges; the
  169.254.0.0/16 exception keeps cloud metadata credentials unreachable.
- NodeLocal DNSCache: append `{ ipBlock: { cidr: 169.254.20.10/32 } }` (or
  the cluster's local DNS address) to `jobsNamespace.dnsEgress`, else job
  pods cannot resolve names.
- Function authors: bind `krun-function-author` in the krun namespace and
  `krun-job-viewer` in the jobs namespace to the team's group. Authors never
  get write access to the jobs namespace; the platform team creates the
  Secrets that `secretRefs` name.
- Image policy: enforce signatures on function images with the cluster's
  admission policy; krun only requires a digest.

## Runbook snippets

```
# runs stuck in queued for one function
kubectl get kfn <name> -n krun -o jsonpath='{.status.conditions}'
curl -sG -H "Authorization: Bearer $KRUN_API_KEY" "$KRUN_API_URL/v1/functions/<name>/runs" --data-urlencode 'filter=state = QUEUED' --data-urlencode pageSize=5

# a failed run
curl -s -H "Authorization: Bearer $KRUN_API_KEY" "$KRUN_API_URL/v1/functions/-/runs/<id>" | jq '.failureReason, .error, .logTail'

# a run still in flight
kubectl logs -f -n krun-jobs job/krun-<id>

# leader
kubectl get lease krun-scheduler -n krun -o jsonpath='{.spec.holderIdentity}'
```
