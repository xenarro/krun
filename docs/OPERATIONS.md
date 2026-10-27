# Operating krun

For the platform team. SPEC.md sections 9, 11 and 13 define the behaviour
this document explains. Numbers marked "measured" are filled in at PLAN
P9.3.

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
  re-annotate the CRD as SPEC section 13 describes.

The serving scheduler requires `KRUN_POD_NAME` from downward API
`metadata.name` as its Lease identity (SPEC D98); do not substitute a shared
constant or infer it from the host name. Run explicit migrations before serving.
Its standby remains ready after database/Function synchronization and reports
`leader: false`; Job/Pod watches and work are acquired only by the leader.
Use a distinct admin address from the gateway when colocating the processes.

## Disposable development cluster

The P4.12 local foundation is separate from the production Helm workflow.
Use the pinned prerequisites and Make targets in `test/e2e/README.md`:
`make kind-up`, `make e2e`, then `make kind-down`. The harness owns only the
`krun-test-e2e` cluster and its labelled loopback `kind-registry`; all Kubernetes
commands use a private kubeconfig and explicit test context. Keep its private
state during recovery, never publish it or generated credentials, and use the
same checkout/TMPDIR for cleanup. E2E verifies real default-deny enforcement
before its five Phase 4 scenarios: result/status round-trip, exit 1, image-pull
deadline, two statuses then exit 3, and heartbeat expiry with Job removal. The
local P4.13 gate now passes; exact task-head hosted verification remains delivery
work. This raw embedded setup is disposable, not a durable production deployment.
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

## Alerts and first checks

Rule names match `metrics.prometheusRule` in the chart (SPEC section 13).

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

## Logs of a run

`kubectl logs -f -n krun-jobs job/krun-<id>` works only while the run is
`scheduled` or `running`: the scheduler deletes the Job at the terminal
transition (SPEC D28). For a finished run, `GetRun`
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
  runs. A run created before the drill must be readable after it (PLAN
  P9.6). Run the drill before relying on it.
- Embedded mode without Litestream: the PVC is the only copy; snapshot it
  with the storage class or enable Litestream.

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
