# kind e2e recipe (P4.12, P6.3, P7.6)

Everything here lands under `test/e2e/` and the Makefile targets `kind-up`,
`kind-down`, `e2e` (PLAN.md:135-136). The recipe follows P4.12
(PLAN.md:600-612). Upstream sources re-verified on 2026-10-23: kind's
`site/static/examples/kind-with-registry.sh` (main branch), the kind
v0.31.0 and v0.33.0 release notes, and the `helm/kind-action` `action.yml`
(main).

## Tool versions

- `kind` 0.31 or newer (PLAN.md:52-53, 610): kindnetd enforces
  NetworkPolicy via `sigs.k8s.io/kube-network-policies` (VERIFIED, release
  notes); without enforcement the probe fails. Latest on 2026-10-23 is
  v0.33.0 (default node `kindest/node:v1.37.0`); pin node images by
  `@sha256`, as the release notes require.
- kind node image of Kubernetes 1.33 or newer (PLAN.md:55, SPEC.md
  section 14, D36): native sidecars (Litestream), ValidatingAdmissionPolicy
  (P7.4d) and the `DisruptionTarget` condition need it. Node images are
  built per kind release; use a 1.33-or-newer image listed in the pinned
  kind release's notes.
- User namespaces (`hostUsers: false`, P7.4d) need 1.36, or the feature
  gate on 1.33 to 1.35, and kernel support on the runner; e2e checks only
  that the field renders, not that the pod runs in a user namespace.
- `helm/kind-action` in `ci.yml` pinned to the same kind version
  (PLAN.md:56-57, 609-610). The action has `version` and `version_file`
  inputs (VERIFIED, `action.yml`; default `v0.33.0`): keep the version in
  one plain file (for example `.kind-version`) read by the Makefile and
  passed as `version_file`. Use `install_only: true` so `make kind-up`
  creates the cluster in CI and locally alike; do not use the action's own
  `registry` input (it binds port 5000 by default; krun uses 5001).
- `kubectl`, `helm` 4 (PLAN.md:52-54); Phase 7 adds `helm-docs`,
  `promtool` (docs/AGENT-KICKOFF.md:41-46). A missing tool is `BLOCKED`.
  Pin Helm 4 like kind: one `HELM_VERSION` in the Makefile, read by every
  workflow job that installs Helm, so local and CI renders agree.

## `make kind-up`

1. Start the registry if not running:
   `docker run -d --restart=always -p "127.0.0.1:5001:5000" --network bridge --name kind-registry registry:2`
   (PLAN.md:601-602). Pin it by digest in the Makefile. Upstream's script
   uses `registry:3`; PLAN names `registry:2`, so keep it unless a
   Decisions row changes it.
2. Create the cluster with the containerd config patch (PLAN.md:603):

   ```yaml
   kind: Cluster
   apiVersion: kind.x-k8s.io/v1alpha4
   containerdConfigPatches:
     - |-
       [plugins."io.containerd.grpc.v1.cri".registry]
         config_path = "/etc/containerd/certs.d"
   ```

   Upstream notes the patch is unnecessary with node images from kind
   0.27.0 or newer, which covers every supported kind; it is harmless and
   PLAN requires it, so keep it.
3. For every node (`kind get nodes`) write the mirror `hosts.toml`:
   `docker exec <node> mkdir -p /etc/containerd/certs.d/localhost:5001`,
   then pipe `[host."http://kind-registry:5000"]` into
   `docker exec -i <node> cp /dev/stdin /etc/containerd/certs.d/localhost:5001/hosts.toml`
   (upstream step 3).
4. Connect the registry to the `kind` network when
   `docker inspect -f='{{json .NetworkSettings.Networks.kind}}' kind-registry`
   prints `null`: `docker network connect kind kind-registry`.
5. Apply the `local-registry-hosting` ConfigMap in `kube-public` with
   data key `localRegistryHosting.v1` holding `host: "localhost:5001"` and
   `help: "https://kind.sigs.k8s.io/docs/user/local-registry/"`
   (PLAN.md:603-604).
6. Build and push the krun image: `make docker`, then
   `docker tag krun:dev localhost:5001/krun:dev && docker push localhost:5001/krun:dev`;
   take the digest from the push output's `digest:` line (same rule as
   P8.6, PLAN.md:830-832) and export
   `KRUN_E2E_IMAGE=localhost:5001/krun@sha256:...`.
7. Run the enforcement probe (below). A failure aborts `kind-up`.
8. `kubectl apply -f deploy/crds/functions.krun.io.yaml` (PLAN.md:607) and
   `kubectl wait --for=condition=Established crd/functions.krun.io`.
9. Until P7.6: apply the raw jobs-namespace manifests (below) and the raw
   krun manifests for both processes in embedded mode from the local image
   (PLAN.md:607-609). From P7.6: `helm install` (see "Chart switch").

`make kind-down`: `kind delete cluster`, then `docker rm -f kind-registry`
(PLAN.md:604).

## Enforcement probe (mandatory, PLAN.md:605-606, SPEC.md:1434-1435)

```
namespace krun-probe (fresh, deleted in cleanup)
  pod probe-server: the e2e image with a tiny `node -e` TCP listener on 8080
  pod probe-client: curl --max-time 5 http://<probe-server pod IP>:8080
step 1: no policy           -> client exits 0 (proves the probe works)
step 2: NetworkPolicy deny-all (podSelector {}, policyTypes [Ingress, Egress])
                            -> client exits non-zero (connection blocked)
```

Both halves are required: the open half catches a probe that "passes"
because the server never started. Fail `make e2e` with a message naming
kind and kindnetd when the denied half connects. Wait for the server pod
`Ready` (tri-state, below) before step 1; policy programming is
asynchronous, so step 2 retries the blocked check for up to 30 s and passes
on the first blocked attempt.

## Raw jobs-namespace manifests (pre-chart, P4.12 to P7.5)

`test/e2e/jobs-namespace.yaml`, one document each, mirrors SPEC.md:996-1047
so the Phase 4-6 scenarios run under the same isolation the chart will
render (`krun-helm-chart` `references/networkpolicies.md` owns the exact
rules; copy, do not reinterpret):

| Kind | Content |
|---|---|
| Namespace `krun-jobs` | labels `pod-security.kubernetes.io/{enforce,warn,audit}: restricted`, each `-version: v1.29` (SPEC.md:1010-1012) |
| NetworkPolicy `deny-all` | `podSelector: {}`, `policyTypes: [Ingress, Egress]` (SPEC.md:1013) |
| NetworkPolicy `allow-dns` | egress UDP+TCP 53 to `kube-system` pods `k8s-app: kube-dns` (SPEC.md:1013-1016) |
| NetworkPolicy `allow-gateway-internal` | egress TCP 8081 to pods `krun.io/gateway: "true"` in namespace `kubernetes.io/metadata.name: krun` (SPEC.md:1017-1018) |
| NetworkPolicy `allow-minio` (P6.3) | egress to MinIO pods on the endpoint port (SPEC.md:1018-1021, PLAN.md:668-670) |
| LimitRange | defaults plus `max` cpu 4, memory 8Gi, ephemeral-storage 20Gi (SPEC.md:1027-1029) |
| ResourceQuota | pods, cpu, memory, ephemeral-storage requests (SPEC.md:1029-1030) |
| ServiceAccount `krun-job-default` | `automountServiceAccountToken: false` (SPEC.md:1032-1033) |
| Role + RoleBinding for the scheduler | verbs in SPEC.md:1034-1039 |

The raw krun manifests (`test/e2e/krun-embedded.yaml`) run both processes
in one pod with a shared `emptyDir` at `/data` (embedded mode needs one
SQLite file; `KRUN_DB_PATH` default `/data/krun.db`, SPEC.md:1190), the pod
labelled `krun.io/gateway: "true"`, `KRUN_JOBS_NAMESPACE=krun-jobs`,
`KRUN_NAMESPACE=krun`,
`KRUN_GATEWAY_INTERNAL_URL=http://krun-gateway-internal.krun.svc:8081`
(SPEC.md:1195), the keys file from a Secret generated by the e2e run
(PLAN.md:33), and `KRUN_ADMIN_LISTEN_ADDR=:9091` on the scheduler
container (SPEC.md:1194). Containers run as 65532 with a read-only root
filesystem and an `emptyDir` at `/tmp` (SPEC.md:1320-1323). These
manifests are throwaway: P7.6 deletes them.

## MinIO (P6.3)

`test/e2e/minio.yaml`: Namespace `minio`, one Deployment `minio/minio`
pinned by digest with `server /data`, a Service on 9000, a Job creating the
bucket. The jobs-namespace `allow-minio` policy selects namespace
`kubernetes.io/metadata.name: minio` and pods `app: minio` on TCP 9000
(SPEC.md:1018-1021). The scheduler gets `KRUN_S3_*` (SPEC.md:1212-1213)
pointing at `http://minio.minio.svc:9000` (objstore details in
`krun-webhooks-objstore`). Presigned URLs embed the endpoint host, so the
job pod must resolve `minio.minio.svc`: DNS egress is already allowed. The
P6.1 unit test uses `@testcontainers/minio`, not this deployment.

## Webhook receiver (P5.4)

`test/e2e/receiver.yaml`: a pod in a `krun-receiver` namespace running a
small Node listener from the e2e image that stores every request (headers
and body) in memory and serves them on `GET /deliveries`. The scheduler's
`KRUN_WEBHOOK_ALLOWED_CIDRS` lists the kind pod CIDR and Service CIDR
(PLAN.md:621-623, SPEC.md:1472 D31). Read both from the cluster:
`kubectl -n kube-system get cm kubeadm-config -o yaml` (`podSubnet`,
`serviceSubnet`). The receiver verifies `X-Krun-Signature` (`t=`, one
`v1=` per secret, SPEC.md:1075-1084) with the webhook secret from its own
Secret; the test asserts the receiver's recorded verdict, never the secret
value.

## Chart switch (P7.6, PLAN.md:758-771)

- Replace the raw manifests with
  `helm install krun deploy/helm/krun -n <fresh ns>` after creating the
  namespace labelled `pod-security.kubernetes.io/enforce=restricted`
  (PLAN.md:674-678).
- Two installs per run: embedded (`db.mode=embedded`) and postgres
  (`db.mode=postgres`, DSN Secret pointing at the plain Deployment from
  `test/e2e/postgres.yaml`), each in its own namespace and jobs namespace.
- `objectStorage.egress` set to the MinIO namespace and pod selectors
  (PLAN.md:760-761).
- Keep one `kubectl apply -f deploy/crds/functions.krun.io.yaml` path for
  the `crds.install=false` scenario (`krun-helm-chart`).
- Upgrade scenario: `helm upgrade --set config.logLevel=debug`, then
  `helm rollback <release> 1`; a run submitted during the rollout must
  succeed and the scheduler gap must stay below `KRUN_TTL_AFTER_FINISHED`
  (SPEC.md:1416-1417): measure the gap from the Lease `holderIdentity`
  change times observed by the test.

## Harness (`test/e2e/`)

- Runner: Vitest with its own `test/e2e/vitest.config.ts`:
  `include: ["test/e2e/**/*.e2e.ts"]`, `fileParallelism: false` (one
  cluster; the backpressure and quota scenarios must not share it),
  `testTimeout` and `hookTimeout` 600_000, `retry: 1` (the count shows in
  the summary). `make e2e` runs
  `pnpm exec vitest run --config test/e2e/vitest.config.ts`; `make test`
  never collects e2e files.
- e2e code is plain async TypeScript (`child_process`, `fetch`) on real
  time; `@effect/vitest` and `TestClock` do not apply to a cluster.
- `KRUN_E2E_*` env carries gateway URL, kubeconfig, registry, image digest
  and mode. One Function per file, named `<file>-<random>`.
- Each file: `beforeAll` applies its Function and waits `Ready=True`
  (tri-state: `Ready=False` with the current generation fails now);
  `afterAll` deletes the Function; its runs' Jobs are reaped by the
  scheduler or the namespace delete.
- On failure dump `kubectl logs` of gateway and scheduler and
  `kubectl get jobs,pods -o wide` from `onTestFailed` (keda
  `tests/run-all.go:302-330`).
- P9.4 quickstart 1800 s per mode (PLAN.md:880-884): set it on that test,
  not globally.
- Never print a key, token or presigned URL in diagnostics
  (SPEC.md:1149-1154).

## Wait helpers (`test/e2e/lib/wait.ts`)

```ts
type Verdict = { done: false } | { done: true } | { done: true; fail: string }
export async function eventually<T>(read: () => Promise<T>, judge: (t: T) => Verdict,
  { timeoutMs = 120_000, intervalMs = 5_000, warnAfterMs = 30_000 } = {}): Promise<T>
```

- `read` errors are remembered, not fatal; the final error carries the
  last error and the last observed object (keda
  `tests/helper/helper.go:304-386`).
- `judge` returning `{ done: true, fail }` throws at once (knative-serving
  `test/v1/revision.go:33-86`): a run that reached `FAILED` while the test
  waits for `SUCCEEDED` fails in one interval, not after 2 minutes.
- Warn on stderr after `warnAfterMs`, then at most every 10 s, with the
  last state (knative-func `e2e/e2e_test.go:803-863`).
- Never wait for "zero Jobs" without first having seen at least one.
- This helper and the process tests are the only places a test waits on
  wall-clock time; they poll with a bounded deadline, never a fixed sleep.
  Vitest's `expect.poll` / `vi.waitFor` are not a substitute: they neither
  remember read errors nor fail fast on a wrong terminal state.
