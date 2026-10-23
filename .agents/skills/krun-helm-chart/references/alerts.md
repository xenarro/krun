# PodMonitor and PrometheusRule (SPEC.md:1374-1375, 1391-1403)

Both render only under `metrics.*.enabled` (default false) because they
need the Prometheus Operator CRDs (`monitoring.coreos.com/v1`); `helm
lint` and `helm template` must pass with them off and on. Rule names,
expressions, `for` and severity are fixed by SPEC; `thresholds.*` are
the only variables. P9.6 verifies by script that every name in the
docs/OPERATIONS.md table exists in the rendered PrometheusRule
(PLAN.md:873-877), so the seven names below are a contract across SPEC,
chart and docs.

## PodMonitor (SPEC.md:1374-1375, 990-994)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: {{ include "krun.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels: {{ include "krun.labels" . | nindent 4 }}{{ with .Values.metrics.podMonitor.labels }}{{ toYaml . | nindent 4 }}{{ end }}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: krun
      app.kubernetes.io/instance: {{ .Release.Name }}
  podMetricsEndpoints:
    - port: admin
      path: /metrics
    {{- if eq .Values.db.mode "embedded" }}
    - port: admin-sched
      path: /metrics
    {{- end }}
```

One endpoint per admin port NAME (SPEC.md:1374-1375): `admin` on every
krun container, `admin-sched` on the embedded scheduler container
(SPEC.md:1356-1358). In postgres mode both Deployments expose `admin`
on 9090, so a single endpoint scrapes every pod. `metrics.podMonitor.labels`
exist so the operator's `podMonitorSelector` (often `release: <prom>`)
can match; merge, do not replace, the standard labels.

The admin-port NetworkPolicy must admit the Prometheus namespace through
`networkPolicy.metricsFrom` or scrapes fail silently (SPEC.md:1054-1056,
references/networkpolicies.md).

## PrometheusRule (SPEC.md:1391-1401)

Let `$t := .Values.metrics.prometheusRule.thresholds`.

| Rule | Expression (rendered) | `for` | severity | OPERATIONS first checks (docs/OPERATIONS.md:71-77) |
|---|---|---|---|---|
| `KrunNoLeader` | `max(krun_scheduler_leader) == 0 or absent(krun_scheduler_leader)` | `2m` | `critical` | `kubectl get lease krun-scheduler -n krun -o jsonpath='{.spec.holderIdentity}'`; scheduler pod logs; API server reachability; a leader that cannot renew exits and restarts |
| `KrunFunctionsNotSynced` | `min(krun_functions_synced) == 0` | `2m` | `critical` | CRD present and Established; RBAC for `functions.krun.io`; API server |
| `KrunJobLost` | `sum(increase(krun_runs_failed_total{reason="job_lost"}[1h])) > {{ $t.jobLostPerHour }}` | `0m` | `warning` | scheduler downtime vs `config.ttlAfterFinished`; someone deleting Jobs in the jobs namespace; node loss |
| `KrunHeartbeatTimeouts` | `sum(increase(krun_runs_failed_total{reason="heartbeat_timeout"}[1h])) > {{ $t.heartbeatTimeoutsPerHour }}` | `0m` | `warning` | the run's `error` and `logTail` via `GetRun`; whether `heartbeatTimeout` is shorter than the work it protects |
| `KrunDeliveriesDead` | `increase(krun_deliveries_total{state="dead"}[1h]) > 0` | `0m` | `warning` | receiver availability; `webhooks.allowedHosts` and `allowedCIDRs`; DNS; signature verification on the receiver |
| `KrunQuotaRejections` | `sum(rate(krun_quota_rejections_total[5m])) * 60 > {{ $t.quotaRejectionsPerMinute }}` | `10m` | `warning` | `kubectl describe quota -n krun-jobs`; function requests vs `limitRange.max` |
| `KrunQueueWaitHigh` | `histogram_quantile(0.95, sum(rate(krun_queue_wait_seconds_bucket[10m])) by (le)) > {{ $t.queueWaitP95Seconds }}` | `10m` | `warning` | free slots per function (`krun_runs_current`); `config.maxRunning`; cluster capacity; cold start |

Default thresholds (SPEC.md:1300): `queueWaitP95Seconds: 60`,
`jobLostPerHour: 1`, `heartbeatTimeoutsPerHour: 5`,
`quotaRejectionsPerMinute: 1`. Metric names come from SPEC.md:1129-1147
(`krun_runs_failed_total{function,reason}`, `krun_deliveries_total{state}`,
`krun_quota_rejections_total{function}`, `krun_queue_wait_seconds{function}`,
`krun_scheduler_leader`, `krun_functions_synced`); the `sum(...)` wrappers
collapse the per-function labels. `KrunDeliveriesDead` has no `sum` in
SPEC; keep it as written (one series per scheduler pod, only the leader
increments it).

Template skeleton:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ include "krun.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels: {{ include "krun.labels" . | nindent 4 }}{{ with .Values.metrics.prometheusRule.labels }}{{ toYaml . | nindent 4 }}{{ end }}
spec:
  groups:
    - name: krun
      rules:
        - alert: KrunNoLeader
          expr: max(krun_scheduler_leader) == 0 or absent(krun_scheduler_leader)
          for: 2m
          labels: { severity: critical }
          annotations:
            summary: no krun scheduler holds the Lease
            runbook: docs/OPERATIONS.md "Alerts and first checks"
        # ... six more in table order
```

Quote `{{ $t.x }}` nowhere: PromQL wants a bare number. Use `for: 0m`
literally rather than omitting `for` so the rendered rule matches the
table a reader compares against. Annotations are free text; keep them
one line and point at docs/OPERATIONS.md by section name (the P9.6
script checks names only, PLAN.md:873-874).

## Checks

```sh
C=deploy/helm/krun; base="--set apiKeys.existingSecret=k --set db.postgres.existingSecret=p"
helm template t $C $base --set metrics.prometheusRule.enabled=true --set metrics.podMonitor.enabled=true \
  --show-only templates/prometheusrule.yaml > "$TMPDIR/rule.yaml"
# promtool wants a plain rules file ({groups: [...]}), not the CR: strip to .spec with the workspace's yaml package
node -e 'const y=require("yaml");const fs=require("fs");const d=y.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],y.stringify(d.spec))' "$TMPDIR/rule.yaml" "$TMPDIR/rules-only.yaml"
promtool check rules "$TMPDIR/rules-only.yaml"
test "$(grep -c 'alert: Krun' "$TMPDIR/rule.yaml")" = 7
diff <(grep -o 'alert: Krun[A-Za-z]*' "$TMPDIR/rule.yaml" | cut -d' ' -f2 | sort -u) \
     <(grep -o '`Krun[A-Za-z]*`' docs/OPERATIONS.md | tr -d '`' | sort -u)
```

`promtool check rules` takes a plain rules file (`groups:` at the top),
not a `PrometheusRule` CR (PLAN.md:755). `yq` is not in PLAN.md section
2, so the strip uses the `yaml` package the workspace already depends on
(PLAN.md:65). The last command is the P9.6 name check (PLAN.md:873-874).
