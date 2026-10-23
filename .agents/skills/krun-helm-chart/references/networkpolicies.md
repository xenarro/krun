# NetworkPolicies (SPEC.md section 9)

Two namespaces, two selector rules. Jobs namespace: function pods are
unlabelled by the chart, so the deny-all and egress policies use an
empty `podSelector: {}` (SPEC.md:1013-1026). krun namespace: every policy
selects the release's pods, never the whole namespace (SPEC.md:1051-1052);
8080/8081 select `krun.io/gateway: "true"`, deny-all and the admin ports
select `app.kubernetes.io/name: krun` + `app.kubernetes.io/instance: <release>`
(SPEC.md:990-994). No egress policy in the krun namespace in v1
(SPEC.md:1056). Section 9 policy is an owner decision: never add, widen
or narrow a rule without BLOCKED (PLAN.md:23-26).

Rendering gate: the jobs namespace policies render only when
`jobsNamespace.create` is true (SPEC.md:999-1004); the krun namespace
policies always render. Generic mechanics (`policyTypes`, peer
semantics, port+peer AND/OR) are in the `kubernetes-skill` reference
`network-exposure.md`; do not restate them.

## Jobs namespace (`metadata.namespace: {{ .Values.jobsNamespace.name }}`)

| Policy | podSelector | policyTypes | Direction | Ports | Peers (`to`) | Condition | SPEC |
|---|---|---|---|---|---|---|---|
| `krun-jobs-deny-all` | `{}` | `[Ingress, Egress]` | none (no `ingress`, no `egress` keys) | | | always when `create` | SPEC.md:1013 |
| `krun-jobs-allow-dns` | `{}` | `[Egress]` | egress | `UDP 53`, `TCP 53` | `jobsNamespace.dnsEgress` rendered with `toYaml` (default `namespaceSelector kubernetes.io/metadata.name: kube-system` + `podSelector k8s-app: kube-dns`) | always when `create` | SPEC.md:1013-1016 |
| `krun-jobs-allow-gateway` | `{}` | `[Egress]` | egress | `TCP 8081` | `namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .Release.Namespace }} } }` + `podSelector: { matchLabels: { krun.io/gateway: "true" } }` in ONE peer object | always when `create` | SPEC.md:1017-1018 |
| `krun-jobs-allow-object-storage` | `{}` | `[Egress]` | egress | `TCP <port from objectStorage.endpoint>` | `objectStorage.egress` rendered with `toYaml` | `create` and `objectStorage.enabled` | SPEC.md:1018-1021 |
| `krun-jobs-allow-egress-cidrs` | `{}` | `[Egress]` | egress | none (all ports) | one `- ipBlock: { cidr, except }` per `jobsNamespace.egressCIDRs` entry | `create` and the list is non-empty | SPEC.md:1021-1025 |

Rule-3 port parsing: take the URL from `objectStorage.endpoint`; an
explicit `:port` wins; otherwise `https` gives 443 and `http` gives 80
(SPEC.md:1020-1021). Sprig has no URL parser; use `regexFind ":[0-9]+$"`
on the host part after `trimPrefix` of the scheme and `splitList "/"`,
default by `hasPrefix "https://"`. Test both an explicit port
(`http://minio.minio.svc:9000`) and the defaults.

Peer semantics to keep straight (`kubernetes-skill` network-exposure.md
has the long form): `namespaceSelector` and `podSelector` inside one
list item are ANDed (pods matching both); two list items are ORed. The
gateway rule must be ONE item, or the policy would admit every pod in
the krun namespace. `dnsEgress` and `objectStorage.egress` are copied
verbatim so the platform team controls that shape (SPEC.md:1014-1016,
1019-1020).

`except` renders inside `ipBlock` only; the P7.4c acceptance requires a
rendered `except` in `helm template` output (PLAN.md:731), so the chart
test must set at least one entry with `except`.

What the chart does not do here: no per-function egress, no ingress to
function pods (nothing ever connects to a function pod), no rule for the
API server (function pods have `automountServiceAccountToken: false`,
SPEC.md:1032-1033). Per-function extra egress is the platform team's
(SPEC.md:1025-1026).

## krun namespace (`metadata.namespace: {{ .Release.Namespace }}`)

Let `nameInstance` = `{ app.kubernetes.io/name: krun, app.kubernetes.io/instance: {{ .Release.Name }} }`
and `gw` = `{ krun.io/gateway: "true" }` (the gateway Deployment and the
embedded StatefulSet template carry it, SPEC.md:991-992).

| Policy | podSelector | policyTypes | Ports | Peers (`from`) | Condition | SPEC |
|---|---|---|---|---|---|---|
| `krun-deny-ingress` | `nameInstance` | `[Ingress]` | none | none | always | SPEC.md:1051-1052 |
| `krun-allow-public` | `gw` | `[Ingress]` | `TCP 8080` | omit `from` (anywhere) | always | SPEC.md:1053 |
| `krun-allow-internal` | `gw` | `[Ingress]` | `TCP 8081` | `namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ .Values.jobsNamespace.name }} } }` | always | SPEC.md:1053-1054, 982-984 |
| `krun-allow-admin` | `nameInstance` | `[Ingress]` | `TCP 9090`, plus `TCP 9091` when `db.mode == embedded` | `namespaceSelector: {{ .Values.networkPolicy.metricsFrom }}` when non-empty; omit `from` when empty (allows all) | always | SPEC.md:1054-1056 |

`krun-allow-public` selecting `gw` means the scheduler Deployment (which
has no `krun.io/gateway` label) receives nothing on 8080/8081 and only
`metricsFrom` can reach its 9090. In embedded mode the one pod carries
`gw`, so its 8081 is reachable from the jobs namespace and its 9090 and
9091 only from `metricsFrom` (P7.6 asserts both, PLAN.md:741-743).

Ports: use the numeric ports, not names; a named port requires the name
on every selected container and the two admin ports have different
names (`admin`, `admin-sched`).

`networkPolicy.metricsFrom` is a `namespaceSelector` body
(`matchLabels`/`matchExpressions`), not a full peer; wrap it:

```yaml
{{- with .Values.networkPolicy.metricsFrom }}
      from:
        - namespaceSelector:
            {{- toYaml . | nindent 12 }}
{{- end }}
```

## PSA labels on the jobs Namespace (SPEC.md:1010-1012)

```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/enforce-version: {{ .Values.jobsNamespace.podSecurityVersion }}
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/warn-version: {{ .Values.jobsNamespace.podSecurityVersion }}
pod-security.kubernetes.io/audit: restricted
pod-security.kubernetes.io/audit-version: {{ .Values.jobsNamespace.podSecurityVersion }}
```

Plus `helm.sh/resource-policy: keep` when `jobsNamespace.keep`
(SPEC.md:1001-1003). The chart never labels the krun namespace; the
platform team does before `helm install` (SPEC.md:1325-1327,
docs/OPERATIONS.md:16-18) and the P7 e2e creates it labelled
(PLAN.md:657-658).

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

Each of the three LimitRange maps and the quota must carry
`ephemeral-storage` (P7.4a acceptance, PLAN.md:711-713): a function
filling `/tmp` is evicted and classified `evicted` (SPEC.md:1030-1031,
D32). A LimitRange `max` below a Function's requests makes the Job
rejected at admission, which the scheduler classifies as permanent
`job_create_failed` (SPEC.md section 8), so keep the defaults from
section 13 unless the owner changes them.

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

`functions.krun.io` in SPEC prose means `apiGroups: [krun.io]`,
`resources: [functions]` in RBAC. Nothing cluster-wide except the CRD
object (SPEC.md:1041). The Lease rule needs two entries because `create`
cannot carry `resourceNames` (PLAN.md:717-718). No verb on
`secrets` beyond the listed four is granted: `get` serves the
`AlreadyExists` path (read the existing token, SPEC.md:821), `list` the
orphan Secret sweep (SPEC.md:572-573, D11), and there is no `update`,
`patch` or `watch`.

P7.4b check: `--set jobsNamespace.create=false` still renders the
scheduler Role, RoleBinding, `krun-job-default` and `krun-job-viewer`,
and no Namespace, LimitRange, ResourceQuota or NetworkPolicy in the jobs
namespace (PLAN.md:719-721).
