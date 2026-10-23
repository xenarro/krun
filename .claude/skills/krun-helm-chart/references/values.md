# Chart values (SPEC.md section 13)

Values shape verbatim from SPEC.md:1228-1306, then the meaning of every
key and the env variable or resource it drives. Keep `values.yaml` in
this shape: the P7.5 README is generated from it by `helm-docs`
(PLAN.md:753-757), and `config.*` must stay one camelCase key per
section 12 tunable (SPEC.md:1240).

## values.yaml (verbatim, SPEC.md:1228-1306)

```yaml
image: { repository: ghcr.io/xenarro/krun, tag: "" }   # tag defaults to appVersion

gateway:
  replicas: 2
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 512Mi } }
scheduler:
  replicas: 1          # extra replicas are standby
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 512Mi } }
priorityClassName: ""
terminationGracePeriodSeconds: 30

config:                 # one camelCase key per section 12 tunable, rendered as env on both processes
  maxRunning: 100
  maxQueued: 1000
  maxInputBytes: 262144
  maxResultBytes: 262144
  maxWait: 60s
  shutdownDelay: 5s
  rateLimitRps: 10
  rateLimitBurst: 50
  maxActiveDeadline: 86400
  allowedServiceAccounts: krun-job-default
  k8sConcurrency: 8
  ttlAfterFinished: 86400
  retention: 720h
  allowedRegistries: ""
  s3PresignTtl: ""      # empty means unset: the run's activeDeadlineSeconds
  logLevel: info

db:
  mode: postgres        # postgres | embedded
  postgres:
    existingSecret: ""  # key: dsn; required in postgres mode, chart fails when empty
  embedded:
    storage: 1Gi
    storageClass: ""    # empty omits storageClassName (an empty string would disable dynamic provisioning)
    litestream:
      enabled: false
      image: ""         # pinned by digest; required when enabled
      url: s3://bucket/krun
      existingSecret: ""   # keys: LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY; required when enabled

crds:
  install: true         # CRD templated into the release
  keep: true            # helm.sh/resource-policy: keep on the CRD
apiKeys:
  existingSecret: ""    # key: keys.yaml; required

jobsNamespace:
  name: krun-jobs
  create: true
  keep: true            # helm.sh/resource-policy: keep on the Namespace
  podSecurityVersion: v1.29
  quota: { pods: "200", requests.cpu: "50", requests.memory: 100Gi, requests.ephemeral-storage: 100Gi }
  limitRange:
    defaultRequest: { cpu: 100m, memory: 128Mi, ephemeral-storage: 256Mi }
    default:        { cpu: "1",  memory: 1Gi,   ephemeral-storage: 2Gi }
    max:            { cpu: "4",  memory: 8Gi,   ephemeral-storage: 20Gi }
  dnsEgress:            # NetworkPolicyPeer list for UDP and TCP 53
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
      podSelector: { matchLabels: { k8s-app: kube-dns } }
  egressCIDRs: []       # ipBlock objects { cidr, except: [] }, extra egress for all functions

networkPolicy:
  metricsFrom: {}       # namespaceSelector allowed to scrape the admin ports; empty allows all

metrics:
  podMonitor: { enabled: false, labels: {} }
  prometheusRule:
    enabled: false
    labels: {}
    thresholds: { queueWaitP95Seconds: 60, jobLostPerHour: 1, heartbeatTimeoutsPerHour: 5, quotaRejectionsPerMinute: 1 }

objectStorage: { enabled: false, endpoint: "", bucket: "", region: "", existingSecret: "", egress: [] }
  # existingSecret keys: accessKey, secretKey; endpoint, bucket and existingSecret required when enabled
webhooks: { allowedHosts: [], allowedCIDRs: [], existingSecret: "" }
  # existingSecret key: secret (comma-separated); required when allowedHosts is set
```

The two trailing `#` comment lines sit under their map in SPEC prose; in
`values.yaml` put them above the key so `helm-docs` attaches them.

## Per-key meaning

| Key | Drives | Notes / citation |
|---|---|---|
| `image.repository`, `image.tag` | every krun container image `repo:tag` | empty tag falls back to `.Chart.AppVersion` (SPEC.md:1229); one SemVer per tag stamps `version` and `appVersion` (SPEC.md:1413-1415) |
| `gateway.replicas` | gateway Deployment replicas; PDB rendered when `> 1` | embedded mode `fail` when `> 1` (SPEC.md:1314-1315) |
| `gateway.resources` | gateway container resources | no CPU limit by default (SPEC.md:1331, 1233) |
| `scheduler.replicas` | scheduler Deployment replicas; extras are standby | embedded mode `fail` when `> 1` (SPEC.md:1235, 1314-1315) |
| `scheduler.resources` | scheduler container resources | SPEC.md:1236 |
| `priorityClassName` | `spec.priorityClassName` on every chart pod when non-empty | SPEC.md:1237, 1332 |
| `terminationGracePeriodSeconds` | every chart pod | default 30; both shutdown sequences fit it (SPEC.md:1238, 1174) |
| `config.maxRunning` | `KRUN_MAX_RUNNING` | `fail` when above `jobsNamespace.quota.pods` while `create` (SPEC.md:1313-1314, 1108) |
| `config.maxQueued` | `KRUN_MAX_QUEUED` | SPEC.md:1199 |
| `config.maxInputBytes` | `KRUN_MAX_INPUT_BYTES` | process rejects above 1048576 (SPEC.md:1182) |
| `config.maxResultBytes` | `KRUN_MAX_RESULT_BYTES` | SPEC.md:1201 |
| `config.maxWait` | `KRUN_MAX_WAIT` | duration grammar (SPEC.md:1183) |
| `config.shutdownDelay` | `KRUN_SHUTDOWN_DELAY` | gateway drain before close (SPEC.md:1166-1170) |
| `config.rateLimitRps`, `config.rateLimitBurst` | `KRUN_RATE_LIMIT_RPS`, `KRUN_RATE_LIMIT_BURST` | SPEC.md:1204-1205 |
| `config.maxActiveDeadline` | `KRUN_MAX_ACTIVE_DEADLINE` | SPEC.md:1206 |
| `config.allowedServiceAccounts` | `KRUN_ALLOWED_SERVICE_ACCOUNTS` | comma-separated; default is the chart's `krun-job-default` SA (SPEC.md:1207, 1032) |
| `config.k8sConcurrency` | `KRUN_K8S_CONCURRENCY` | SPEC.md:1208 |
| `config.ttlAfterFinished` | `KRUN_TTL_AFTER_FINISHED` | scheduler downtime must stay below it (SPEC.md:1416-1417) |
| `config.retention` | `KRUN_RETENTION` | SPEC.md:1210 |
| `config.allowedRegistries` | `KRUN_ALLOWED_REGISTRIES` | empty = any (SPEC.md:1211) |
| `config.s3PresignTtl` | `KRUN_S3_PRESIGN_TTL` | render the env with an empty value when empty: empty is unset (SPEC.md:1184, 1213) |
| `config.logLevel` | `KRUN_LOG_LEVEL` | the P7.6 upgrade scenario flips it to `debug` (PLAN.md:765) |
| `db.mode` | `KRUN_DB_MODE`; selects Deployments+hook (postgres) or StatefulSet (embedded) | SPEC.md:1188, 1339, 1349 |
| `db.postgres.existingSecret` | `KRUN_DB_DSN` via `secretKeyRef` key `dsn` on gateway, scheduler and the migrate hook | `fail` when empty in postgres mode (SPEC.md:1308-1310) |
| `db.embedded.storage` | `volumeClaimTemplates[0].spec.resources.requests.storage` | SPEC.md:1263 |
| `db.embedded.storageClass` | `storageClassName` only when non-empty | an empty string disables dynamic provisioning (SPEC.md:1264, 1351-1352) |
| `db.embedded.litestream.enabled` | restore init container and replicate sidecar | SPEC.md:1358-1362 |
| `db.embedded.litestream.image` | both Litestream containers | digest-pinned; `fail` when empty while enabled (SPEC.md:1267, 1312-1313) |
| `db.embedded.litestream.url` | replica URL for restore and replicate | SPEC.md:1268 |
| `db.embedded.litestream.existingSecret` | `envFrom.secretRef` on both Litestream containers | keys `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`; `fail` when empty while enabled (SPEC.md:1269, 1312-1313) |
| `crds.install` | wraps `templates/crd-functions.yaml` | generated by `scripts/gen-crd.ts`, never hand-edited (SPEC.md:120-128, PLAN.md:200-204) |
| `crds.keep` | `helm.sh/resource-policy: keep` on the CRD | SPEC.md:1366-1368 |
| `apiKeys.existingSecret` | Secret volume mounted at `/etc/krun` on the gateway container, no `subPath` | key `keys.yaml`; `fail` when empty (SPEC.md:954-956, 1308-1309) |
| `jobsNamespace.name` | `KRUN_JOBS_NAMESPACE`; `metadata.namespace` of every jobs-namespace resource | SPEC.md:1196, 998-999 |
| `jobsNamespace.create` | gates Namespace, NetworkPolicies, LimitRange, ResourceQuota and the quota `fail` | SPEC.md:999-1008 |
| `jobsNamespace.keep` | `helm.sh/resource-policy: keep` on the Namespace | SPEC.md:1001-1003, D32 SPEC.md:1473 |
| `jobsNamespace.podSecurityVersion` | the three `pod-security.kubernetes.io/*-version` labels | SPEC.md:1010-1012 |
| `jobsNamespace.quota` | ResourceQuota `spec.hard` | dotted keys: read with `index` (see Pitfalls in SKILL.md); SPEC.md:1029-1030 |
| `jobsNamespace.limitRange` | LimitRange `type: Container` `defaultRequest`, `default`, `max` | SPEC.md:1027-1029 |
| `jobsNamespace.dnsEgress` | `to:` peers of the DNS egress rule, rendered verbatim with `toYaml` | NodeLocal DNSCache appends an `ipBlock` (SPEC.md:1013-1016, docs/OPERATIONS.md:127-129) |
| `jobsNamespace.egressCIDRs` | one `- ipBlock:` peer per entry, `cidr` plus optional `except` | NOTES.txt warning (SPEC.md:1021-1025) |
| `networkPolicy.metricsFrom` | `from[0].namespaceSelector` on the admin-port ingress policy; empty omits `from` | SPEC.md:1054-1056 |
| `metrics.podMonitor.enabled`, `.labels` | PodMonitor, one endpoint per admin port name, labels merged into `metadata.labels` | SPEC.md:1374-1375 |
| `metrics.prometheusRule.enabled`, `.labels`, `.thresholds` | PrometheusRule with the seven rules; thresholds substituted into four expressions | SPEC.md:1391-1401, references/alerts.md |
| `objectStorage.enabled` | renders `KRUN_S3_*` env and NetworkPolicy rule 3 | SPEC.md:1018-1021, 1212 |
| `objectStorage.endpoint`, `.bucket`, `.region` | `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION` | endpoint also yields the egress port (default 443 or 80) (SPEC.md:1020-1021) |
| `objectStorage.existingSecret` | `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` via `secretKeyRef` keys `accessKey`, `secretKey` | `fail` when empty while enabled (SPEC.md:1303, 1311-1312) |
| `objectStorage.egress` | `to:` peers of NetworkPolicy rule 3, verbatim | ipBlock, or namespaceSelector+podSelector for in-cluster MinIO (SPEC.md:1019-1020) |
| `webhooks.allowedHosts` | `KRUN_WEBHOOK_ALLOWED_HOSTS`, comma-joined | empty disables webhooks (SPEC.md:1214) |
| `webhooks.allowedCIDRs` | `KRUN_WEBHOOK_ALLOWED_CIDRS`, comma-joined | SPEC.md:1215 |
| `webhooks.existingSecret` | `KRUN_WEBHOOK_SECRET` via `secretKeyRef` key `secret` on the scheduler | `fail` when `allowedHosts` set and this empty (SPEC.md:1310-1311) |

## Env the chart sets without a value

| Env | Value | Why |
|---|---|---|
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<release ns>.svc:8081` built from the rendered Service name and port | the chart always sets it; the process default only serves non-chart deployments (SPEC.md:1195) |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9091` on the embedded scheduler container only | two containers share one pod network namespace (SPEC.md:1194, 1356-1357) |
| `KRUN_DB_PATH` | leave unset (`/data/krun.db`) and mount the PVC at `/data` | SPEC.md:1190 |
| `KRUN_NAMESPACE` | leave unset | read from the ServiceAccount `namespace` file; gateway and scheduler automount their SA token (SPEC.md:1197, 1324) |
| `KRUN_API_KEYS_PATH` | leave unset (`/etc/krun/keys.yaml`); mount the Secret at `/etc/krun` | SPEC.md:1191, 954-956 |

Render every `config.*` key on both processes (SPEC.md:1240) even where
section 12 says one process reads it; the process ignores what it does
not use and the P7.2/P7.3 acceptance asserts "every `config` key as env"
(PLAN.md:704, 720-721).
