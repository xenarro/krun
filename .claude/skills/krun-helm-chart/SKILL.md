---
name: krun-helm-chart
description: Use when editing the krun Helm chart or NetworkPolicy. Renders both db modes, hooks, PSA-restricted pods, RBAC, alerts, fail cases.
---

# krun Helm chart

Covers `deploy/helm/krun`: SPEC.md section 13 (values, postgres and
embedded rendering, hook Job, CRD templating with keep, pod template
contract, PDB, rolling update, alerts) and section 9 (jobs namespace
resources, RBAC, NetworkPolicies, PSA). Serves PLAN tasks P0.2 (chart
stub), P7.1-P7.7 and the P9.6 alert-name check.

## When to use

- Any file under `deploy/helm/krun/` (templates, values, NOTES.txt,
  README via `helm-docs`), `deploy/crds/`, or the chart tests.
- A NetworkPolicy, LimitRange, ResourceQuota, Role or PSA label question.
- The PodMonitor or PrometheusRule, or docs/OPERATIONS.md alert names.
- Not for the Job manifest the scheduler creates per run: that is
  `krun-scheduler-k8s` (../krun-scheduler-k8s/references/job-manifest.md). Not for the CRD
  schema itself: `krun-functions-crd` owns `scripts/gen-crd.ts`.

## Read first

- SPEC.md:1223-1417 (section 13, all of it), SPEC.md:934-1058 (section 9),
  SPEC.md:1176-1222 (section 12 env names), SPEC.md:1125-1175 (metrics,
  health, shutdown), SPEC.md:118-128 (CRD generation into the chart).
- Decisions D22 (SPEC.md:1463), D30 (SPEC.md:1471), D32 (SPEC.md:1473).
- PLAN.md:140-146 (P0.2 stub), PLAN.md:178-191 (P0.8 generated CRD
  template), PLAN.md:652-756 (Phase 7), PLAN.md:873-877 (P9.6).
- docs/OPERATIONS.md:7-41 (install, keep, upgrade), 43-63 (capacity),
  65-77 (alerts), 94-107 (Litestream drill), 109-135 (security ops).
- References here: [values.md](references/values.md) (values verbatim,
  per-key meaning, env mapping), [fail-cases.md](references/fail-cases.md)
  (seven `fail` cases, NOTES.txt warning, shell checks),
  [networkpolicies.md](references/networkpolicies.md) (peer tables for
  both namespaces, PSA labels, LimitRange/Quota, RBAC verbs),
  [alerts.md](references/alerts.md) (PodMonitor, seven rules with
  OPERATIONS first checks, promtool procedure),
  [pod-template.md](references/pod-template.md) (securityContext, labels,
  probes, resources, PDB, spread, rolling update, hook Job, StatefulSet).

## Rules

1. The chart renders no `Secret`, no ConfigMap and no Function; every secret
   is an `existingSecret` name because the pre-install hook runs before any
   release Secret exists and function instances belong to their owners
   (SPEC.md:1308-1316, 1377-1379, D22).
2. Template the CRD from the generated `templates/crd-functions.yaml` under
   `crds.install`, with `helm.sh/resource-policy: keep` under `crds.keep`;
   never put it in `crds/`, which Helm never upgrades (SPEC.md:1366-1370,
   PLAN.md:180-184).
3. Never edit `templates/crd-functions.yaml` by hand; `scripts/gen-crd.ts`
   writes it and CI fails on a diff (SPEC.md:120-128).
4. Every `fail` case in references/fail-cases.md renders a message naming the
   value; use `fail`, not `required`, and validate once from a template that
   always renders (SPEC.md:1308-1315, PLAN.md:672-673).
5. Embedded mode `fail`s when `gateway.replicas` or `scheduler.replicas`
   exceeds 1: one StatefulSet replica owns the SQLite file (SPEC.md:1314-1315,
   1349).
6. Every pod template carries `app.kubernetes.io/name: krun` and
   `app.kubernetes.io/instance`; only the gateway Deployment and the embedded
   StatefulSet carry `krun.io/gateway: "true"`, because 8080/8081 policies
   select it (SPEC.md:990-994).
7. Every container, init container and sidecar gets the PSA-restricted
   securityContext (65532, `RuntimeDefault`, drop ALL, no privilege
   escalation, RO rootfs, `/tmp` emptyDir); `automountServiceAccountToken`
   only on gateway and scheduler (SPEC.md:1319-1324).
8. Readiness `/readyz` 5/3/3, liveness `/healthz` 10/3/3, no startup probe,
   each on the container's own admin port; liveness never on `/readyz` or a
   stalled database restarts healthy pods (SPEC.md:1327-1331, 1161-1164).
9. Default resources carry no CPU limit; render `.Values.<proc>.resources` verbatim (SPEC.md:1331, 1233).
10. Gateway: PDB `minAvailable: 1` only when `replicas > 1`, hostname
   `topologySpreadConstraints` with `ScheduleAnyway`; scheduler:
   `RollingUpdate` `maxSurge: 1`, `maxUnavailable: 0` so a Ready standby
   exists before the leader gets SIGTERM (SPEC.md:1333-1337).
11. Postgres mode: hook Job weight `"0"` and SA `krun-migrate` weight `"-5"`,
   both `pre-install,pre-upgrade` and `before-hook-creation,hook-succeeded`;
   Job `restartPolicy: Never`, `backoffLimit: 1`, `activeDeadlineSeconds:
   240`; SA with no Role and no automount (SPEC.md:1339-1347).
12. Embedded mode: one StatefulSet, `fsGroup: 65532` + `OnRootMismatch`,
   headless Service with no ports, scheduler SA for the pod and no gateway
   SA/RoleBinding, scheduler container `KRUN_ADMIN_LISTEN_ADDR=:9091` port
   `admin-sched`, init order Litestream restore then `krun migrate`
   (SPEC.md:1349-1362).
13. `storageClassName` renders only when `db.embedded.storageClass` is
   non-empty; an empty string disables dynamic provisioning (SPEC.md:1264,
   1351-1352).
14. Always render into `jobsNamespace.name`: scheduler Role+RoleBinding,
   `krun-job-default`, `krun-job-viewer`; only under `jobsNamespace.create`:
   Namespace with versioned PSA labels, NetworkPolicies, LimitRange,
   ResourceQuota and the quota `fail` (SPEC.md:998-1008).
15. RBAC verbs are verbatim from SPEC.md:1034-1047; the Lease rule is two
   entries (`get, update` with `resourceNames`, `create` without);
   `krun-function-author` and `krun-job-viewer` have no binding; nothing
   cluster-wide but the CRD (SPEC.md:1041).
16. krun-namespace NetworkPolicies select the release's pods, never the
   namespace; admin ports 9090 (+9091 embedded) admit
   `networkPolicy.metricsFrom`, empty allows all; no egress policy there
   (SPEC.md:1051-1056).
17. Jobs-namespace egress is exactly rules 1-4 of SPEC.md:1013-1025;
   `egressCIDRs` are `ipBlock` objects with `except`, and NOTES.txt warns on
   `0.0.0.0/0` or `::/0` without `except` (SPEC.md:1316-1317, D32).
18. Section 9 policy and the values shape are owner decisions: a change needs
   BLOCKED, not a Decisions row from you (PLAN.md:23-26).
19. `config.*` keys map 1:1 to section 12 env on every krun container, quoted;
   `KRUN_GATEWAY_INTERNAL_URL` is always set from the rendered internal
   Service (SPEC.md:1240, 1195).
20. `keep` consequences go in the README: kept CRD/Namespace retain
   `meta.helm.sh` annotations; re-install with the same name and namespace or
   `kubectl annotate ... --overwrite`; deleting the CRD deletes every Function
   (SPEC.md:1382-1389, PLAN.md:733-737).
21. Keep scheduler downtime (upgrades, embedded restarts) below
   `config.ttlAfterFinished`, or finished runs become `job_lost`
   (SPEC.md:1416-1417, docs/OPERATIONS.md:37-38).
22. Add no value, flag or resource no task asks for: no nodeSelector,
   tolerations, HPA, ingress, extra Services (PLAN.md:31-32, SPEC.md:19-24).

## Chart layout

```
deploy/helm/krun/
  Chart.yaml                 apiVersion v2, name krun, version/appVersion 0.0.0 (P0.2); stamped on v* tags
  values.yaml                references/values.md verbatim; helm-docs comments on every key
  README.md                  generated by helm-docs in make generate (P7.5); never hand-edited
  templates/NOTES.txt        egressCIDRs warning; install hints
  templates/_helpers.tpl     names, labels, selector labels, pod/container securityContext, probes, config env
  templates/_validate.tpl    the fail cases, included once
  templates/crd-functions.yaml       GENERATED (scripts/gen-crd.ts), crds.install + keep
  templates/gateway-deployment.yaml  postgres mode
  templates/scheduler-deployment.yaml postgres mode
  templates/migrate-job.yaml, migrate-serviceaccount.yaml   postgres hooks
  templates/statefulset.yaml, headless-service.yaml         embedded mode
  templates/service-public.yaml, service-internal.yaml      krun-gateway-internal is a fixed name
  templates/pdb.yaml, serviceaccounts.yaml, rbac-krun.yaml, rbac-jobs.yaml
  templates/networkpolicy-krun.yaml, jobs-namespace.yaml, networkpolicy-jobs.yaml, limitrange.yaml, resourcequota.yaml
  templates/podmonitor.yaml, prometheusrule.yaml
```

File names are a suggestion; the rendered kinds and conditions are not.
Keep one kind per file so `helm template --show-only` targets a test.

## Mode matrix

| Resource | postgres | embedded | Gate |
|---|---|---|---|
| gateway Deployment, scheduler Deployment | yes | no | `db.mode` |
| migrate hook Job + `krun-migrate` SA | yes | no | `db.mode` |
| StatefulSet + headless Service | no | yes | `db.mode` |
| gateway SA + Role + RoleBinding | yes | no | SPEC.md:1352-1355 |
| scheduler SA, Roles, RoleBindings (both ns) | yes | yes | always |
| gateway PDB | when `gateway.replicas > 1` | never (replicas is 1) | |
| admin NetworkPolicy ports | 9090 | 9090, 9091 | `db.mode` |
| PodMonitor endpoints | `admin` | `admin`, `admin-sched` | `metrics.podMonitor.enabled` |
| CRD | `crds.install` | `crds.install` | |
| jobs Namespace, policies, LimitRange, Quota | `jobsNamespace.create` | same | |

## Testing the chart

- `make helm-lint` runs `helm lint deploy/helm/krun` with values that
  satisfy the `fail` cases (`apiKeys.existingSecret`, `db.postgres.existingSecret`);
  P0.2 only needs `Chart.yaml` and a `values.yaml` with
  `crds: {install: true, keep: true}` so the generated CRD template has
  its condition (PLAN.md:140-146, 182-184).
- Render assertions are shell or `node:test` over `helm template` output
  (PLAN.md:669-673): grep for absent `subPath`, `kind: ConfigMap`,
  `kind: Secret`, `kind: Function`; present `krun-gateway-internal`;
  `--set crds.install=false` drops the CRD; `--set crds.keep=false` drops
  the annotation; `--set jobsNamespace.keep=false` likewise.
- Each `fail` case has a one-line check in references/fail-cases.md.
- Alerts: references/alerts.md has the `promtool check rules` procedure
  (strip the CR to `.spec` first) and the P9.6 name diff.
- e2e (P7.6, PLAN.md:738-751): both modes into fresh namespaces labelled
  `pod-security.kubernetes.io/enforce=restricted`, `objectStorage.egress`
  at the MinIO pods, policy reachability checks, `scheduler.replicas=2`
  one leader, `helm upgrade --set config.logLevel=debug` then
  `helm rollback <release> 1` with a run succeeding after each. The
  harness lives in `krun-testing-ci`; this skill owns what to assert.

## Library facts

- `helm`, `helm-docs`, `promtool`, `kind` 0.24+ (kindnetd enforces
  NetworkPolicy) are toolchain, not dependencies (PLAN.md:42-44). `yq` is
  not listed; strip PrometheusRule CRs with the `yaml` package
  (PLAN.md:65) or `node -e`.
- `@fastify/under-pressure` 9.2.1 couples `/healthz` and `/readyz` into
  one `healthCheck`; the research recommends a hand-written `/readyz`
  (node-stack-facts.md:575-599, VERIFIED README, recommendation marked
  as such). Chart-side consequence: probe paths and timings come from
  SPEC, not from the plugin's `/status` default.
- Helm `--set` yields int64 for numbers while `values.yaml` keeps
  `quota.pods: "200"` a string: normalise with `int`/`atoi` before `gt`
  (references/fail-cases.md). UNVERIFIED against a specific Helm minor;
  test both input paths.

## Lessons from KEDA, dapr, knative serving

- Keep the PSA-restricted securityContext at both pod and container
  level; KEDA's operator sets `runAsNonRoot` on the pod and drop-ALL,
  no-priv-esc, RO rootfs, `RuntimeDefault` on the container
  (keda `config/manager/manager.yaml:25-26,74-82`).
- Do not copy KEDA's `initialDelaySeconds: 25` / `20` probes or its 10 s
  grace: they compensate for a `Ping` health handler and no in-flight
  work; krun's `/readyz` already waits for the informer and 30 s covers
  both drains (keda `config/manager/manager.yaml:47-56`,
  `cmd/operator/main.go:352-359`; SPEC.md:1161-1174).
- Guard `storageClassName` with `if`, as dapr's scheduler StatefulSet does
  (dapr `charts/dapr/charts/dapr_scheduler/templates/dapr_scheduler_statefulset.yaml:27-29`).
- dapr renders its PDB only under an HA flag and lets `minAvailable` or
  `maxUnavailable` be set; krun's is simpler on purpose: `minAvailable: 1`
  gated on `replicas > 1` (dapr `.../dapr_operator_poddisruptionbudget.yaml:1,18-22`;
  SPEC.md:1333-1334).
- knative's autoscaler uses `RollingUpdate maxUnavailable: 0` for the same
  leader-handover reason krun's scheduler does
  (serving `config/core/deployments/autoscaler.yaml:29-32`).
- knative sizes `terminationGracePeriodSeconds` to the longest request it
  may be draining (600 s on the activator, with the comment explaining
  why: `config/core/deployments/activator.yaml:118-126`); krun's gateway
  closes `wait`/SSE at shutdown instead, so 30 s is enough (SPEC.md:1169-1174).
- dapr and KEDA ship CRDs in `crds/`; krun deliberately templates its CRD
  so `helm upgrade` upgrades it (D22, SPEC.md:1463). Do not "fix" this
  toward the generic advice.

## Pitfalls

- `helm-chart-scaffolding` (installed, generic) says CRDs belong in
  `crds/` and are never templated (`../helm-chart-scaffolding/references/chart-structure.md:374-389`)
  and shows a chart-owned Secret pattern. Both conflict with SPEC: krun
  templates the CRD and renders no Secret (rules 1-2). Use that skill
  only for `_helpers.tpl` naming, `values.schema.json` hygiene and
  `helm lint` habits.
- `kubernetes-skill` helm-patterns.md and `kubernetes-operator` are
  generic; where they suggest an HPA, ingress or Go controller patterns,
  SPEC wins.
- `storageClass: ""` rendered with `quote` pins the PVC to no class
  (SPEC.md:1264).
- `objectStorage.endpoint` without an explicit port means 443 for
  `https://` and 80 for `http://`; in-cluster MinIO usually needs `:9000`
  spelled out (SPEC.md:1020-1021).
- The quota `fail` is skipped when `jobsNamespace.create=false`; the
  README must tell the operator to compare by hand (SPEC.md:1007-1008,
  docs/OPERATIONS.md:19-23).
- The default `gateway.replicas: 2` makes `--set db.mode=embedded` fail
  by design; embedded installs pass `gateway.replicas=1`.
- `quota` keys contain dots (`requests.cpu`); reach them with `index`,
  not dot paths, in templates and in `--set` use `requests\.cpu`.
- Named NetworkPolicy ports break when containers use different port
  names (`admin` vs `admin-sched`); use numbers.
- A `krun.io/gateway` label on the scheduler Deployment silently opens
  8080/8081 to it and lets job pods reach it.
- `helm-docs` reads `# -- description` comments; a `values.yaml` line
  without one leaves a blank README row and P7.5's "every value" check
  fails (PLAN.md:733-737).
- SPEC RISK: knative-serving.md:162,180 recommends the chart `fail` when
  `terminationGracePeriodSeconds < config.shutdownDelay + margin`; SPEC
  lists no such `fail` (SPEC.md:1308-1315) and PLAN.md:31-32 forbids
  unrequested checks. Do not add it; if you believe it is needed, record
  a Decisions-row proposal in the PR description, not in the chart.
- SPEC RISK: SPEC.md:1033 says the scheduler needs `secrets` `create, get,
  list, delete` and SPEC.md:821 says `AlreadyExists` reads the existing
  token; the orphan sweep (SPEC.md:572-573) uses `list`. If the scheduler
  implementation ends up needing `watch` or `update` on Secrets, that is
  a section 9 change: BLOCKED, not a wider Role.

## Before marking a task done

- P0.2: `make check && make helm-lint`.
- P7.1-P7.4c, P7.7: `make helm-lint`, `helm template` in both modes, every
  acceptance grep in PLAN.md:669-673, 681-685, 696-702, 711-714, 718-723,
  730-731, 754-756 passes; `promtool check rules` green.
- P7.5: `make generate` twice leaves no diff; README keys equal `values.yaml`.
- P7.6: `make e2e` green with the chart-based install.
- P9.6: the alert-name script in references/alerts.md exits 0.
- Then `make check` (CLAUDE.md:5), append the progress-log line
  `2026-MM-DD P7.x <sha> note` to PLAN.md section 6 and commit it with the
  code (PLAN.md:19-20), branch `p7-x-<slug>`, PR to main merged when CI
  is green, never push main (PLAN.md:13-22). No `Co-Authored-By`, no
  Claude attribution (CLAUDE.md:7, PLAN.md:16).

## Limitations

- Written before the chart exists; file names in "Chart layout" are
  suggestions, and Helm type-coercion notes are UNVERIFIED against a
  specific Helm minor.
- Does not cover the per-run Job manifest, the CRD schema generator, or
  the e2e harness mechanics (`krun-scheduler-k8s`, `krun-functions-crd`,
  `krun-testing-ci`).
- SPEC line numbers were verified against the working tree on
  2026-10-23; SPEC.md is being edited concurrently, so re-check before
  citing in a commit.
