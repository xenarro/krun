---
name: krun-functions-crd
description: Use when touching krun Function CRD, schema or informer. Keeps one Zod source for CRD and editor schema, two validation layers and an Effect Functions service over the informer Stream.
---

# krun Function CRD, validation, informer cache, status writer

Scope: SPEC.md section 3 (Functions). The `functions.krun.io/v1alpha1`
resource, the Zod schema that generates the CRD, two validation layers,
the per-process informer cache (Effect `Functions` service), the
leader-only `Ready` status writer, `krun validate`. PLAN P0.8, P2.2, P2.3,
P2.5, P4.7; read by P3.2/P3.3 (gateway fields) and P4.3b (scheduler
fields).

## When to use

- Editing `packages/shared/src/functions/*` (schema, validation, informer
  cache), `scripts/gen-crd.ts`, `deploy/crds/functions.krun.io.yaml`,
  `deploy/helm/krun/templates/crd-functions.yaml`,
  `docs/schemas/function-v1alpha1.json`, `packages/shared/src/k8s/*` or
  `packages/cli/src/validate.ts`.
- Adding a Function field, validation rule or `Ready` reason.
- Debugging 404 `FUNCTION_NOT_FOUND` for an applied Function, readiness
  stuck at 503, or status-patch storms.
- Not for Job/Pod informers, Lease or main loop (`krun-scheduler-k8s`),
  create-run admission (`krun-gateway-api`), the chart (`krun-helm-chart`),
  `krun init`/`krun deploy` (`krun-sdk-cli`).

## Read first

- SPEC.md:72-174 (section 3, all of it); 19-24 (non-goals); 188
  (`/readyz`); 335 and 808-811 (`queueTimeout` of a deleted or invalid
  Function); 776-781 (informer on every replica, writer leader-only);
  847-853 (no resync); 944-948 (no ReDoS guard); 1048-1062 (RBAC);
  1107-1109 (digest only); 1141-1177 (metrics, spans); 1229-1247 (the five
  ceiling variables); 1419-1423 (CRD as chart template); 1466-1468
  (additive-only); D17/D21/D22/D26/D33/D35 (SPEC.md:1505-1540).
- docs/API.md section 2.1 and 3.1-3.2: the `Function` resource as served
  (read-only, Ready functions only, generic 404).
- docs/STACK.md sections 2 and 4: Zod for every own schema, Ajv only for
  `inputSchema`, `Kube` service, informers as `Stream`s, `Clock`, tests.
- PLAN.md:198-212 (P0.8), 329-335 (P2.2), 336-345 (P2.3), 351-362 (P2.5),
  557-561 (P4.7), 824-825 (`REPLACE_WITH_DIGEST`), 42-44 (erasable
  syntax), 36-90 (dependencies), 103-104 and 121 (layout).
- Stack skills: `zod-4` (vendored); user-level `effect-*` (Effect 4
  overrides apply, see `krun-development`); `kubernetes-operator` for
  vocabulary only.
- Siblings: `krun-scheduler-k8s` (`../krun-scheduler-k8s/references/informers.md`:
  shared client-node facts, 5-minute reconcile); `krun-process-runtime`
  (`Kube` service, readiness `Ref`, Config layer); `krun-gateway-api`
  (cache consumer); `krun-store` (`expireQueued`); `krun-development`.

| Reference | Holds |
|---|---|
| `references/crd-shape.md` | resource YAML, CRD properties, defaults, columns, status schema, Zod-to-CRD generation, chart wrapper, P0.8 test |
| `references/validation-rules.md` | rule, reason and P2.2 case per row; Ajv setup; ceilings; `krun validate` output |
| `references/informer-cache.md` | entry and service shape, event handling, compile key, retry, `synced`, metrics, status writer |
| `references/library-facts.md` | client-node, ajv, yaml, Zod, Effect facts (VERIFIED/UNVERIFIED); Knative, KEDA, Dapr lessons |

## Rules

1. `packages/shared/src/functions/schema.ts` (Zod 4, the spec as a
   `z.strictObject`) is the single source of the CRD `openAPIV3Schema`,
   the TypeScript type (`z.infer`) and the editor JSON Schema.
   `scripts/gen-crd.ts` uses `z.toJSONSchema` (`target: "openapi-3.0"` for
   the CRD, `target: "draft-2020-12"` for the editor schema). It writes
   `deploy/crds/functions.krun.io.yaml`, derives
   `deploy/helm/krun/templates/crd-functions.yaml` from it, and writes
   `docs/schemas/function-v1alpha1.json`. Never hand-edit generated files.
   `make generate` twice leaves no diff; CI fails on a diff
   (SPEC.md:120-128, PLAN.md:198-212, 135-141).
2. `krun validate` and both processes import the schema module and never
   read the generated files (SPEC.md:126-127): the binary is
   self-contained.
3. Resource identity is fixed: group `krun.io`, version `v1alpha1`, kind
   `Function`, plural `functions`, short name `kfn`, namespaced in
   `KRUN_NAMESPACE`, printer columns READY/IMAGE/AGE, status subresource
   (SPEC.md:74-76, PLAN.md:203-206, D21). No extra columns, versions or a
   registry ConfigMap (D17).
4. Layer one is the API server: required fields, types, enums, minimums,
   duration pattern `^\d+(ms|s|m|h)$`, one CEL rule rejecting `image`
   without `@sha256:`, CRD defaults (65532 for `runAsUser`/`runAsGroup`),
   `x-kubernetes-preserve-unknown-fields: true` on `inputSchema`
   (SPEC.md:117-118, 132-134, PLAN.md:206-207). krun has no admission
   webhook; anything the schema cannot express goes to layer two.
5. Layer two is ONE pure function, `validateFunction(spec, ceilings)`: no
   I/O, no env reads, no DNS, no `Clock`. It returns either a compiled
   validator or `{reason, message}`, reason from the closed enum
   `Valid SchemaInvalid SchemaTooLarge DeadlineAboveCeiling
   QueuedAboveCeiling RegistryNotAllowed ServiceAccountNotAllowed
   SecretRefNotAllowed CallbackNotAllowed InvalidDuration` (SPEC.md:135-144,
   154-157, PLAN.md:329-332). Ceilings are an argument so `krun validate`
   shares it. It is a plain function returning a discriminated union, not
   an Effect; callers wrap it with `Effect.sync` where needed.
6. `inputSchema` compiles with `new Ajv2020({ strict: true })` plus
   ajv-formats, synchronous `compile` only, never `loadSchema`. Reject any
   `$ref` (or `$dynamicRef`) not starting with `#` before compiling.
   Serialized size at most 64 KiB (SPEC.md:136-138). This is the only use
   of Ajv in krun; krun's own Function schema is Zod, never compiled with
   Ajv. `pattern` regexes are trusted: no ReDoS guard (SPEC.md:948); do
   not add one.
7. Each process keeps an in-memory map keyed by `metadata.name`. The
   compiled validator is cached per `metadata.uid` + `metadata.generation`;
   status patches and re-lists (same generation) never recompile
   (SPEC.md:146-149, PLAN.md:337-339, 343-345).
8. A Function failing layer two stays in the map but is not served: the
   gateway answers 404 `FUNCTION_NOT_FOUND` with the generic message
   (docs/API.md 3.2), `ListFunctions` omits it, the scheduler claims
   nothing for it. Only `queueTimeout` is still read from it, when it
   parses (SPEC.md:149-153, 808-811). The reason is visible only on the
   `Ready` condition.
9. Only the scheduler leader writes Function status: condition `Ready`
   with the reason, patched through `CustomObjectsApi` (via the `Kube`
   service) on the status subresource, only when `observedGeneration` or
   the condition changes. The gateway's Role has no `status` verb at all
   (SPEC.md:153-158, 776-779, 1048-1062, PLAN.md:557-561).
10. Readiness of both processes waits for the informer's initial list. A
    failed initial list (404 before the CRD is Established) is retried
    with backoff while `/readyz` stays 503. A failed watch is restarted
    with backoff, because client-node informers stop for good on error
    (SPEC.md:158-162, 188, PLAN.md:338-341, D33). In Effect: wrap the
    informer `Stream` in `Stream.retry` with an exponential `Schedule`;
    never let it fail the layer. Never exit the process on an informer
    error.
11. Field split: the gateway uses `name`, `inputSchema`, `maxQueued`,
    `callback` (default copied into the run at create when the request has
    none), and renders the read-only `Function` resource of docs/API.md
    2.1 (`maxConcurrency`, `queueTimeout`, `activeDeadlineSeconds`,
    `heartbeatTimeout` too). The scheduler uses everything else
    (SPEC.md:164-166).
12. `krun validate <path>...` runs layer one (the Zod spec schema plus the
    mirrored digest rule) and layer two over Function documents in files
    or directories. It builds ceilings from the five section 3 variables
    with section 12 defaults through the same Zod config parsers, prints
    the values used on stderr, prints one line per function on stdout, and
    exits 1 on any error. `krun deploy` calls the same code
    (SPEC.md:168-174, PLAN.md:351-362). `image: REPLACE_WITH_DIGEST` fails
    with a clear message (SPEC.md:747, PLAN.md:824-825). No flags except
    `--help`.
13. CRD `v1alpha1` is additive-only: new fields optional with defaults. A
    breaking change opens `v1alpha2` by a Decisions row. No conversion
    webhook in v1; `v1alpha1` stays `served: true, storage: true`
    (SPEC.md:1466-1468).
14. Dependencies are exactly `zod`, `effect`, `ajv`, `ajv-formats`,
    `yaml`, `@kubernetes/client-node` 2.x (only through the `Kube`
    service). The two Function metrics are Effect `Metric`s from the shared
    `Metrics` service, exported by `krun-process-runtime`'s telemetry layer
    (PLAN.md section 2, docs/STACK.md section 2). A CEL evaluator,
    schema-walker package, CRD generator or Effect Schema needs a Decisions
    row (PLAN.md:29-30).
15. Erasable syntax only: the reason list is a `const` tuple + union type
    (`z.enum(READY_REASONS)` in the status schema), never a TS `enum`. No
    parameter properties (PLAN.md:42-44).
16. No `Date.now()`, `new Date()` or `setTimeout` in this module. Backoff
    is a `Schedule`, timestamps come from `Clock`, tests advance time with
    `TestClock.adjust` (CLAUDE.md rule 8, docs/STACK.md 4.4).

## Single source and generation chain

```
schema.ts (Zod spec + status + READY_REASONS tuple + IMAGE_DIGEST rule + DURATION_PATTERN)
  -> scripts/gen-crd.ts  (z.toJSONSchema, io: "input")
       -> deploy/crds/functions.krun.io.yaml          (plain CRD, target openapi-3.0, committed)
       -> deploy/helm/krun/templates/crd-functions.yaml (same object inside
          `{{- if .Values.crds.install }}`, `helm.sh/resource-policy: keep`
          when `crds.keep`; SPEC.md:123-125, 1419-1423)
       -> docs/schemas/function-v1alpha1.json         (editor schema, target draft-2020-12)
```

- Generate the chart template FROM the plain manifest object, so the two
  never diverge (SPEC.md:122-124).
- Export `DURATION_PATTERN`, `IMAGE_DIGEST_RULE` (regex + CEL + message)
  and `READY_REASONS` beside the schema; CEL, layer two and tests share
  them.
- Keep the spec schema transform-free: durations stay strings matching
  `DURATION_PATTERN`. `z.toJSONSchema` cannot represent transforms in
  output mode, and the CRD wants the wire shape. Parse durations into
  `Duration` in layer two.
- Zod output needs post-processing to become a valid structural CRD
  schema (`additionalProperties: false` from `strictObject`, the
  `inputSchema` node, CEL, defaults): `references/crd-shape.md` section 3.
- P0.8 test outline and property/default table: `references/crd-shape.md`
  sections 3-4 and 10. `make generate` must be byte-stable (sorted keys,
  LF, no timestamps).

## Two validation layers

| Layer | Where | Catches | Reports as |
|---|---|---|---|
| 1 CRD + CEL | API server at apply; `krun validate` (Zod `safeParse` of the spec schema + mirrored digest rule) | required, types, enums, minimums, duration pattern, digest | apply error / validate line |
| 2 pure function | informer handler in both processes; `krun validate` | compile, size, `$ref`, ceilings, allowlists, `krun-*` secretRefs, callback host | `Ready=False` reason; public 404 |

- Check order, reason and P2.2 case per rule:
  `references/validation-rules.md`. First failing rule wins.
- Callback host check calls the P2.1 host-glob matcher in
  `packages/shared/src/webhook` (PLAN.md:332). With
  `KRUN_WEBHOOK_ALLOWED_HOSTS` empty, any `callback.url` is
  `CallbackNotAllowed` (SPEC.md:1247, PLAN.md:356-358). No DNS in layer
  two.
- `krun validate` applies CRD defaults before layer two, as the API server
  does in-cluster: parsing with the Zod schema yields the `.default()`
  values, so a missing `serviceAccountName` is `krun-job-default`
  (SPEC.md:93).
- `z.strictObject` rejects unknown fields in `krun validate`. In-cluster
  the API server prunes them instead (`kubectl` rejects them under its
  default strict field validation). That asymmetry is accepted.

## Informer cache (P2.3)

Details and code: `references/informer-cache.md`.

- One Effect service `Functions` (`Context.Service`), built by a layer
  from `{ Kube, Config (ceilings, KRUN_NAMESPACE), Logger, Metrics }`,
  used identically by gateway and scheduler. The informer comes from the
  `Kube` service as a `Stream` of add/update/delete events over
  `/apis/krun.io/v1alpha1/namespaces/<ns>/functions`, with
  `CustomObjectsApi.listNamespacedCustomObject` as the list function.
- Handlers: `add`/`update` with the same `uid+generation` reuses the entry
  (no compile; refresh `resourceVersion` and cached status); otherwise run
  `validateFunction` and replace it. `delete` removes. Recompute
  `krun_functions{ready}` after each event.
- `synced`: a `Deferred<void>` completed once after the first successful
  initial list, never failed. `/readyz` reads it (through the readiness
  `Ref`); the scheduler's start gate awaits it (SPEC.md:158-160, 188). Set
  `krun_functions_synced` to 1 then.
- Failure: the stream fails with a tagged `KubeApiError` (status code
  attached). `Stream.retry` with `Schedule.exponential`, capped by
  `Schedule.modifyDelay`, re-runs the stream's acquisition (a fresh
  `informer.start()`); the schedule resets once an element flows again.
  Log warn (debug for watch `TimeoutError`). A LIST 404 before the CRD is
  Established takes the same path. The consumer fiber is forked into the
  layer's scope, so SIGTERM (scope close) stops the informer through its
  finalizer.

## Status writer (P4.7)

Details and code: `references/informer-cache.md` section 6.

- Leader only: a fiber forked into the leader scope after Lease
  acquisition, interrupted with that scope on loss (SPEC.md:776-779). On
  start it walks the whole cache once (a new leader converges objects it
  never observed), then follows the cache's change `Stream`.
- Desired status `{ observedGeneration: metadata.generation, conditions:
  [{ type: 'Ready', status, reason, message }] }` is compared field by
  field with the cached object's own `status`, never a local "last
  written" memory. Patch only when different (SPEC.md:157-158,
  PLAN.md:558-561).
- Patch through the `Kube` service (semaphore, 10 s timeout):
  `CustomObjectsApi.patchNamespacedCustomObjectStatus({ group: 'krun.io',
  version: 'v1alpha1', namespace, plural: 'functions', name, body: { status
  } }, setHeaderOptions('Content-Type', PatchStrategy.MergePatch))`.
  Without the header override the client sends
  `application/json-patch+json` and the API server rejects the body
  (docs/research/node-stack-facts.md:285-295, VERIFIED).
- The resulting informer `update` carries the same generation: no
  recompile (rule 7), desired == cached, no second patch. That is the P4.7
  "repeated event" acceptance. On a patch error, catch the `KubeApiError`,
  warn with `name` and `code`, never fail the writer fiber; the next event
  or leader pass retries. Messages never include `inputSchema` contents or
  a full `callback.url`.

## Pitfalls

- Reasons are a closed enum: add no `Reconciling`, `NotReady` or
  `InvalidImage` (SPEC.md:154-157). The first observation of a Function
  gets its real result, not an Unknown placeholder.
- SPEC.md:84 says `metadata.name` is a DNS-1123 label; Serving enforces
  DNS-1035 (letter-first). SPEC wins. Add no name CEL rule without a
  Decisions row.
- `kubectl get functions` is ambiguous beside OpenFaaS/Fission. Use
  `functions.krun.io` or `kfn` in docs and scripts (SPEC.md:77-78).
- A deleted Function's queued runs expire with the 1 h default; nothing
  cascades (SPEC.md:335, 808-811).
- Keep only the fields the processes need per entry, not the raw informer
  object (`references/informer-cache.md` section 1).
- `krun validate` never consults the cluster or `KRUN_NAMESPACE`. It is a
  file tool for CI in function repositories (SPEC.md:168-170).
- `kubernetes-operator` (vendored skill) is Go/controller-runtime with
  webhooks, finalizers and conversion. krun has none of those and
  hand-rolled loops. Use it for CRD design vocabulary only.
- Do not reach for Effect Schema (`effect-schema` skill) for the Function
  shape or as a `z.toJSONSchema` alternative: Zod is the only schema
  language (docs/STACK.md principle 2).
- Never log `inputSchema`, `env` values, `callback.url` or whole Function
  objects. Log `name`, `uid`, `generation`, `reason` (SPEC.md:1181-1186).

## Before marking a task done

- P0.8: `make generate` twice, then `git status --porcelain` is empty; the
  CRD parse test passes; `make helm-lint` passes (PLAN.md:208-212).
- P2.2: table test, one invalid case per rule, including non-compiling
  schema, 65 KiB schema, `heartbeatTimeout: 5s`, remote `$ref`, forbidden
  service account (PLAN.md:332-335). Checklist:
  `references/validation-rules.md`.
- P2.3: `@effect/vitest` `it.effect` test with a stub `Kube` layer whose
  informer `Stream` the test feeds: invalid Function absent from the
  served map, delete reflected, status-only update does not recompile, a
  failing stream retried after `TestClock.adjust` (PLAN.md:341-345).
- P2.5: fixture with one valid + one tag-image function gives two lines,
  exit 1. `callback.url` fixture fails `CallbackNotAllowed` by default and
  passes with `KRUN_WEBHOOK_ALLOWED_HOSTS`. After `make docker`, `docker run -v
  "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml` prints its line
  and exits 1 (PLAN.md:355-362).
- P4.7: stub `Kube` layer recording patches. Invalid Function gets
  `Ready=False` with the reason; a repeated event causes no second patch
  (PLAN.md:559-561).
- Phase 2 gate: `pnpm exec vitest run packages/shared/src/webhook
  packages/shared/src/functions packages/shared/src/auth` (PLAN.md:317).
- Then `make check`, mark `[x]`, append `2026-MM-DD P<n> <sha> note` to
  PLAN.md section 6, commit on branch `p0-8-...`, Conventional Commit with
  scope (`feat(shared): ...`, `feat(cli): ...`), PR to main, merge when CI
  is green. No `Co-Authored-By` (PLAN.md:13-22, CLAUDE.md rule 5).

## Limitations

- SPEC names no `Ready` reason for `maxConcurrency < 1` or the
  `heartbeatTimeout >= 30s` floor (SPEC.md:140, 154-157). This skill maps
  the floor to `InvalidDuration` and leaves `maxConcurrency` to the CRD
  `minimum`. Record a Decisions row if a reason is needed.
- SPEC does not fix the `krun validate` line format, the exit code when a
  path holds no Function documents, or the informer retry backoff
  constants. Proposals in the references are marked as such.
- The condition carries exactly `type status reason message`
  (SPEC.md:114). `lastTransitionTime` is not in SPEC and not added here.
- SPEC.md:80-115 does not state whether `inputSchema` is `required` in the
  CRD. `references/crd-shape.md` proposes `[image, inputSchema]`: confirm
  before P0.8 or note it in the progress log.
- That Kubernetes rejects `additionalProperties` beside `properties` in a
  structural schema is from memory of apiextensions validation, not
  re-verified. P0.8 needs no cluster: check the generated CRD with
  `kubectl apply --dry-run=server` the first time kind is up (Phase 4),
  and fix the generator if the API server rejects it.
- UNVERIFIED: whether client-node `start()` resolves only after the LIST
  completed (`references/library-facts.md`; fallback in
  `references/informer-cache.md` section 4).
