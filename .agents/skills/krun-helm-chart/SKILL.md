---
name: krun-helm-chart
description: Use when editing the krun Helm chart or NetworkPolicy. Renders both db modes, hooks, PSA-restricted pods, Litestream native sidecar, RBAC, digest admission policy, HTTPRoute, OTEL env, alerts, fail cases.
---

# krun Helm chart

Covers `deploy/helm/krun`: SPEC.md section 13 (chart) and section 9 (jobs
namespace, RBAC, NetworkPolicies, PSA, digest policy, user namespaces).
Kubernetes 1.33 minimum (SPEC section 14, D36). PLAN tasks: P0.2 (chart
stub), P7.1-P7.7 (including P7.4d, optional features), P9.6 alert-name check.

## When to use

- Any file under `deploy/helm/krun/` (templates, values, NOTES.txt,
  README via `helm-docs`), `deploy/crds/`, or the chart tests.
- NetworkPolicy, LimitRange, ResourceQuota, Role or PSA label questions.
- PodMonitor, PrometheusRule, or docs/OPERATIONS.md alert names.
- Not for the per-run Job manifest: `krun-scheduler-k8s`
  (../krun-scheduler-k8s/references/job-manifest.md). Not for the CRD
  schema: `krun-functions-crd` owns `scripts/gen-crd.ts`.

## Read first

| Source | Lines / items |
|---|---|
| SPEC section 13 | SPEC.md:1254-1468 in full; values 1259-1350, fail cases 1352-1359, embedded mode and Litestream native sidecar 1393-1412, rendered resources 1414-1430 |
| SPEC section 9 | SPEC.md:938-1111; admission policy and user namespaces 1013-1027 |
| SPEC other | SPEC.md:1203-1253 (section 12 env, `KRUN_JOB_HOST_USERS`, `OTEL_*`), SPEC.md:1139-1202 (telemetry, metrics, health, shutdown), SPEC.md:1469-1492 (section 14), SPEC.md:118-128 (CRD generation) |
| Decisions | D22, D30, D32, D36 (Kubernetes 1.33, native sidecar, digest admission policy, user namespaces, HTTPRoute, OpenTelemetry) |
| PLAN | PLAN.md:159-165 (P0.2 stub), PLAN.md:198-212 (P0.8 generated CRD template), Phase 7 (P7.1-P7.7), P9.6; PLAN.md:52-54 (Helm 4, `helm-docs`, `promtool`, kind node image 1.33 or newer) |
| docs/STACK.md | section 3 (tools, Vitest); section 5 (load `helm-chart-scaffolding`, `kubernetes-skill`, `operating-kubernetes`, `kubernetes-hardening` for Phase 7) |
| docs/OPERATIONS.md | docs/OPERATIONS.md:7-41 install, prerequisites, keep, upgrade; 43-63 capacity; 65-82 alerts; 94-107 Litestream drill; 109-117 telemetry; 119-153 security operations |

References:

| File | Holds |
|---|---|
| [values.md](references/values.md) | values verbatim, per-key meaning, env mapping |
| [fail-cases.md](references/fail-cases.md) | seven `fail` cases, NOTES.txt warning, shell checks |
| [networkpolicies.md](references/networkpolicies.md) | peer tables for both namespaces, PSA labels, LimitRange/Quota, RBAC verbs, digest ValidatingAdmissionPolicy |
| [alerts.md](references/alerts.md) | PodMonitor, seven rules with OPERATIONS first checks, promtool procedure |
| [pod-template.md](references/pod-template.md) | securityContext, labels, probes, resources, PDB, spread, rolling update, hook Job, StatefulSet with Litestream native sidecar, Services, HTTPRoute |

## Rules

1. Render no `Secret`, no ConfigMap and no Function. Every secret is an
   `existingSecret` name: the pre-install hook runs before any release
   Secret exists, and function instances belong to their owners
   (SPEC.md:1308-1316, 1377-1379, D22).
2. Template the CRD from generated `templates/crd-functions.yaml` under
   `crds.install`, with `helm.sh/resource-policy: keep` under `crds.keep`.
   Never put it in `crds/`: Helm never upgrades that directory
   (SPEC.md:1366-1370, PLAN.md:200-204).
3. Never hand-edit `templates/crd-functions.yaml`. `scripts/gen-crd.ts`
   writes it from the Zod Function schema through `z.toJSONSchema`
   (`target: "openapi-3.0"`); CI fails on a diff (SPEC.md:120-128,
   PLAN.md:198-212).
4. Every `fail` case in references/fail-cases.md renders a message naming
   the value. Use `fail`, not `required`. Validate once, from a template
   that always renders (SPEC.md:1308-1315, PLAN.md:692-693).
5. Embedded mode `fail`s when `gateway.replicas` or `scheduler.replicas`
   exceeds 1: one StatefulSet replica owns the SQLite file
   (SPEC.md:1314-1315, 1349).
6. Every pod template carries `app.kubernetes.io/name: krun` and
   `app.kubernetes.io/instance`. Only the gateway Deployment and the
   embedded StatefulSet carry `krun.io/gateway: "true"`: 8080/8081
   policies select it (SPEC.md:990-994).
7. Every container, init container and native sidecar gets the
   PSA-restricted securityContext (65532, `RuntimeDefault`, drop ALL, no
   privilege escalation, RO rootfs, `/tmp` emptyDir).
   `automountServiceAccountToken` only on gateway and scheduler
   (SPEC.md:1319-1324).
8. Readiness `/readyz` 5/3/3, liveness `/healthz` 10/3/3, no startup
   probe, each on the container's own admin port. Never put liveness on
   `/readyz`: a stalled database would restart healthy pods
   (SPEC.md:1327-1331, 1161-1164).
9. Default resources carry no CPU limit. Render `.Values.<proc>.resources`
   verbatim (SPEC.md:1331, 1233).
10. Gateway: PDB `minAvailable: 1` only when `replicas > 1`; hostname
    `topologySpreadConstraints` with `ScheduleAnyway`. Scheduler:
    `RollingUpdate` `maxSurge: 1`, `maxUnavailable: 0`, so a Ready standby
    exists before the leader gets SIGTERM (SPEC.md:1333-1337).
11. Postgres mode: hook Job weight `"0"`, SA `krun-migrate` weight `"-5"`,
    both `pre-install,pre-upgrade` and `before-hook-creation,hook-succeeded`.
    Job `restartPolicy: Never`, `backoffLimit: 1`, `activeDeadlineSeconds:
    240`. SA has no Role and no automount (SPEC.md:1339-1347).
12. Embedded mode: one StatefulSet, `fsGroup: 65532` + `OnRootMismatch`,
    headless Service with no ports, scheduler SA for the pod, no gateway
    SA/RoleBinding. Scheduler container gets `KRUN_ADMIN_LISTEN_ADDR=:9091`,
    port `admin-sched`. Init container order: Litestream restore, Litestream
    native sidecar (`restartPolicy: Always`), `krun migrate`. Never a
    Litestream entry under `containers` (SPEC.md:1393-1412).
13. Render `storageClassName` only when `db.embedded.storageClass` is
    non-empty. An empty string disables dynamic provisioning
    (SPEC.md:1264, 1351-1352).
14. Always render into `jobsNamespace.name`: scheduler Role+RoleBinding,
    `krun-job-default`, `krun-job-viewer`. Only under `jobsNamespace.create`:
    Namespace with versioned PSA labels, NetworkPolicies, LimitRange,
    ResourceQuota and the quota `fail` (SPEC.md:998-1008).
15. RBAC verbs are verbatim from SPEC.md:1034-1047. The Lease rule is two
    entries (`get, update` with `resourceNames`, `create` without).
    `krun-function-author` and `krun-job-viewer` have no binding. No
    ClusterRole or ClusterRoleBinding. The only cluster-scoped objects are
    the CRD and the `krun-jobs-digest` policy and binding (SPEC section 9,
    "Nothing cluster-wide except the CRD object itself", is about RBAC).
16. krun-namespace NetworkPolicies select the release's pods, never the
    namespace. Admin ports 9090 (+9091 embedded) admit
    `networkPolicy.metricsFrom`; empty allows all. No egress policy there
    (SPEC.md:1051-1056).
17. Jobs-namespace egress is exactly rules 1-4 of SPEC.md:1013-1025.
    `egressCIDRs` are `ipBlock` objects with `except`. NOTES.txt warns on
    `0.0.0.0/0` or `::/0` without `except` (SPEC.md:1316-1317, D32).
18. Section 9 policy and the values shape are owner decisions. A change
    needs BLOCKED, not a Decisions row from you (PLAN.md:23-26).
19. `config.*` keys map 1:1 to section 12 env on every krun container,
    quoted. Always set `KRUN_GATEWAY_INTERNAL_URL` from the rendered
    internal Service (SPEC.md:1240, 1195).
20. README states `keep` consequences: kept CRD/Namespace retain
    `meta.helm.sh` annotations; re-install with the same name and namespace
    or `kubectl annotate ... --overwrite`; deleting the CRD deletes every
    Function (SPEC.md:1382-1389, PLAN.md:753-757).
21. Keep scheduler downtime (upgrades, embedded restarts) below
    `config.ttlAfterFinished`, or finished runs become `job_lost`
    (SPEC.md:1416-1417, docs/OPERATIONS.md:37-38).
22. Add no value, flag or resource no task asks for: no nodeSelector,
    tolerations, HPA, `Ingress`, extra Services. The only exposure resource
    is the optional HTTPRoute of rule 25 (PLAN.md:31-32, SPEC.md:19-24).
23. ValidatingAdmissionPolicy `krun-jobs-digest` and its binding render
    when `jobsNamespace.admissionPolicy` is true (default), independent of
    `jobsNamespace.create`. The binding is scoped to the jobs namespace. It
    denies a Job or Pod whose containers or init containers carry an image
    without `@sha256:` (SPEC.md:1017-1021, PLAN P7.4a).
24. `jobsNamespace.userNamespaces: true` renders `KRUN_JOB_HOST_USERS:
    "false"` on the scheduler container only (embedded: the scheduler
    container). The scheduler then writes `hostUsers: false` into each Job
    pod template (SPEC section 7). The chart never sets `hostUsers` on its
    own pods (SPEC.md:1022-1027, 1236).
25. `gatewayApi.httpRoute.enabled` renders one `gateway.networking.k8s.io/v1`
    HTTPRoute with the given `parentRefs` and `hostnames`. Its only backend
    is the public Service on 8080. Never 8081, never an admin port
    (SPEC.md:1329-1333, 1423-1424).
26. Non-empty `observability.otlpEndpoint` renders four `OTEL_*` env vars
    on every gateway and scheduler container (table in
    references/pod-template.md). Empty renders none (processes drop traces).
    Never on the migrate hook or Litestream containers (SPEC.md:1246-1248,
    1335-1337).
27. P7.4d renders each optional feature only when enabled. None adds a
    `fail` case (references/fail-cases.md).

Chart layout (suggested file names, one kind per file): references/pod-template.md.

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
  satisfy the `fail` cases (`apiKeys.existingSecret`,
  `db.postgres.existingSecret`). P0.2 needs only `Chart.yaml` and a
  `values.yaml` with `crds: {install: true, keep: true}`, so the generated
  CRD template has its condition (PLAN.md:159-165, 202-204).
- Render assertions: Vitest over `helm template` output, or shell
  (PLAN.md:689-693). Suggested: `test/helm/render.test.ts` with its own
  `test/helm/vitest.config.ts`, run by `make helm-lint` as
  `pnpm exec vitest run --config test/helm/vitest.config.ts`. Call `helm
  template` through `execFileSync`, parse with the `yaml` package
  (`parseAllDocuments`), assert on objects, not text. Plain `it`: no Effect
  code, no clock (docs/STACK.md section 3).

| Render | Assert |
|---|---|
| default | no `subPath`; no `kind: ConfigMap`, `Secret` or `Function`; `krun-gateway-internal` present; no HTTPRoute, no `KRUN_JOB_HOST_USERS`, no `OTEL_*` env; VAP plus binding present (PLAN P7.4d acceptance) |
| `--set crds.install=false` | no CRD |
| `--set crds.keep=false` / `--set jobsNamespace.keep=false` | no keep annotation |
| `--set gatewayApi.httpRoute.enabled=true` + a `parentRefs` entry | HTTPRoute, backend port 8080 |
| `--set jobsNamespace.userNamespaces=true` | `KRUN_JOB_HOST_USERS=false` on the scheduler container only |
| `--set observability.otlpEndpoint=http://otel:4318` | four `OTEL_*` variables on both processes, right `OTEL_SERVICE_NAME` each |
| `--set jobsNamespace.admissionPolicy=false` | no VAP, no binding |
| P7.3 embedded with Litestream | `initContainers` names in order `litestream-restore`, `litestream`, `migrate`; `litestream` has `restartPolicy: Always`; no Litestream container under `containers` |
| any failing render | non-zero exit and the stderr message; one-line check per case in references/fail-cases.md |

- Alerts: `promtool check rules` (strip the CR to `.spec` first) and the
  P9.6 name diff, in references/alerts.md.
- e2e (PLAN P7.6): both modes into fresh namespaces labelled
  `pod-security.kubernetes.io/enforce=restricted`; `objectStorage.egress`
  at the MinIO pods; policy reachability checks; `scheduler.replicas=2`
  has one leader; `helm upgrade --set config.logLevel=debug` then
  `helm rollback <release> 1`, a run succeeding after each. P7.4d on kind,
  admission policy on: a tag-only Job created by hand in the jobs namespace
  is rejected (`kubectl create job x
  --image=busybox:1 -n krun-jobs` fails naming `krun-jobs-digest`).
  `krun-testing-ci` owns the harness; this skill owns what to assert.

## Library facts

- Toolchain, not dependencies: `helm` 4, `helm-docs`, `promtool`, `kind`
  0.31 or newer (kindnetd enforces NetworkPolicy), node image Kubernetes
  1.33 or newer (PLAN.md:52-54). `yq` is not listed: strip PrometheusRule
  CRs with the `yaml` package (PLAN.md:72) inside the Vitest chart test.
- Helm 4 only; the chart keeps `apiVersion: v2` (P0.2), rendered unchanged.
  CI pins one `HELM_VERSION` in the Makefile, read by the workflows, like
  kind. Helm 4 changed install flags and behaviour (server-side apply for
  new releases, `--atomic` and `--force` renamed). Check `helm install
  --help` of the pinned version before writing e2e commands. UNVERIFIED in
  detail against the pinned release.
- `/readyz` and `/healthz` are krun's own admin-listener routes
  (`krun-process-runtime`): readiness is an Effect-backed route over a
  `Ref`, no Fastify health plugin (docs/STACK.md section 2.2). Probe paths
  and timings come from SPEC section 13, never from a plugin default.
- Kubernetes 1.33 (SPEC section 14) needs no feature gate for: native
  sidecars (init container with `restartPolicy: Always`),
  `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy and
  ValidatingAdmissionPolicyBinding (GA since 1.30), PSA labels up to `v1.33`.
- `hostUsers: false` needs 1.36, or the `UserNamespacesSupport` feature on
  1.33 to 1.35 plus a runtime and kernel with ID-mapped mounts
  (SPEC.md:1022-1027). The chart does not detect this; the operator opts
  in (docs/OPERATIONS.md:121-124).
- HTTPRoute (`gateway.networking.k8s.io/v1`) needs the Gateway API CRDs
  only when enabled (SPEC section 14). Never gate it on
  `.Capabilities.APIVersions.Has`: `helm template` without a cluster would
  silently drop it, and P7.4d asserts it renders when enabled.

## Pitfalls

KEDA, dapr and knative lessons (securityContext, probes, PDB, rollout,
grace period): references/pod-template.md.

- Generic skills conflict with SPEC. `helm-chart-scaffolding` says CRDs
  belong in `crds/`, never templated
  (`../helm-chart-scaffolding/references/chart-structure.md:374-389`), and
  shows a chart-owned Secret. dapr and KEDA also ship CRDs in `crds/`.
  krun templates its CRD so `helm upgrade` upgrades it, and renders no
  Secret (rules 1-2, D22, SPEC.md:1463). Do not "fix" this toward the
  generic advice. Use that skill only for `_helpers.tpl` naming,
  `values.schema.json` hygiene and `helm lint` habits.
- `kubernetes-skill` helm-patterns.md and `kubernetes-operator` are
  generic. Where they suggest an HPA, ingress or Go controller patterns,
  SPEC wins.
- The quota `fail` is skipped when `jobsNamespace.create=false`. The
  README must tell the operator to compare by hand (SPEC.md:1007-1008,
  docs/OPERATIONS.md:19-23).
- `helm-docs` reads `# -- description` comments. A `values.yaml` line
  without one leaves a blank README row, and P7.5's "every value" check
  fails (PLAN.md:753-757).
- SPEC RISK: knative-serving.md:162,180 recommends a `fail` when
  `terminationGracePeriodSeconds < config.shutdownDelay + margin`. SPEC
  lists no such `fail` (SPEC.md:1308-1315), and PLAN.md:31-32 forbids
  unrequested checks. Do not add it. If you believe it is needed, propose a
  Decisions row in the PR description, not in the chart.
- SPEC RISK: SPEC.md:1033 gives the scheduler `secrets` `create, get,
  list, delete`; SPEC.md:821 says `AlreadyExists` reads the existing token;
  the orphan sweep (SPEC.md:572-573) uses `list`. If the scheduler needs
  `watch` or `update` on Secrets, that is a section 9 change: BLOCKED, not a
  wider Role.

## Before marking a task done

- P0.2: `make check && make helm-lint`.
- P7.1-P7.4c, P7.7: `make helm-lint`; `helm template` in both modes; every
  acceptance check in PLAN.md:689-693, 701-705, 716-722, 731-734, 738-743,
  750-751, 774-776 passes in the Vitest chart test under pinned Helm 4;
  `promtool check rules` green.
- P7.5: `make generate` twice leaves no diff; README keys equal `values.yaml`.
- P7.6: `make e2e` green with the chart-based install.
- P9.6: the alert-name script in references/alerts.md exits 0.
- Then `make check` (CLAUDE.md rule 3). Append progress-log line
  `2026-MM-DD P7.x <sha> note` to PLAN.md section 6 and commit it with the
  code (PLAN.md:19-20). Branch `p7-x-<slug>`, PR to main, merge when CI is
  green, never push main (PLAN.md:13-22). No `Co-Authored-By`, no Claude
  attribution (CLAUDE.md rule 5, PLAN.md:16).

## Limitations

- Written before the chart exists. Chart layout file names and the
  `test/helm/` location are suggestions. Helm type-coercion and Helm 4
  flag notes are UNVERIFIED against the pinned Helm 4 release.
- Out of scope: per-run Job manifest, CRD schema generator, e2e harness
  mechanics (`krun-scheduler-k8s`, `krun-functions-crd`, `krun-testing-ci`).
- "Read first" SPEC line numbers checked 2026-10-23. Body and reference
  citations may be off (section 9 by a few lines, section 13 by about 30).
  Re-check any citation before using it in a commit.
