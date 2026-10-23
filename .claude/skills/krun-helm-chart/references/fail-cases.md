# Chart `fail` cases and the NOTES.txt warning

Every case comes from SPEC.md:1308-1317 (plus the embedded replica rule
SPEC.md:1314-1315 and the quota rule SPEC.md:1108). Each `fail` needs a
message that names the value and what to set (PLAN.md:672-673 "fails with
a clear message"). Implement them in one helper
(`templates/_validate.tpl`, called once from a template that always
renders, for example the gateway or StatefulSet template) so no mode or
flag skips a check. Use `fail`, not `required`: `required` only tests
emptiness and cannot express the cross-key conditions.

Do not add a case the SPEC does not list (PLAN.md:31-32): no digest
check on `litestream.image`, no consistency check between
`config.shutdownDelay` and `terminationGracePeriodSeconds` (see SPEC
RISK in SKILL.md).

## Fail table

| # | Condition (Go template, `$v := .Values`) | Suggested message | SPEC | PLAN test |
|---|---|---|---|---|
| F1 | `empty $v.apiKeys.existingSecret` | `apiKeys.existingSecret is required: the name of a Secret with key keys.yaml` | SPEC.md:1308-1309, 954-956 | P7.1 (PLAN.md:672-673) |
| F2 | `and (eq $v.db.mode "postgres") (empty $v.db.postgres.existingSecret)` | `db.postgres.existingSecret is required in postgres mode (key dsn); the pre-install hook needs it before any release Secret exists` | SPEC.md:1309-1310 | P7.2 (PLAN.md:685) |
| F3 | `and $v.webhooks.allowedHosts (empty $v.webhooks.existingSecret)` | `webhooks.existingSecret is required when webhooks.allowedHosts is set (key secret)` | SPEC.md:1310-1311 | P7.4a (PLAN.md:709-710) |
| F4 | `and $v.objectStorage.enabled (or (empty $v.objectStorage.endpoint) (empty $v.objectStorage.bucket) (empty $v.objectStorage.existingSecret))` | `objectStorage.endpoint, objectStorage.bucket and objectStorage.existingSecret are required when objectStorage.enabled is true` | SPEC.md:1311-1312 | P7.4a (PLAN.md:710-711) |
| F5 | `and (eq $v.db.mode "embedded") $v.db.embedded.litestream.enabled (or (empty $v.db.embedded.litestream.image) (empty $v.db.embedded.litestream.existingSecret))` | `db.embedded.litestream.image and db.embedded.litestream.existingSecret are required when litestream is enabled` | SPEC.md:1312-1313 | P7.3 (PLAN.md:697-698) |
| F6 | `and $v.jobsNamespace.create (gt (int $v.config.maxRunning) (atoi (toString (index $v.jobsNamespace.quota "pods"))))` | `config.maxRunning (N) exceeds jobsNamespace.quota.pods (M); raise the quota or lower maxRunning` | SPEC.md:1313-1314, 1108, 1007-1008 | P7.4a (PLAN.md:708-709); `create=false --set config.maxRunning=300` must render (PLAN.md:722-723) |
| F7 | `and (eq $v.db.mode "embedded") (or (gt (int $v.gateway.replicas) 1) (gt (int $v.scheduler.replicas) 1))` | `embedded mode runs one replica; set gateway.replicas and scheduler.replicas to 1 or use db.mode=postgres` | SPEC.md:1314-1315, 1349 | P7.3 (PLAN.md:696-697) |

Also reject an unknown `db.mode` (`not (has $v.db.mode (list "postgres" "embedded"))`)
with `db.mode must be postgres or embedded`; otherwise neither workload
renders and `helm install` succeeds with nothing running. This is an
input-validation message, not a new option.

Type notes for F6 and F7: `--set` produces int64, `values.yaml` may hold
int or string (`quota.pods: "200"` is a string by SPEC); normalise with
`int` and `atoi (toString ...)` before `gt`. `quota` keys contain dots,
so only `index` reaches them.

## NOTES.txt warning (SPEC.md:1021-1025, 1316-1317)

```
{{- range .Values.jobsNamespace.egressCIDRs }}
{{- if and (or (eq .cidr "0.0.0.0/0") (eq .cidr "::/0")) (not .except) }}
WARNING: jobsNamespace.egressCIDRs contains {{ .cidr }} without `except`.
Every function pod can reach every address, including cloud metadata
endpoints and the node network. Add except: [10.0.0.0/8, 172.16.0.0/12,
192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16] plus the node and Service
CIDRs (docs/OPERATIONS.md, "Internet egress for functions").
{{- end }}
{{- end }}
```

The recipe text is docs/OPERATIONS.md:122-126; D32 (SPEC.md:1473)
explains why a bare `0.0.0.0/0` is a problem. A warning, not a `fail`:
the owner chose to allow it (SPEC.md:1316-1317). Tested by P7.4c
(PLAN.md:729-730): `helm template --set 'jobsNamespace.egressCIDRs[0].cidr=0.0.0.0/0'`
must print the warning in NOTES; the same with an `except` entry must
not.

## Acceptance checks per case

Run each as a shell assertion in the chart test script (P7.1-P7.4a
acceptance, PLAN.md:669-673, 681-685, 696-702, 711-714):

```sh
C=deploy/helm/krun
base="--set apiKeys.existingSecret=keys --set db.postgres.existingSecret=pg"
helm template t $C --set db.postgres.existingSecret=pg 2>&1 | grep -q 'apiKeys.existingSecret is required'          # F1
helm template t $C --set apiKeys.existingSecret=keys 2>&1 | grep -q 'db.postgres.existingSecret is required'       # F2
helm template t $C $base --set 'webhooks.allowedHosts[0]=hooks.example' 2>&1 | grep -q 'webhooks.existingSecret'   # F3
helm template t $C $base --set objectStorage.enabled=true 2>&1 | grep -q 'objectStorage.endpoint'                  # F4
helm template t $C --set apiKeys.existingSecret=keys --set db.mode=embedded \
  --set gateway.replicas=1 --set db.embedded.litestream.enabled=true 2>&1 | grep -q 'litestream.image'             # F5
helm template t $C $base --set config.maxRunning=300 2>&1 | grep -q 'exceeds jobsNamespace.quota.pods'             # F6
helm template t $C $base --set config.maxRunning=300 --set jobsNamespace.create=false >/dev/null                   # F6 skipped
helm template t $C --set apiKeys.existingSecret=keys --set db.mode=embedded 2>&1 | grep -q 'one replica'           # F7 (gateway.replicas defaults to 2)
```

F7 note: the default `gateway.replicas: 2` makes a bare
`--set db.mode=embedded` fail; the e2e embedded install must pass
`gateway.replicas=1` (PLAN.md:738-740). Say so in the README (P7.5).
