# kind e2e recipe (P4.12, P6.3, P7.6)

Everything here lands under `test/e2e/` and the Makefile targets `kind-up`,
`kind-down`, `e2e` (PLAN.md:135-136). The recipe follows PLAN.md:600-612;
kind's "Local Registry" page is the upstream source for the registry steps
and is UNVERIFIED against kind 0.24+ here: re-read it when implementing.

## Tool versions

- `kind` 0.24 or newer: its kindnetd enforces NetworkPolicy (PLAN.md:52-53).
  Older kind silently ignores policies and the enforcement probe fails.
- `helm/kind-action` in `ci.yml` pinned to the same kind version
  (PLAN.md:56-57, 609-610). Keep the version in one place: a
  `KIND_VERSION` variable in the Makefile read by the workflow.
- `kubectl`, `helm` 4 (PLAN.md:52-54); Phase 7 adds `helm-docs`,
  `promtool` (docs/AGENT-KICKOFF.md:40-45). A missing tool is `BLOCKED`.
  Pin the Helm 4 release like kind: one `HELM_VERSION` in the Makefile,
  read by every workflow job that installs Helm, so local and CI renders
  agree.

## `make kind-up`

1. Start the registry if absent:
   `docker run -d --restart=always -p "127.0.0.1:5001:5000" --network bridge --name kind-registry registry:2`
   (PLAN.md:601-602). Pin `registry:2` by digest in the Makefile.
2. Create the cluster with `containerdConfigPatches` enabling
   `config_path = "/etc/containerd/certs.d"` (PLAN.md:603):

   ```yaml
   kind: Cluster
   apiVersion: kind.x-k8s.io/v1alpha4
   containerdConfigPatches:
     - |-
       [plugins."io.containerd.grpc.v1.cri".registry]
         config_path = "/etc/containerd/certs.d"
   ```

3. For every node write the mirror `hosts.toml`:
   `docker exec <node> sh -c 'mkdir -p /etc/containerd/certs.d/localhost:5001 && cat > /etc/containerd/certs.d/localhost:5001/hosts.toml'`
   with `[host."http://kind-registry:5000"]` (PLAN.md:603).
4. Connect the registry to the `kind` network:
   `docker network connect kind kind-registry` when not yet connected
   (PLAN.md:602).
5. Apply the `local-registry-hosting` ConfigMap in `kube-public` with
   `host: "localhost:5001"` and `help: https://kind.sigs.k8s.io/docs/user/local-registry/`
   (PLAN.md:604).
6. Build and push the krun image: `make docker` then
   `docker tag krun:dev localhost:5001/krun:dev && docker push localhost:5001/krun:dev`;
   take the digest from the push output's `digest:` line (same rule as
   P8.6, PLAN.md:831-832) and export `KRUN_E2E_IMAGE=localhost:5001/krun@sha256:...`.
7. Run the enforcement probe (below). A failure aborts `kind-up`.
8. `kubectl apply -f deploy/crds/functions.krun.io.yaml` (PLAN.md:607) and
   wait for `Established`.
9. Until P7.6: apply the raw jobs-namespace manifests (below) and the raw
   krun manifests for both processes in embedded mode from the local image
   (PLAN.md:607-609). From P7.6: `helm install` (see "Chart switch").

`make kind-down`: `kind delete cluster` then `docker rm -f kind-registry`
(PLAN.md:604).

## Enforcement probe (mandatory, PLAN.md:605-606, SPEC.md:1434-1435)

```
namespace krun-probe (fresh, deleted in cleanup)
  NetworkPolicy deny-all (podSelector {}, policyTypes [Ingress, Egress])
  pod probe-server: image from the registry mirror (any image serving TCP 8080; the e2e image itself with a tiny `node -e` listener is fine)
  pod probe-client: curl --max-time 5 http://<probe-server pod IP>:8080
expect: client exits non-zero (connection blocked)
then: delete the policy, repeat, expect exit 0 (proves the probe itself works)
```

Both halves are required: the second half catches a probe that "passes"
because the server never started. Fail `make e2e` with a message naming
kind and kindnetd when the first half connects.

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
| NetworkPolicy `allow-minio` (P6.3) | egress to MinIO pods, port from the endpoint (SPEC.md:1018-1021, PLAN.md:668-670) |
| LimitRange | defaults plus `max` cpu 4, memory 8Gi, ephemeral-storage 20Gi (SPEC.md:1027-1029) |
| ResourceQuota | pods, cpu, memory, ephemeral-storage requests (SPEC.md:1029-1030) |
| ServiceAccount `krun-job-default` | `automountServiceAccountToken: false` (SPEC.md:1032-1033) |
| Role + RoleBinding for the scheduler | verbs in SPEC.md:1034-1036 |

The raw krun manifests (`test/e2e/krun-embedded.yaml`) run both processes in
one pod with a shared `emptyDir` at `/data` (embedded mode needs one
SQLite file, SPEC.md:1190), the gateway pod labelled `krun.io/gateway: "true"`,
`KRUN_JOBS_NAMESPACE=krun-jobs`, `KRUN_NAMESPACE=krun`,
`KRUN_GATEWAY_INTERNAL_URL=http://krun-gateway-internal.krun.svc:8081`
(SPEC.md:1195), the keys file from a Secret generated by the e2e run
(PLAN.md:33), and `KRUN_ADMIN_LISTEN_ADDR=:9091` on the scheduler container
(SPEC.md:1327-1328 names the ports). These manifests are throwaway: P7.6
deletes them.

## MinIO (P6.3)

`test/e2e/minio.yaml`: Namespace `minio`, one Deployment `minio/minio`
pinned by digest with `server /data`, a Service on 9000, a Job creating the
bucket. The jobs-namespace `allow-minio` policy selects namespace
`kubernetes.io/metadata.name: minio` and pods `app: minio` on TCP 9000
(SPEC.md:1018-1021). The scheduler gets `KRUN_S3_*` pointing at
`http://minio.minio.svc:9000` with `forcePathStyle` (objstore details in
`krun-webhooks-objstore`). Presigned URLs embed the endpoint host, so the
job pod must resolve `minio.minio.svc`: DNS egress is already allowed.

## Webhook receiver (P5.4)

`test/e2e/receiver.yaml`: a pod in a `krun-receiver` namespace running a
small Node listener from the e2e image that stores every request (headers
and body) in memory and serves them on `GET /deliveries`. The scheduler's
`KRUN_WEBHOOK_ALLOWED_CIDRS` lists the kind pod CIDR and Service CIDR
(PLAN.md:620-623, SPEC.md:1472 D31). Read both from the cluster:
`kubectl -n kube-system get cm kubeadm-config -o yaml` (`podSubnet`,
`serviceSubnet`). The receiver verifies the signature with the webhook
secret it was given through its own Secret; the test asserts the receiver's
recorded verdict, never the secret value.

## Chart switch (P7.6, PLAN.md:758-771)

- Replace the raw manifests with `helm install krun deploy/helm/krun -n <fresh ns> --create-namespace`
  after labelling the namespace `pod-security.kubernetes.io/enforce=restricted`
  (PLAN.md:674-678).
- Two installs per run: embedded (`db.mode=embedded`) and postgres
  (`db.mode=postgres`, DSN Secret pointing at the plain Deployment from
  `test/e2e/postgres.yaml`), each in its own namespace and jobs namespace.
- `objectStorage.egress` set to the MinIO namespace and pod selectors
  (PLAN.md:760).
- Keep one `kubectl apply -f deploy/crds/functions.krun.io.yaml` path for the
  `crds.install=false` scenario (SPEC.md chart rules in `krun-helm-chart`).
- Upgrade scenario: `helm upgrade --set config.logLevel=debug`, then
  `helm rollback <release> 1`; a run submitted during the rollout must
  succeed and the scheduler gap must stay below `KRUN_TTL_AFTER_FINISHED`
  (SPEC.md:1416-1417): assert the gap from the Lease `holderIdentity`
  change timestamps.

## Wait helpers (`test/e2e/lib/wait.ts`)

```ts
type Verdict = { done: false } | { done: true } | { done: true; fail: string }
export async function eventually<T>(read: () => Promise<T>, judge: (t: T) => Verdict,
  { timeoutMs = 120_000, intervalMs = 5_000, warnAfterMs = 30_000 } = {}): Promise<T>
```

- `read` errors are remembered, not fatal; the final error carries the last
  error and the last observed object (keda `tests/helper/helper.go:304-386`).
- `judge` returning `{done: true, fail}` throws at once with `fail`
  (knative-serving `test/v1/revision.go:33-86`): a run that reached `FAILED`
  while the test waits for `SUCCEEDED` fails in one interval, not after
  2 minutes.
- Warn on stderr after `warnAfterMs`, then at most every 10 s, with the
  last state (knative-func `e2e/e2e_test.go:803-863`).
- Never wait for "zero Jobs" without first having seen at least one.
- This helper and the process tests are the only places a test waits on
  wall-clock time: they observe a real cluster or a real process. They
  poll with a bounded deadline; no test ever sleeps a fixed time, and
  unit tests never poll at all (`TestClock`, SKILL.md rule 6).

## Scenario harness conventions

- `test/e2e/*.e2e.ts` run by Vitest with their own
  `test/e2e/vitest.config.ts` (`include: ['**/*.e2e.ts']`,
  `testTimeout: 600_000`, `hookTimeout: 600_000`, `fileParallelism: false`
  so the backpressure and quota scenarios do not share the cluster with
  other files): `make e2e` runs
  `pnpm exec vitest run --config test/e2e/vitest.config.ts`. `vitest` is a
  root dev dependency for this; `make test` never collects e2e files.
  `KRUN_E2E_*` env carries gateway URL, kubeconfig, registry, image digest
  and mode. One Function per file, named `<file>-<random>`.
- Each file: `beforeAll` applies its Function and waits `Ready=True`
  (tri-state: `Ready=False` with the current generation fails now);
  `afterAll` deletes the Function, its runs' Jobs are reaped by the
  scheduler sweep or the namespace delete. e2e code is plain async
  TypeScript (`child_process`, `fetch`); it does not need Effect.
- On failure dump `kubectl logs` of gateway and scheduler and
  `kubectl get jobs,pods -o wide` into the test diagnostics (keda
  `tests/run-all.go:302-330`).
- Retries: at most one (`retry: 1` in the e2e config); the count shows in
  the Vitest summary.
- Per-file timeout 10 minutes; P9.4 quickstart 1800 s per mode
  (PLAN.md:883-884).
- Never print a key, token or presigned URL in diagnostics
  (SPEC.md:1149-1154).
