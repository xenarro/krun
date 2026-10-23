# NetworkPolicies (SPEC.md section 9)

Two namespaces, two selector rules:

- Jobs namespace: the chart does not label function pods, so deny-all and
  egress policies use an empty `podSelector: {}` (SPEC.md:1013-1026).
- krun namespace: every policy selects the release's pods, never the whole
  namespace (SPEC.md:1051-1052). 8080/8081 select `krun.io/gateway: "true"`;
  deny-all and admin ports select `app.kubernetes.io/name: krun` +
  `app.kubernetes.io/instance: <release>` (SPEC.md:990-994). No egress
  policy in the krun namespace in v1 (SPEC.md:1056).

Section 9 policy is an owner decision: never add, widen or narrow a rule
without BLOCKED (PLAN.md:23-26).

Rendering gate: jobs namespace policies render only when
`jobsNamespace.create` is true (SPEC.md:999-1004); krun namespace policies
always render. Generic mechanics (`policyTypes`, peer semantics, port+peer
AND/OR) live in the `kubernetes-skill` reference `network-exposure.md`; do
not restate them.

## Jobs namespace (`metadata.namespace: {{ .Values.jobsNamespace.name }}`)

| Policy | podSelector | policyTypes | Direction | Ports | Peers (`to`) | Condition | SPEC |
|---|---|---|---|---|---|---|---|
| `krun-jobs-deny-all` | `{}` | `[Ingress, Egress]` | none (no `ingress`, no `egress` keys) | | | always when `create` | SPEC.md:1013 |
| `krun-jobs-allow-dns` | `{}` | `[Egress]` | egress | `UDP 53`, `TCP 53` | `jobsNamespace.dnsEgress` rendered with `toYaml` (default `namespaceSelector kubernetes.io/metadata.name: kube-system` + `podSelector k8s-app: kube-dns`) | always when `create` | SPEC.md:1013-1016 |
| `krun-jobs-allow-gateway` | `{}` | `[Egress]` | egress | `TCP 8081` | `namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .Release.Namespace }} } }` + `podSelector: { matchLabels: { krun.io/gateway: "true" } }` in ONE peer object | always when `create` | SPEC.md:1017-1018 |
| `krun-jobs-allow-object-storage` | `{}` | `[Egress]` | egress | `TCP <port from objectStorage.endpoint>` | `objectStorage.egress` rendered with `toYaml` | `create` and `objectStorage.enabled` | SPEC.md:1018-1021 |
| `krun-jobs-allow-egress-cidrs` | `{}` | `[Egress]` | egress | none (all ports) | one `- ipBlock: { cidr, except }` per `jobsNamespace.egressCIDRs` entry | `create` and the list is non-empty | SPEC.md:1021-1025 |

Rule-3 port parsing: read the URL from `objectStorage.endpoint`. An
explicit `:port` wins; otherwise `https` (`https://`) gives 443 and `http`
(`http://`) gives 80 (SPEC.md:1020-1021). In-cluster MinIO usually needs `:9000` spelled out. Sprig has no URL parser: `trimPrefix` the scheme,
`splitList "/"`, then `regexFind ":[0-9]+$"` on the host part; default by
`hasPrefix "https://"`. Test an explicit port
(`http://minio.minio.svc:9000`) and both defaults.

Peers: `namespaceSelector` and `podSelector` in one list item are ANDed;
two list items are ORed. The gateway rule must be ONE item, or the policy
admits every pod in the krun namespace. `dnsEgress` and
`objectStorage.egress` are copied verbatim, so the platform team controls
that shape (SPEC.md:1014-1016, 1019-1020).

`except` renders inside `ipBlock` only. P7.4c acceptance requires a
rendered `except` in `helm template` output (PLAN.md:751), so the chart
test must set at least one entry with `except`.

Not rendered here: per-function egress; ingress to function pods (nothing
connects to them); an API server rule (function pods have
`automountServiceAccountToken: false`, SPEC.md:1032-1033). Per-function
extra egress belongs to the platform team (SPEC.md:1025-1026).

## krun namespace (`metadata.namespace: {{ .Release.Namespace }}`)

Let `nameInstance` = `{ app.kubernetes.io/name: krun, app.kubernetes.io/instance: {{ .Release.Name }} }`
and `gw` = `{ krun.io/gateway: "true" }` (carried by the gateway Deployment
and the embedded StatefulSet template, SPEC.md:991-992).

| Policy | podSelector | policyTypes | Ports | Peers (`from`) | Condition | SPEC |
|---|---|---|---|---|---|---|
| `krun-deny-ingress` | `nameInstance` | `[Ingress]` | none | none | always | SPEC.md:1051-1052 |
| `krun-allow-public` | `gw` | `[Ingress]` | `TCP 8080` | omit `from` (anywhere) | always | SPEC.md:1053 |
| `krun-allow-internal` | `gw` | `[Ingress]` | `TCP 8081` | `namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .Values.jobsNamespace.name }} } }` | always | SPEC.md:1053-1054, 982-984 |
| `krun-allow-admin` | `nameInstance` | `[Ingress]` | `TCP 9090`, plus `TCP 9091` when `db.mode == embedded` | `namespaceSelector: {{ .Values.networkPolicy.metricsFrom }}` when non-empty; omit `from` when empty (allows all) | always | SPEC.md:1054-1056 |

Consequence: the scheduler Deployment has no `krun.io/gateway` label, so
it receives nothing on 8080/8081, and only `metricsFrom` reaches its 9090.
In embedded mode the one pod carries `gw`: its 8081 is reachable from the
jobs namespace, its 9090 and 9091 only from `metricsFrom` (P7.6 asserts
both, PLAN.md:761-763).

Use numeric ports, not names: a named port requires the name on every
selected container, and the two admin ports have different names
(`admin`, `admin-sched`).

`networkPolicy.metricsFrom` is a `namespaceSelector` body
(`matchLabels`/`matchExpressions`), not a full peer. Wrap it:

```yaml
{{- with .Values.networkPolicy.metricsFrom }}
      from:
        - namespaceSelector:
            {{- toYaml . | nindent 12 }}
{{- end }}
```

## PSA labels on the jobs Namespace (SPEC.md:1014-1016)

`podSecurityVersion` defaults to `v1.33`, the minimum supported Kubernetes
(SPEC section 14). Never `latest`: it would change the policy under the
operator on a cluster upgrade.

```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/enforce-version: {{ .Values.jobsNamespace.podSecurityVersion }}
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/warn-version: {{ .Values.jobsNamespace.podSecurityVersion }}
pod-security.kubernetes.io/audit: restricted
pod-security.kubernetes.io/audit-version: {{ .Values.jobsNamespace.podSecurityVersion }}
```

Plus `helm.sh/resource-policy: keep` when `jobsNamespace.keep`
(SPEC.md:1001-1003). The chart never labels the krun namespace. The
platform team labels it before `helm install` (SPEC.md:1325-1327,
docs/OPERATIONS.md:16-18); the P7 e2e creates it labelled (PLAN.md:677-678).

## Digest ValidatingAdmissionPolicy (SPEC.md:1017-1021, PLAN P7.4a, P7.4d)

Rendered when `jobsNamespace.admissionPolicy` is true (default), whether
or not `jobsNamespace.create` is. Both objects are cluster-scoped (no
`metadata.namespace`); the binding narrows them to the jobs namespace.

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: krun-jobs-digest
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - { apiGroups: [batch], apiVersions: [v1], operations: [CREATE, UPDATE], resources: [jobs] }
      - { apiGroups: [""],    apiVersions: [v1], operations: [CREATE, UPDATE], resources: [pods] }
  variables:
    - name: spec
      expression: "object.kind == 'Job' ? object.spec.template.spec : object.spec"
  validations:
    - expression: >-
        variables.spec.containers.all(c, c.image.contains('@sha256:')) &&
        (!has(variables.spec.initContainers) ||
         variables.spec.initContainers.all(c, c.image.contains('@sha256:')))
      message: "images in the krun jobs namespace must be pinned by digest (image@sha256:...)"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: krun-jobs-digest
spec:
  policyName: krun-jobs-digest
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels: { kubernetes.io/metadata.name: {{ .Values.jobsNamespace.name }} }
```

- Match Jobs and Pods both. The scheduler's Jobs are denied before their
  pods exist (a 4xx the scheduler classifies as `job_create_failed`). A Pod
  created by hand or by another controller is denied too.
- The API server sets `kubernetes.io/metadata.name` on every Namespace, so
  the binding works with `jobsNamespace.create=false`. Never select by a
  chart-added label: with `create=false` the chart labels nothing there.
- SPEC fixes the cluster-scoped name `krun-jobs-digest`, so a second
  release in the same cluster collides. SPEC accepts this (one installation
  per cluster for this policy). Never template a release suffix into the
  name without BLOCKED.
- Containers and init containers only, as SPEC says. Ephemeral containers
  (`kubectl debug`) go through the `pods/ephemeralcontainers` subresource,
  which this rule does not match. Do not widen it without BLOCKED.
- The CEL above is a sketch: UNVERIFIED until the P7.4d e2e on kind rejects
  a tag-only Job created by hand and the scheduler's digest-pinned Jobs
  still pass. `kubernetes-hardening` covers VAP mechanics; SPEC fixes scope
  and name.
- It enforces the digest SPEC section 9 requires ("Images: digest only").
  It verifies no signature. Signature policy stays with the platform team
  (Kyverno or Sigstore policy-controller).

## LimitRange and ResourceQuota (SPEC.md:1027-1031)

```yaml
kind: LimitRange
spec:
  limits:
    - type: Container
      defaultRequest: {{ toYaml .Values.jobsNamespace.limitRange.defaultRequest }}
      default:        {{ toYaml .Values.jobsNamespace.limitRange.default }}
      max:            {{ toYaml .Values.jobsNamespace.limitRange.max }}
---
kind: ResourceQuota
spec:
  hard:
    pods: {{ index .Values.jobsNamespace.quota "pods" | quote }}
    requests.cpu: {{ index .Values.jobsNamespace.quota "requests.cpu" | quote }}
    requests.memory: {{ index .Values.jobsNamespace.quota "requests.memory" }}
    requests.ephemeral-storage: {{ index .Values.jobsNamespace.quota "requests.ephemeral-storage" }}
```

All three LimitRange maps and the quota must carry `ephemeral-storage`
(P7.4a acceptance, PLAN.md:731-733): a function filling `/tmp` is evicted
and classified `evicted` (SPEC.md:1030-1031, D32). A LimitRange `max` below
a Function's requests gets the Job rejected at admission, classified
permanent `job_create_failed` (SPEC.md section 8). Keep the section 13
defaults unless the owner changes them.

## RBAC (SPEC.md:1034-1047), verbs verbatim

| Role | Namespace | apiGroups / resources | verbs | Binding | Rendered when |
|---|---|---|---|---|---|
| `krun-scheduler` (jobs) | `jobsNamespace.name` | `batch` `jobs` | create, get, list, watch, delete | RoleBinding to scheduler SA in `.Release.Namespace` | always |
| | | `""` `pods` | get, list, watch | | |
| | | `""` `pods/log` | get | | |
| | | `""` `secrets` | create, get, list, delete | | |
| `krun-scheduler` (krun) | `.Release.Namespace` | `coordination.k8s.io` `leases`, `resourceNames: [krun-scheduler]` | get, update | RoleBinding to scheduler SA | always |
| | | `coordination.k8s.io` `leases` (no `resourceNames`) | create | | |
| | | `krun.io` `functions` | get, list, watch | | |
| | | `krun.io` `functions/status` | patch | | |
| `krun-gateway` | `.Release.Namespace` | `krun.io` `functions` | get, list, watch | RoleBinding to gateway SA | postgres mode only (SPEC.md:1353-1355) |
| `krun-function-author` | `.Release.Namespace` | `krun.io` `functions` | get, list, watch, create, update, patch, delete | none | always |
| `krun-job-viewer` | `jobsNamespace.name` | `""` `pods` get, list; `""` `pods/log` get; `batch` `jobs` get, list | | none | always |
| `krun-job-default` SA | `jobsNamespace.name` | — | — | none; `automountServiceAccountToken: false` | always |
| `krun-migrate` SA | `.Release.Namespace` | — | — | none; `automountServiceAccountToken: false`; hook annotations | postgres mode only |

- `functions.krun.io` in SPEC prose means `apiGroups: [krun.io]`,
  `resources: [functions]` in RBAC.
- No cluster-wide RBAC. The CRD, digest policy and binding are the only
  cluster-scoped objects (SPEC.md:1041).
- The Lease rule needs two entries: `create` cannot carry `resourceNames`
  (PLAN.md:737-738).
- `secrets` gets only the four listed verbs: `get` serves the
  `AlreadyExists` path (read the existing token, SPEC.md:821), `list` the
  orphan Secret sweep (SPEC.md:572-573, D11). No `update`, `patch` or
  `watch`.

P7.4b check: `--set jobsNamespace.create=false` still renders the
scheduler Role, RoleBinding, `krun-job-default` and `krun-job-viewer`, and
no Namespace, LimitRange, ResourceQuota or NetworkPolicy in the jobs
namespace (PLAN.md:739-741).
