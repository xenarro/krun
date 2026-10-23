# Pod template contract (SPEC.md:1319-1364)

One `_helpers.tpl` partial per concern (`krun.podSecurityContext`,
`krun.containerSecurityContext`, `krun.probes`, `krun.configEnv`,
`krun.labels`), included from every pod template, so a fix lands in all
of them. Every pod means: gateway Deployment, scheduler Deployment,
embedded StatefulSet, migrate hook Job, every init container and the
Litestream sidecar (SPEC.md:1319-1320).

## Labels (SPEC.md:990-994)

| Label | Where | Why |
|---|---|---|
| `app.kubernetes.io/name: krun` | every pod template, selectors, PodMonitor | deny-all and admin-port policies, PodMonitor select by it |
| `app.kubernetes.io/instance: {{ .Release.Name }}` | every pod template, selectors, PodMonitor | same |
| `app.kubernetes.io/component: gateway|scheduler|krun|migrate` | per workload | Deployment selectors must differ; not SPEC-mandated, standard |
| `krun.io/gateway: "true"` | gateway Deployment and embedded StatefulSet pod templates ONLY | 8080/8081 ingress and the jobs-namespace 8081 egress select it (SPEC.md:991-994, 1017-1018) |
| `helm.sh/chart`, `app.kubernetes.io/managed-by`, `app.kubernetes.io/version` | metadata labels only | never in selectors (immutable); see `kubernetes-skill` helm-patterns.md |

Never put `krun.io/gateway` on the scheduler Deployment or the hook Job:
it would open 8080/8081 to them and admit them as "gateway" peers.

## Security context (SPEC.md:1319-1324)

Pod level:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  seccompProfile: { type: RuntimeDefault }
  # embedded StatefulSet only (SPEC.md:1350-1351):
  fsGroup: 65532
  fsGroupChangePolicy: OnRootMismatch
```

Every container, init container and sidecar:

```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  seccompProfile: { type: RuntimeDefault }
```

Plus `volumes: [{ name: tmp, emptyDir: {} }]` mounted at `/tmp` on every
container (SPEC.md:1323). 65532 is distroless `nonroot` (SPEC.md:1321).
Repeating `runAsNonRoot`/`seccompProfile` at both levels is deliberate:
PSA `restricted` accepts either, but a future container added without
the partial would otherwise fail admission with a confusing message
(knative serving `secure-pod-defaults` applies them per container for
the same reason, `pkg/apis/serving/v1/revision_defaults.go:206-264`). The
Litestream image must also run as 65532; if a chosen image needs root the
chart cannot fix it: BLOCKED, not a `runAsUser` override.

`automountServiceAccountToken`: `true` only on the gateway and the
scheduler pods (they read Functions and the Lease and `KRUN_NAMESPACE`
from the SA namespace file, SPEC.md:1324, 1197); `false` on the migrate
hook pod and the `krun-migrate` SA (SPEC.md:1345-1346) and on
`krun-job-default` (SPEC.md:1032-1033). In embedded mode the one pod
mounts the scheduler SA token (SPEC.md:1352-1354).

## Probes (SPEC.md:1327-1331)

| Probe | Path | Port | periodSeconds | timeoutSeconds | failureThreshold |
|---|---|---|---|---|---|
| readiness | `/readyz` | the container's own admin port name | 5 | 3 | 3 |
| liveness | `/healthz` | the container's own admin port name | 10 | 3 | 3 |
| startup | none | | | | |

Liveness on `/readyz` would restart a healthy standby or a pod whose
database stalls for 2 s (SPEC.md:1161-1164). No `initialDelaySeconds`
and no startup probe: `/healthz` answers as soon as the listener is up
(SPEC.md:1161); KEDA's `initialDelaySeconds: 25` is a workaround for a
`Ping` handler krun does not have (keda `config/manager/manager.yaml:47-56`).

Port names: `admin` (9090) on gateway, scheduler and the embedded gateway
container; `admin-sched` (9091) on the embedded scheduler container, with
`KRUN_ADMIN_LISTEN_ADDR=:9091` (SPEC.md:1356-1358). Also declare `http`
8080 and `internal` 8081 on gateway containers; the Services target the
numeric ports.

## Resources (SPEC.md:1233, 1236, 1331)

Default `requests: { cpu: 100m, memory: 128Mi }`, `limits: { memory: 512Mi }`,
rendered with `toYaml .Values.gateway.resources` / `.scheduler.resources`.
No CPU limit by default: throttling a Node event loop under a CPU limit
inflates every latency metric and makes probes flap. The migrate hook
and init containers reuse the scheduler resources; the Litestream
sidecar gets the same block (SPEC fixes no separate value and no task
asks for one, PLAN.md:31-32).

## Scheduling and lifecycle

| Field | Value | Where | SPEC |
|---|---|---|---|
| `priorityClassName` | `.Values.priorityClassName` when non-empty (`with`) | every pod | SPEC.md:1237, 1332 |
| `terminationGracePeriodSeconds` | `.Values.terminationGracePeriodSeconds` (30) | every pod | SPEC.md:1238, 1332; both shutdown sequences fit 30 s (SPEC.md:1174) |
| `strategy` | `RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0` | scheduler Deployment | a Ready standby exists before the leader gets SIGTERM; the old leader clears `holderIdentity` and the standby takes over at once (SPEC.md:1335-1337, 1171-1173) |
| `strategy` | Deployment default (`25%/25%`) is acceptable; nothing in SPEC fixes it | gateway Deployment | drain makes `/readyz` 503 for `shutdownDelay` first (SPEC.md:1166-1170) |
| `topologySpreadConstraints` | `maxSkew: 1`, `topologyKey: kubernetes.io/hostname`, `whenUnsatisfiable: ScheduleAnyway`, `labelSelector` = the gateway selector | gateway Deployment | SPEC.md:1334-1335; `ScheduleAnyway` so a one-node kind cluster still schedules both replicas |
| PodDisruptionBudget | `policy/v1`, `minAvailable: 1`, selector = gateway selector | only when `gateway.replicas > 1` | SPEC.md:1333-1334; a PDB with `minAvailable: 1` on a single replica blocks node drains forever |
| `restartPolicy` | `Always` (default) | Deployments, StatefulSet | |
| `nodeSelector`, `tolerations`, `affinity` | none | | no task asks; adding them is PLAN.md:31-32 scope creep |

No PDB for the scheduler: one replica is the default and the standby
pattern already tolerates loss (SPEC.md:1235). knative serving uses
`minAvailable: 80%` on autoscaled components (`config/core/deployments/activator-hpa.yaml:53`);
krun's fixed `1` matches its fixed small replica counts.

## `config` env (SPEC.md:1240, references/values.md)

Render one `- name: KRUN_<SNAKE>` / `value: {{ . | quote }}` pair per
`config.*` key on every krun container (gateway, scheduler, both
embedded containers, the migrate hook). Always `quote`: Helm turns
`86400` into an int and the env API needs a string. Secret-backed env
uses `valueFrom.secretKeyRef`, never a value:

| Env | secretKeyRef | Containers |
|---|---|---|
| `KRUN_DB_DSN` | `{{ .Values.db.postgres.existingSecret }}` key `dsn` | gateway, scheduler, migrate hook (postgres mode) |
| `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | `objectStorage.existingSecret` keys `accessKey`, `secretKey` | gateway and scheduler when `objectStorage.enabled` |
| `KRUN_WEBHOOK_SECRET` | `webhooks.existingSecret` key `secret` | scheduler (both modes) when `webhooks.allowedHosts` non-empty |
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | `envFrom.secretRef` `db.embedded.litestream.existingSecret` | Litestream restore init and sidecar |

The API keys are a volume, not env: `secret.secretName: {{ .Values.apiKeys.existingSecret }}`
mounted `readOnly: true` at `/etc/krun` with no `subPath`, so the kubelet
symlink swap on Secret update is visible to the 30 s poll
(SPEC.md:954-956, D12). `krun migrate` reads only `KRUN_DB_*`
(SPEC.md:1346-1347), so the hook needs `KRUN_DB_MODE` and `KRUN_DB_DSN`
(plus the rest of `config` for uniformity; harmless).

## Postgres mode (SPEC.md:1339-1347)

Two Deployments (`<fullname>-gateway`, `<fullname>-scheduler`), two
ServiceAccounts with their RoleBindings, and the hook pair:

```yaml
# templates/migrate-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: krun-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
automountServiceAccountToken: false
---
# templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "krun.fullname" . }}-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 240
  template:
    metadata: { labels: ...name/instance/component: migrate }   # no krun.io/gateway
    spec:
      serviceAccountName: krun-migrate
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext: ...pod partial
      containers:
        - name: migrate
          image: ...
          args: [migrate]          # bin/krun.js dispatch (PLAN.md:79)
          env: KRUN_DB_MODE, KRUN_DB_DSN (secretKeyRef) + config env
          securityContext: ...container partial
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes: [{ name: tmp, emptyDir: {} }]
```

Why each piece: the SA is a hook resource because hook resources are
created before the release's regular resources, so a plain SA would not
exist when the Job runs (SPEC.md:1343-1345); weight `-5` before `0`
orders SA before Job. `before-hook-creation` removes the previous run's
Job before the new one (a Job's template is immutable, so re-applying
would fail); `hook-succeeded` leaves a FAILED Job in place for
`kubectl logs` (SPEC.md:1340-1342). No Role: `krun migrate` talks only
to Postgres (SPEC.md:1345-1347). `backoffLimit: 1` gives one retry on a
transient DSN error; `activeDeadlineSeconds: 240` bounds a hung
migration below Helm's default 5-minute `--timeout`
(SPEC.md:1342). The hook has no probes (a Job pod) but keeps every other
part of the contract.

Because the DSN comes from `existingSecret`, the hook can read it at
`pre-install` time; a chart-rendered Secret would not exist yet
(SPEC.md:1309-1310), which is why the chart renders no Secret.

`dapr` does not use Helm hooks (it ships CRDs under `crds/` and a
long-running operator); the hook pattern here follows the Helm docs and
the `helm-chart-scaffolding` reference `chart-structure.md:438-451`, with
krun's weights and bounds from SPEC.

## Embedded mode (SPEC.md:1349-1364)

One StatefulSet `<fullname>`, `replicas: 1`, `serviceName` = a headless
Service (`clusterIP: None`, no `ports`, selector name+instance,
SPEC.md:1355-1356), pod runs as the scheduler SA, no gateway SA or
RoleBinding rendered (SPEC.md:1352-1355). The pod template also carries
`krun.io/gateway: "true"` (SPEC.md:991-992).

```yaml
spec:
  serviceAccountName: {{ include "krun.fullname" . }}-scheduler
  securityContext: { ...pod partial, fsGroup: 65532, fsGroupChangePolicy: OnRootMismatch }
  initContainers:
    {{- if .Values.db.embedded.litestream.enabled }}
    - name: litestream-restore
      image: {{ .Values.db.embedded.litestream.image }}
      command: [/bin/sh, -c]
      args:
        - |
          set -eu
          if [ ! -f /data/krun.db ]; then rm -f /data/krun.db-wal /data/krun.db-shm; fi
          litestream restore -if-replica-exists -if-db-not-exists -o /data/krun.db {{ .Values.db.embedded.litestream.url }}
      envFrom: [{ secretRef: { name: {{ .Values.db.embedded.litestream.existingSecret }} } }]
      volumeMounts: [{ name: data, mountPath: /data }, { name: tmp, mountPath: /tmp }]
      securityContext: ...container partial
    {{- end }}
    - name: migrate
      image: krun
      args: [migrate]
      env: KRUN_DB_MODE=embedded (+ config env)
      volumeMounts: [{ name: data, mountPath: /data }, { name: tmp, mountPath: /tmp }]
  containers:
    - name: gateway      # ports http 8080, internal 8081, admin 9090; probes on admin
    - name: scheduler    # KRUN_ADMIN_LISTEN_ADDR=:9091; port admin-sched 9091; probes on admin-sched
    {{- if .Values.db.embedded.litestream.enabled }}
    - name: litestream   # litestream replicate /data/krun.db <url>; envFrom the same Secret
    {{- end }}
  volumes: [{ name: tmp, emptyDir: {} }]
volumeClaimTemplates:
  - metadata: { name: data }
    spec:
      accessModes: [ReadWriteOnce]
      {{- with .Values.db.embedded.storageClass }}
      storageClassName: {{ . }}
      {{- end }}
      resources: { requests: { storage: {{ .Values.db.embedded.storage }} } }
```

Order matters: restore before migrate, because `krun migrate` on an empty
`/data` would create a fresh database and `-if-db-not-exists` would then
skip the restore (SPEC.md:1358-1361). Orphan `-wal`/`-shm` removal first:
a stale WAL next to a restored database corrupts it (docs/OPERATIONS.md:99-105
is the drill that exercises this). The Litestream image must contain
`/bin/sh` for the two-step script; if the chosen image is distroless,
split into two init containers (`rm` needs a shell; `litestream` does
not). This is an implementation detail inside the SPEC's "removes orphan
files then restores" step, not a new option.

`storageClassName` uses `with`, never `{{ .Values...storageClass | quote }}`:
an empty string pins the PVC to "no class" and disables dynamic
provisioning (SPEC.md:1264, 1351-1352; dapr guards the same way in
`charts/dapr/charts/dapr_scheduler/templates/dapr_scheduler_statefulset.yaml:27-29`).
`fsGroup: 65532` with `OnRootMismatch` makes the PVC writable by the
nonroot user without a recursive chown on every start (SPEC.md:1350-1351).
SQLite WAL mode supports the two processes on one local volume; network
filesystems are unsupported, so the README must say so (SPEC.md:1362-1364).

`updateStrategy` is the StatefulSet default `RollingUpdate`; with one
replica an upgrade is a brief downtime (SPEC.md:1364, docs/OPERATIONS.md:33-34).
Keep that downtime, and any scheduler outage, below
`config.ttlAfterFinished` (SPEC.md:1416-1417).

## Services (SPEC.md:1370-1371)

| Service | Type | Selector | Port | Target |
|---|---|---|---|---|
| `<fullname>-gateway` (public) | ClusterIP | `krun.io/gateway: "true"` + name/instance | 8080 | 8080 |
| `krun-gateway-internal` | ClusterIP | same | 8081 | 8081 |
| `<fullname>` headless (embedded only) | `clusterIP: None`, no ports | name/instance | | |

The internal Service name is fixed by SPEC: `KRUN_GATEWAY_INTERNAL_URL`
is `http://krun-gateway-internal.<ns>.svc:8081` and the chart sets it
from the rendered name and port (SPEC.md:1195). No Service exposes 9090
or 9091 (SPEC.md:1371); the PodMonitor scrapes pods directly.
