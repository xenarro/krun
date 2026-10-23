---
name: krun-helm-chart
description: Use when editing the krun Helm chart or NetworkPolicy. Renders both db modes, hooks, PSA-restricted pods, Litestream native sidecar, RBAC, digest admission policy, HTTPRoute, OTEL env, alerts, fail cases.
---

# krun Helm chart

Covers `deploy/helm/krun`: SPEC.md section 13 (values, postgres and
embedded rendering, hook Job, CRD templating with keep, pod template
contract, PDB, rolling update, alerts) and section 9 (jobs namespace
resources, RBAC, NetworkPolicies, PSA, the digest ValidatingAdmissionPolicy,
user namespaces). Kubernetes 1.33 is the minimum (SPEC section 14, D36).
Serves PLAN tasks P0.2 (chart stub), P7.1-P7.7 (including P7.4d, the
optional features) and the P9.6 alert-name check.

## When to use

- Any file under `deploy/helm/krun/` (templates, values, NOTES.txt,
  README via `helm-docs`), `deploy/crds/`, or the chart tests.
- A NetworkPolicy, LimitRange, ResourceQuota, Role or PSA label question.
- The PodMonitor or PrometheusRule, or docs/OPERATIONS.md alert names.
- Not for the Job manifest the scheduler creates per run: that is
  `krun-scheduler-k8s` (../krun-scheduler-k8s/references/job-manifest.md). Not for the CRD
  schema itself: `krun-functions-crd` owns `scripts/gen-crd.ts`.

## Read first

- SPEC.md:1254-1468 (section 13, all of it; values 1259-1350, fail cases
  1352-1359, embedded mode and the Litestream native sidecar 1393-1412,
  rendered resources 1414-1430), SPEC.md:938-1111 (section 9; the
  admission policy and user namespaces 1013-1027), SPEC.md:1203-1253
  (section 12 env names, `KRUN_JOB_HOST_USERS` and `OTEL_*`),
  SPEC.md:1139-1202 (telemetry, metrics, health, shutdown),
  SPEC.md:1469-1492 (section 14: Kubernetes 1.33 minimum),
  SPEC.md:118-128 (CRD generation into the chart).
- Decisions D22, D30, D32 and D36 (section 15; D36: Kubernetes 1.33, native
  sidecar, digest admission policy, user namespaces, HTTPRoute,
  OpenTelemetry).
- PLAN.md:159-165 (P0.2 stub), PLAN.md:198-212 (P0.8 generated CRD
  template), PLAN.md Phase 7 (P7.1-P7.7, including P7.4d), PLAN P9.6;
  PLAN.md:52-54 (Helm 4, `helm-docs`, `promtool`, kind node image
  1.33 or newer).
- docs/STACK.md section 3 (tools, Vitest for tests) and section 5 (load
  `helm-chart-scaffolding`, `kubernetes-skill`, `operating-kubernetes`,
  `kubernetes-hardening` for Phase 7).
- docs/OPERATIONS.md:7-41 (install, prerequisites, keep, upgrade), 43-63
  (capacity), 65-82 (alerts), 94-107 (Litestream drill), 109-117
  (telemetry), 119-153 (security operations: user namespaces, digest
  policy).
- References here: [values.md](references/values.md) (values verbatim,
  per-key meaning, env mapping), [fail-cases.md](references/fail-cases.md)
  (seven `fail` cases, NOTES.txt warning, shell checks),
  [networkpolicies.md](references/networkpolicies.md) (peer tables for
  both namespaces, PSA labels, LimitRange/Quota, RBAC verbs,
  [alerts.md](references/alerts.md) (PodMonitor, seven rules with
  OPERATIONS first checks, promtool procedure),
  (also the digest ValidatingAdmissionPolicy),
  [pod-template.md](references/pod-template.md) (securityContext, labels,
  probes, resources, PDB, spread, rolling update, hook Job, StatefulSet
  with the Litestream native sidecar, Services and the HTTPRoute).

## Rules

1. The chart renders no `Secret`, no ConfigMap and no Function; every secret
   is an `existingSecret` name because the pre-install hook runs before any
   release Secret exists and function instances belong to their owners
   (SPEC.md:1308-1316, 1377-1379, D22).
2. Template the CRD from the generated `templates/crd-functions.yaml` under
   `crds.install`, with `helm.sh/resource-policy: keep` under `crds.keep`;
   never put it in `crds/`, which Helm never upgrades (SPEC.md:1366-1370,
   PLAN.md:200-204).
3. Never edit `templates/crd-functions.yaml` by hand; `scripts/gen-crd.ts`
   writes it from the Zod Function schema through `z.toJSONSchema`
   (`target: "openapi-3.0"`) and CI fails on a diff (SPEC.md:120-128,
   PLAN.md:198-212).
4. Every `fail` case in references/fail-cases.md renders a message naming the
   value; use `fail`, not `required`, and validate once from a template that
   always renders (SPEC.md:1308-1315, PLAN.md:692-693).
5. Embedded mode `fail`s when `gateway.replicas` or `scheduler.replicas`
   exceeds 1: one StatefulSet replica owns the SQLite file (SPEC.md:1314-1315,
   1349).
6. Every pod template carries `app.kubernetes.io/name: krun` and
   `app.kubernetes.io/instance`; only the gateway Deployment and the embedded
   StatefulSet carry `krun.io/gateway: "true"`, because 8080/8081 policies
   select it (SPEC.md:990-994).
7. Every container, init container and native sidecar gets the PSA-restricted
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
   `admin-sched`, init container order Litestream restore, Litestream
   native sidecar (`restartPolicy: Always`), `krun migrate`; never a
   Litestream entry under `containers` (SPEC.md:1393-1412).
13. `storageClassName` renders only when `db.embedded.storageClass` is
   non-empty; an empty string disables dynamic provisioning (SPEC.md:1264,
   1351-1352).
14. Always render into `jobsNamespace.name`: scheduler Role+RoleBinding,
   `krun-job-default`, `krun-job-viewer`; only under `jobsNamespace.create`:
   Namespace with versioned PSA labels, NetworkPolicies, LimitRange,
   ResourceQuota and the quota `fail` (SPEC.md:998-1008).
15. RBAC verbs are verbatim from SPEC.md:1034-1047; the Lease rule is two
   entries (`get, update` with `resourceNames`, `create` without);
   `krun-function-author` and `krun-job-viewer` have no binding; no
   ClusterRole or ClusterRoleBinding. The only cluster-scoped objects the
   chart renders are the CRD and the `krun-jobs-digest` policy and binding
   (SPEC section 9, "Nothing cluster-wide except the CRD object itself", is
   about RBAC).
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
   (SPEC.md:1382-1389, PLAN.md:753-757).
21. Keep scheduler downtime (upgrades, embedded restarts) below
   `config.ttlAfterFinished`, or finished runs become `job_lost`
   (SPEC.md:1416-1417, docs/OPERATIONS.md:37-38).
22. Add no value, flag or resource no task asks for: no nodeSelector,
   tolerations, HPA, `Ingress`, extra Services; the only exposure resource
   is the optional HTTPRoute of rule 25 (PLAN.md:31-32, SPEC.md:19-24).
23. The ValidatingAdmissionPolicy `krun-jobs-digest` and its binding render
   when `jobsNamespace.admissionPolicy` is true (default), independent of
   `jobsNamespace.create`; the binding is scoped to the jobs namespace and
   denies a Job or Pod whose containers or init containers carry an image
   without `@sha256:` (SPEC.md:1017-1021, PLAN P7.4a).
24. `jobsNamespace.userNamespaces: true` renders `KRUN_JOB_HOST_USERS:
   "false"` on the scheduler container only (embedded: the scheduler
   container); the scheduler then writes `hostUsers: false` into each Job
   pod template (SPEC section 7). The chart never sets `hostUsers` on its
   own pods (SPEC.md:1022-1027, 1236).
25. `gatewayApi.httpRoute.enabled` renders one `gateway.networking.k8s.io/v1`
   HTTPRoute with the given `parentRefs` and `hostnames` whose only
   backend is the public Service on 8080; never 8081 or an admin port
   (SPEC.md:1329-1333, 1423-1424).
26. `observability.otlpEndpoint` non-empty renders on every gateway and
   scheduler container `OTEL_EXPORTER_OTLP_ENDPOINT`,
   `OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG`
   from `observability.tracesSampleRatio` (quoted) and `OTEL_SERVICE_NAME`
   `krun-gateway` or `krun-scheduler` per container; empty renders none of
   them (the processes default to dropping traces). Not on the migrate
   hook or the Litestream containers (SPEC.md:1246-1248, 1335-1337).
27. P7.4d renders each optional feature only when enabled; none of them
   adds a `fail` case (references/fail-cases.md).

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
  templates/admission-policy.yaml     ValidatingAdmissionPolicy + binding krun-jobs-digest (cluster-scoped)
  templates/httproute.yaml           gatewayApi.httpRoute.enabled
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
| `krun-jobs-digest` VAP + binding | `jobsNamespace.admissionPolicy` | same | independent of `create` |
| HTTPRoute to the public Service | `gatewayApi.httpRoute.enabled` | same | |
| `KRUN_JOB_HOST_USERS: "false"` | scheduler Deployment | scheduler container | `jobsNamespace.userNamespaces` |
| `OTEL_*` env | gateway and scheduler Deployments | gateway and scheduler containers | `observability.otlpEndpoint` non-empty |
| Litestream native sidecar | no | init container with `restartPolicy: Always` | `db.embedded.litestream.enabled` |

## Testing the chart

- `make helm-lint` runs `helm lint deploy/helm/krun` with values that
  satisfy the `fail` cases (`apiKeys.existingSecret`, `db.postgres.existingSecret`);
  P0.2 only needs `Chart.yaml` and a `values.yaml` with
  `crds: {install: true, keep: true}` so the generated CRD template has
  its condition (PLAN.md:159-165, 202-204).
- Render assertions are Vitest tests over `helm template` output, or
  shell (PLAN.md:689-693). A Vitest test (for example
  `test/helm/render.test.ts` with its own `test/helm/vitest.config.ts`,
  run by `make helm-lint` as
  `pnpm exec vitest run --config test/helm/vitest.config.ts`) calls
  `helm template` through `execFileSync`, parses the stream with the
  `yaml` package (`parseAllDocuments`) and asserts on objects, not on
  text: no `subPath`, no `kind: ConfigMap`, `Secret` or `Function`;
  `krun-gateway-internal` present; `--set crds.install=false` drops the
  CRD; `--set crds.keep=false` drops the annotation;
  `--set jobsNamespace.keep=false` likewise. A failing render is asserted
  on the non-zero exit and the stderr message. Plain `it` is enough: the
  chart tests touch no Effect code and no clock. Vitest is the runner
  (docs/STACK.md section 3).
- P7.4d render checks (PLAN P7.4d acceptance): by default no HTTPRoute, no
  `KRUN_JOB_HOST_USERS`, no `OTEL_*` env, and the VAP plus binding present;
  `--set gatewayApi.httpRoute.enabled=true` with a `parentRefs` entry
  renders the HTTPRoute with backend port 8080;
  `--set jobsNamespace.userNamespaces=true` puts
  `KRUN_JOB_HOST_USERS=false` on the scheduler container only;
  `--set observability.otlpEndpoint=http://otel:4318` puts the four
  `OTEL_*` variables on both processes with the right
  `OTEL_SERVICE_NAME`; `--set jobsNamespace.admissionPolicy=false` drops
  the VAP and binding. P7.3: in embedded mode with Litestream the
  `initContainers` names are in order `litestream-restore`, `litestream`,
  `migrate`, the `litestream` entry has `restartPolicy: Always`, and no
  Litestream container sits under `containers`.
- Each `fail` case has a one-line check in references/fail-cases.md.
- Alerts: references/alerts.md has the `promtool check rules` procedure
  (strip the CR to `.spec` first) and the P9.6 name diff.
- e2e (PLAN P7.6): both modes into fresh namespaces labelled
  `pod-security.kubernetes.io/enforce=restricted`, `objectStorage.egress`
  at the MinIO pods, policy reachability checks, `scheduler.replicas=2`
  one leader, `helm upgrade --set config.logLevel=debug` then
  `helm rollback <release> 1` with a run succeeding after each. P7.4d
  e2e on kind with the admission policy on: a tag-only Job created by
  hand in the jobs namespace is rejected (`kubectl create job x
  --image=busybox:1 -n krun-jobs` fails naming `krun-jobs-digest`). The
  harness lives in `krun-testing-ci`; this skill owns what to assert.

## Library facts

- `helm` 4, `helm-docs`, `promtool`, `kind` 0.31 or newer (kindnetd
  enforces NetworkPolicy) with a node image of Kubernetes 1.33 or newer are
  toolchain, not dependencies (PLAN.md:52-54). `yq` is
  not listed; strip PrometheusRule CRs with the `yaml` package
  (PLAN.md:72) inside the Vitest chart test.
- Helm 4 is the installed and supported version. The chart keeps
  `apiVersion: v2` (P0.2), which Helm 4 renders unchanged; every command in
  this skill and in the e2e harness must run under Helm 4, and CI installs
  a pinned Helm 4 release (one `HELM_VERSION` in the Makefile read by the
  workflows, like kind). Helm 4 changed install-time flags and behaviour
  (server-side apply for new releases, `--atomic` and `--force` renamed);
  check `helm install --help` of the pinned version before writing e2e
  commands. UNVERIFIED in detail against the pinned release.
- `/readyz` and `/healthz` are krun's own routes on the admin listener
  (`krun-process-runtime`): readiness is an Effect-backed route over a
  `Ref`, no Fastify health plugin (docs/STACK.md section 2.2). Chart-side
  consequence: probe paths and timings come from SPEC section 13, never
  from a plugin default.
- Helm `--set` yields int64 for numbers while `values.yaml` keeps
  `quota.pods: "200"` a string: normalise with `int`/`atoi` before `gt`
  (references/fail-cases.md). UNVERIFIED against Helm 4; test both input
  paths.
- Kubernetes 1.33 minimum (SPEC section 14) makes these API shapes
  available without feature gates: native sidecars (an init container
  with `restartPolicy: Always`; the kubelet starts it before the later
  init containers and the app containers and stops it after them),
  `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy and
  ValidatingAdmissionPolicyBinding (GA since 1.30), PSA version labels up
  to `v1.33`. `hostUsers: false` needs 1.36 or the `UserNamespacesSupport`
  feature on 1.33 to 1.35 plus a runtime and kernel with ID-mapped mounts
  (SPEC.md:1022-1027); the chart does not detect this, the operator opts
  in (docs/OPERATIONS.md:121-124).
- HTTPRoute is `gateway.networking.k8s.io/v1` and needs the Gateway API
  CRDs only when enabled (SPEC section 14). Do not gate it on
  `.Capabilities.APIVersions.Has`: `helm template` without a cluster
  would silently drop it and P7.4d asserts it renders when enabled.

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

- A Litestream container under `containers` (a regular container) races
  the app containers at shutdown and can miss the last WAL frames; SPEC
  makes it a native sidecar for exactly this reason (D36). Place it after
  `litestream-restore` (it must replicate the restored database, not an
  empty file) and before `migrate` (migration writes are replicated).
- The VAP and binding are cluster-scoped and SPEC fixes the name
  `krun-jobs-digest`: a second release in the same cluster collides.
  That is accepted by SPEC (one installation per cluster for this
  policy); do not template a release suffix into the name without BLOCKED.
- The binding selects the jobs namespace by
  `kubernetes.io/metadata.name`, never by a label the chart adds: with
  `jobsNamespace.create=false` the chart labels nothing there.
- `hostUsers` on chart pods: not in SPEC; the krun pods keep the host
  user namespace. Only function pods get it, via the scheduler env.

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
  fails (PLAN.md:753-757).
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
  acceptance check in PLAN.md:689-693, 701-705, 716-722, 731-734, 738-743,
  750-751, 774-776 passes in the Vitest chart test under the pinned Helm 4;
  `promtool check rules` green.
- P7.5: `make generate` twice leaves no diff; README keys equal `values.yaml`.
- P7.6: `make e2e` green with the chart-based install.
- P9.6: the alert-name script in references/alerts.md exits 0.
- Then `make check` (CLAUDE.md rule 3), append the progress-log line
  `2026-MM-DD P7.x <sha> note` to PLAN.md section 6 and commit it with the
  code (PLAN.md:19-20), branch `p7-x-<slug>`, PR to main merged when CI
  is green, never push main (PLAN.md:13-22). No `Co-Authored-By`, no
  Claude attribution (CLAUDE.md rule 5, PLAN.md:16).

## Limitations

- Written before the chart exists; file names in "Chart layout" and the
  `test/helm/` location are suggestions, and Helm type-coercion and
  Helm 4 flag notes are UNVERIFIED against the pinned Helm 4 release.
- Does not cover the per-run Job manifest, the CRD schema generator, or
  the e2e harness mechanics (`krun-scheduler-k8s`, `krun-functions-crd`,
  `krun-testing-ci`).
- SPEC line numbers in "Read first" were checked on 2026-10-23; inline
  citations in the body and references may be off (section 9 citations
  by a few lines, section 13 ones by about 30). Re-check any citation
  before using it in a commit.
