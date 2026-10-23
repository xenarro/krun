# Function resource and CRD shape (SPEC.md:72-128, PLAN.md:198-212)

Everything here derives from `packages/shared/src/functions/schema.ts`.
Edit the Zod schema, run `make generate`; never hand-edit the three
generated files (SPEC.md:120-128).

## 1. The Function resource (SPEC.md:80-115, verbatim)

```yaml
apiVersion: krun.io/v1alpha1
kind: Function
metadata:
  name: report-generator                   # DNS-1123 label, unique per namespace
spec:
  image: ghcr.io/acme/report@sha256:...    # digest required, tags rejected
  inputSchema:                             # JSON Schema draft 2020-12, at most 64 KiB serialized
    type: object
    required: [from, to]
    properties:
      from: { type: string, format: date }
      to:   { type: string, format: date }
  serviceAccountName: krun-job-default     # optional, default shown; must be in KRUN_ALLOWED_SERVICE_ACCOUNTS
  runAsUser: 65532                         # optional, integer >= 1, CRD default 65532
  runAsGroup: 65532                        # optional, integer >= 1, CRD default 65532
  resources:                               # optional: cpu, memory, ephemeral-storage; LimitRange applies defaults and caps
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: "1",  memory: 512Mi }
  env:                                     # optional, plain values only
    - { name: REPORT_FORMAT, value: pdf }
  secretRefs: [report-secrets]             # optional, envFrom existing Secrets; names matching krun-* rejected
  activeDeadlineSeconds: 3600              # default 3600, max KRUN_MAX_ACTIVE_DEADLINE
  maxConcurrency: 10                       # default 10
  maxQueued: 1000                          # default 1000, max KRUN_MAX_QUEUED
  queueTimeout: 1h                         # default 1h
  heartbeatTimeout: 5m                     # optional; when set, the function must POST status at least this often once running
  nodeSelector: {}                         # optional
  imagePullSecrets: []                     # optional
  callback:                                # optional default webhook
    url: https://hooks.acme.com/krun
status:                                    # written by the scheduler leader only
  observedGeneration: 3
  conditions:
    - { type: Ready, status: "True", reason: Valid, message: "" }
```

## 2. CRD metadata (SPEC.md:74-76, PLAN.md:203-208)

| Field | Value | Source |
|---|---|---|
| `metadata.name` | `functions.krun.io` | SPEC.md:35, 122 |
| `spec.group` | `krun.io` | SPEC.md:74 |
| `spec.scope` | `Namespaced` | SPEC.md:75 |
| `spec.names` | `kind: Function`, `listKind: FunctionList`, `plural: functions`, `singular: function`, `shortNames: [kfn]` | SPEC.md:74-75, D21 |
| `spec.versions[0]` | `name: v1alpha1`, `served: true`, `storage: true` | SPEC.md:74, 1413 |
| `subresources` | `status: {}` | SPEC.md:111, PLAN.md:205 |
| `additionalPrinterColumns` | see section 5 | SPEC.md:76, PLAN.md:205-206 |

No other versions, no conversion strategy block beyond the default `None`
(SPEC.md:1412), no webhook configuration anywhere.

## 3. `spec` properties the generator must emit (SPEC.md:80-118, 132-134)

The spec is a `z.strictObject`; Zod checks map to OpenAPI v3 keywords
(`.min(1)` -> `minLength`/`minimum`, `.int()` -> `type: integer`,
`.regex(DURATION_PATTERN)` -> `pattern`, `.default(v)` -> `default: v`,
`.meta({ description })` -> `description`). `required` is proposed as
`[image, inputSchema]` (see SKILL.md Limitations); everything else
`.optional()` or `.default(...)`, never `.nullable()`.

| Property | Zod / emitted constraints | Default | Notes |
|---|---|---|---|
| `image` | `z.string().min(1)` -> `string`, `minLength: 1` | - | CEL rule below; layer two adds the registry prefix check |
| `inputSchema` | emitted node must be exactly `{ type: object, x-kubernetes-preserve-unknown-fields: true }` | - | opaque to the API server; layer two compiles it with Ajv (SPEC.md:136-138) |
| `serviceAccountName` | `string` | `krun-job-default` | allowlist is layer two (SPEC.md:93, 142-143) |
| `runAsUser` | `integer`, `minimum: 1` | `65532` | SPEC.md:94, PLAN.md:208 |
| `runAsGroup` | `integer`, `minimum: 1` | `65532` | SPEC.md:95 |
| `resources` | `object` with `requests`/`limits`, each `object` of `cpu`, `memory`, `ephemeral-storage` as quantity strings | - | keep as plain strings; no quantity parsing in krun (SPEC.md:96-98) |
| `env` | `array` of `{ name: string (required), value: string (required) }` | - | plain values only, no `valueFrom` (SPEC.md:99-100) |
| `secretRefs` | `array` of `string` | - | `krun-*` rejection is layer two (SPEC.md:101) |
| `activeDeadlineSeconds` | `integer`, `minimum: 1` | `3600` | ceiling is layer two (SPEC.md:102) |
| `maxConcurrency` | `integer`, `minimum: 1` | `10` | SPEC.md:103, 140 |
| `maxQueued` | `integer`, `minimum: 1` | `1000` | ceiling is layer two (SPEC.md:104) |
| `queueTimeout` | `string`, `pattern: ^\d+(ms\|s\|m\|h)$` | `1h` | SPEC.md:105, 117-118 |
| `heartbeatTimeout` | `string`, same pattern | - | >= 30 s is layer two (SPEC.md:106, 140-141) |
| `nodeSelector` | `z.record(z.string(), z.string())` -> `object`, `additionalProperties: { type: string }` | - | SPEC.md:107 |
| `imagePullSecrets` | `array` of `{ name: string }` | - | SPEC.md:108; shape of `LocalObjectReference` |
| `callback` | `object` `{ url: string (required), format: uri }` | - | host allowlist is layer two (SPEC.md:109-110, 144) |

`minimum` for `maxConcurrency` covers "at least 1" at layer one; layer two
re-checks it because `krun validate` runs on files that never met the API
server (SPEC.md:140, 168-169).

Generation details for `scripts/gen-crd.ts` (facts VERIFIED against the
Zod 4.6.7 source, CRD rules from apiextensions as noted in SKILL.md
Limitations):

- Call `z.toJSONSchema(FunctionResource, { target: "openapi-3.0", io:
  "input" })`. With the default `io: "output"` every `.default()` field is
  listed in `required`, which would make the defaults pointless at apply.
- `strictObject` emits `additionalProperties: false` next to `properties`;
  a structural CRD schema does not allow both, so strip it from every
  object node of the CRD output (the API server prunes unknown fields
  instead). Keep it in the editor schema.
- Set the `inputSchema` node, the CEL rule and any other `x-kubernetes-*`
  key either with `.meta({ "x-kubernetes-...": ... })` (meta keys are
  copied verbatim; never put `id` in meta, it moves the node to `$defs`) or
  in the `override` callback / a post-processing walk. Pick one place and
  keep it in `gen-crd.ts` if the keys would otherwise leak into the editor
  schema.
- `openapi-3.0` emits no `$schema` and no `propertyNames`; assert in the
  test that the CRD output contains no `$ref`, `$defs`, `$schema`,
  `propertyNames` or `additionalProperties: false`.
- Keep the spec schema free of `.transform()`; durations stay strings here
  and become `Duration` in layer two.

## 4. CEL rule and defaults (SPEC.md:132-134, PLAN.md:207-208)

```yaml
x-kubernetes-validations:
  - rule: "self.image.contains('@sha256:')"
    message: "spec.image must be pinned by digest (<repo>@sha256:<64 hex>); tags are not accepted"
```

- SPEC requires only "rejects an `image` without `@sha256:`" (SPEC.md:133-134).
  A stricter `matches('^[^@]+@sha256:[a-f0-9]{64}$')` is the Knative-style
  message quality suggestion (knative-serving.md section 2.3); if you tighten
  it, keep the TypeScript mirror in `IMAGE_DIGEST_RULE` identical.
- The rule sits on the `spec` object (`self.image`), so it runs on create
  and every update. `messageExpression` is not needed.
- Defaults live in the schema (`.default()` -> `default:`) so stored objects
  are complete and `kubectl get -o yaml` shows effective values; code
  defaults exist only as a fallback for objects created before a default
  existed (KEDA `scaledobject_types.go:138`, `scale_jobs.go:41-42`).

## 5. Printer columns (SPEC.md:76, PLAN.md:205-206)

```yaml
additionalPrinterColumns:
  - name: READY
    type: string
    jsonPath: '.status.conditions[?(@.type=="Ready")].status'
  - name: IMAGE
    type: string
    jsonPath: .spec.image
  - name: AGE
    type: date
    jsonPath: .metadata.creationTimestamp
```

KEDA adds a `priority: 1` REASON column (keda.md section 3.4); SPEC lists
three columns, so adding REASON needs a Decisions row.

## 6. `status` schema (SPEC.md:111-114, 153-157)

```yaml
status:
  type: object
  properties:
    observedGeneration: { type: integer }
    conditions:
      type: array
      items:
        type: object
        required: [type, status]
        properties:
          type:    { type: string, enum: [Ready] }
          status:  { type: string, enum: ["True", "False", "Unknown"] }
          reason:  { type: string, enum: [Valid, SchemaInvalid, SchemaTooLarge, DeadlineAboveCeiling, QueuedAboveCeiling, RegistryNotAllowed, ServiceAccountNotAllowed, SecretRefNotAllowed, CallbackNotAllowed, InvalidDuration] }
          message: { type: string }
```

Build `reason` as `z.enum(READY_REASONS)` so the CRD enum and the tuple in
`schema.ts` cannot drift; the P0.8 test can still assert the equality
cheaply. Remember the KEDA lesson: adding a reason later is additive
(fine); removing one breaks stored objects on the next apply.

## 7. Chart template wrapper (SPEC.md:123-125, 1365-1369)

```yaml
{{- if .Values.crds.install }}
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: functions.krun.io
  {{- if .Values.crds.keep }}
  annotations:
    helm.sh/resource-policy: keep
  {{- end }}
spec: ... # identical to deploy/crds/functions.krun.io.yaml
{{- end }}
```

Generate the body from the same in-memory object as the plain manifest.
Chart values (`crds.install`, `crds.keep`) and the rest of the chart belong
to `krun-helm-chart` (P7.1 completes the P0.8 stub, PLAN.md:680).

## 8. Editor schema `docs/schemas/function-v1alpha1.json` (SPEC.md:125-126)

A JSON Schema document for the whole resource: `apiVersion` literal
`krun.io/v1alpha1`, `kind` literal `Function`, `metadata` with `name`, and
`spec`/`status` from the same Zod objects, generated with
`z.toJSONSchema(..., { target: "draft-2020-12", io: "input" })`, which sets
`$schema` to draft 2020-12. It is documentation; no process reads it
(SPEC.md:126-127).

## 9. RBAC the CRD implies (SPEC.md:1038-1047)

| Role | Namespace | Verbs on `functions.krun.io` |
|---|---|---|
| scheduler | krun | `get list watch`; plus `functions.krun.io/status` `patch` |
| gateway | krun | `get list watch`, nothing else |
| `krun-function-author` | krun | `get list watch create update patch delete`; rendered without a binding |

The chart renders these (`krun-helm-chart`); this skill only requires that
the status writer never runs in the gateway, whose Role lacks `patch`.

## 10. P0.8 acceptance test outline (PLAN.md:209-212)

An `@effect/vitest` (or plain Vitest; the test does no Effect work) test
next to `scripts/gen-crd.ts` or in `packages/shared/src/functions`:

1. Load `deploy/crds/functions.krun.io.yaml` with `yaml.parse`.
2. Load the chart template, strip the `{{- if ... }}`/`{{- end }}` lines
   (or render with `helm template --set crds.install=true`), parse, and
   assert deep-equal `spec` with the plain manifest.
3. Assert: `spec.scope === 'Namespaced'`; `versions[0].subresources.status`
   exists; `spec.properties.inputSchema['x-kubernetes-preserve-unknown-fields'] === true`;
   the `x-kubernetes-validations[0].rule` contains `@sha256:`;
   `runAsUser.default === 65532 && runAsGroup.default === 65532`;
   `required` lists no defaulted field;
   the READY column `jsonPath` equals `.status.conditions[?(@.type=="Ready")].status`;
   `queueTimeout.pattern` equals `DURATION_PATTERN.source`;
   no `additionalProperties: false`, `$ref`, `$defs`, `$schema` or
   `propertyNames` anywhere in the CRD schema.
4. Separately, in the Makefile/CI: run `make generate` twice and fail on
   `git status --porcelain` output.
