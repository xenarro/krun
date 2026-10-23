---
name: krun-functions-crd
description: Use when touching krun Function CRD, schema or informer. Keeps one TypeBox source, two validation layers and a cached informer map.
---

# krun Function CRD, validation, informer cache, status writer

Covers SPEC.md section 3 (Functions): the `functions.krun.io/v1alpha1`
resource, the TypeBox schema that generates the CRD, the two validation
layers, the per-process informer cache, the leader-only `Ready` status
writer and `krun validate`. Serves PLAN tasks P0.8, P2.2, P2.3, P2.5, P4.7;
read by P3.2/P3.3 (gateway fields) and P4.3b (scheduler fields).

## When to use

- Editing `packages/shared/src/functions/*` (schema, validation, informer
  cache), `scripts/gen-crd.ts`, `deploy/crds/functions.krun.io.yaml`,
  `deploy/helm/krun/templates/crd-functions.yaml`,
  `docs/schemas/function-v1alpha1.json`, `packages/shared/src/k8s/*` or
  `packages/cli/src/validate.ts`.
- Adding a Function field, a validation rule or a `Ready` reason.
- Debugging 404 `FUNCTION_NOT_FOUND` for an applied Function, readiness
  stuck at 503, or status-patch storms.
- Not for Job/Pod informers, Lease or main loop (`krun-scheduler-k8s`),
  create-run admission (`krun-gateway-api`), the chart (`krun-helm-chart`)
  or `krun init`/`krun deploy` (`krun-sdk-cli`).

## Read first

- SPEC.md:72-174 (section 3, all of it), 19-24 (non-goals), 188
  (`/readyz`), 335 and 808-811 (`queueTimeout` of a deleted or invalid
  Function), 776-781 (informer on every replica, writer leader-only),
  848-852 (no resync), 944-948 (no ReDoS guard), 1034-1044 (RBAC),
  1091-1094 (digest only), 1144-1145 (metrics), 1199-1214 (the five ceiling
  variables), 1366-1369 (CRD as chart template), 1410-1413 (additive-only),
  D17/D21/D22/D26/D33 (SPEC.md:1458-1474).
- PLAN.md:178-191 (P0.8), 310-316 (P2.2), 317-326 (P2.3), 332-342 (P2.5),
  537-541 (P4.7), 804-805 (`REPLACE_WITH_DIGEST`), 38-41 (erasable syntax),
  48-67 (dependencies), 87-88 and 101-104 (layout).
- References here: `references/crd-shape.md` (resource YAML, CRD
  properties, defaults, columns, status schema, chart wrapper, P0.8 test),
  `references/validation-rules.md` (rule -> reason -> P2.2 case, Ajv setup,
  ceilings, `krun validate` output), `references/informer-cache.md` (entry
  shape, handlers, compile key, restart, `synced`, metrics, status writer).
- Siblings: `krun-scheduler-k8s` (its `../krun-scheduler-k8s/references/informers.md` holds the
  shared client-node facts and the 5-minute reconcile), `krun-gateway-api`
  (consumer of the cache), `krun-store` (`expireQueued`), `krun-development`.

## Rules

1. `packages/shared/src/functions/schema.ts` (TypeBox) is the single source
   of the CRD `openAPIV3Schema`, the TypeScript type and the editor JSON
   Schema; `scripts/gen-crd.ts` writes `deploy/crds/functions.krun.io.yaml`,
   derives `deploy/helm/krun/templates/crd-functions.yaml` from it, and
   writes `docs/schemas/function-v1alpha1.json`; nothing hand-edits the
   generated files, `make generate` twice leaves no diff and CI fails on a
   diff (SPEC.md:120-128, PLAN.md:178-191, 118-123).
2. `krun validate` and both processes import the schema module and never
   read the generated files (SPEC.md:126-127), so the binary is self-contained.
3. Resource identity is fixed: group `krun.io`, version `v1alpha1`, kind
   `Function`, plural `functions`, short name `kfn`, namespaced in
   `KRUN_NAMESPACE`, printer columns READY/IMAGE/AGE, status subresource
   (SPEC.md:74-76, PLAN.md:183-185, D21); no extra columns, versions or a
   registry ConfigMap (D17).
4. Layer one is the API server: required fields, types, enums, minimums,
   the duration pattern `^\d+(ms|s|m|h)$`, one CEL rule rejecting `image`
   without `@sha256:`, CRD defaults (65532 for `runAsUser`/`runAsGroup`),
   `x-kubernetes-preserve-unknown-fields: true` on `inputSchema`
   (SPEC.md:117-118, 132-134, PLAN.md:186-187). krun has no admission
   webhook; anything the schema cannot express goes to layer two.
5. Layer two is ONE pure function (`validateFunction(obj, ceilings)`), no
   I/O, no env reads, no DNS: it returns either a compiled validator or a
   `{reason, message}` with a reason from the closed enum `Valid
   SchemaInvalid SchemaTooLarge DeadlineAboveCeiling QueuedAboveCeiling
   RegistryNotAllowed ServiceAccountNotAllowed SecretRefNotAllowed
   CallbackNotAllowed InvalidDuration` (SPEC.md:135-144, 154-157,
   PLAN.md:310-313); ceilings are an argument so `krun validate` shares it.
6. `inputSchema` compiles with `new Ajv2020({ strict: true })` plus
   ajv-formats, synchronous `compile` only, never `loadSchema`; any `$ref`
   (or `$dynamicRef`) not starting with `#` is rejected before compiling;
   serialized size is at most 64 KiB (SPEC.md:136-138). `pattern` regexes
   are trusted, no ReDoS guard (SPEC.md:948) - do not add one.
7. Each process keeps an in-memory map keyed by `metadata.name`; the
   compiled validator is cached per `metadata.uid` + `metadata.generation`;
   status patches and re-lists (same generation) never recompile
   (SPEC.md:146-149, PLAN.md:319-320, 325-326).
8. A Function that fails layer two stays in the map but is not served:
   gateway answers 404 `FUNCTION_NOT_FOUND` with the generic message, the
   scheduler claims nothing for it, and only `queueTimeout` is still read
   from it when it parses (SPEC.md:149-153, 808-811); the reason is visible
   only on the `Ready` condition.
9. Only the scheduler leader writes Function status: condition `Ready` with
   the reason, patched through `CustomObjectsApi` on the status subresource
   only when `observedGeneration` or the condition changes; the gateway's
   Role has no `status` verb at all (SPEC.md:153-158, 776-779, 1038-1041,
   PLAN.md:537-541).
10. Readiness of both processes waits for the informer's initial list; a
    failed initial list (404 before the CRD is Established) is retried with
    backoff while `/readyz` stays 503; the `error` handler restarts the
    watch with backoff because client-node informers stop for good on error
    (SPEC.md:158-162, 188, PLAN.md:320-322, D33 SPEC.md:1474). Never exit
    the process on an informer error.
11. Field split: gateway uses `name`, `inputSchema`, `maxQueued`,
    `callback` (default copied into the run at create when the request has
    none); the scheduler uses everything else (SPEC.md:164-166).
12. `krun validate <path>...` runs layer one's schema and layer two over
    Function documents in files or directories, builds ceilings from the
    five section 3 variables with section 12 defaults, prints the values
    used on stderr, prints one line per function on stdout and exits 1 on
    any error; `krun deploy` calls the same code (SPEC.md:168-174,
    PLAN.md:332-342). `image: REPLACE_WITH_DIGEST` fails with a clear
    message (SPEC.md:747, PLAN.md:804-805). No flags except `--help`
    (SPEC.md:1178).
13. CRD `v1alpha1` is additive-only: new fields optional with defaults; a
    breaking change opens `v1alpha2` by a Decisions row, no conversion
    webhook in v1, `v1alpha1` stays `served: true, storage: true`
    (SPEC.md:1410-1413).
14. Dependencies here are exactly `@sinclair/typebox`, `ajv`, `ajv-formats`,
   `yaml`, `@kubernetes/client-node` 2.x, `prom-client` (PLAN.md:53-65); a
   CEL evaluator, schema-walker package or CRD generator needs a Decisions
   row (PLAN.md:29-30).
15. Erasable syntax only: the reason list is a `const` tuple + union type,
   never an `enum`; no parameter properties (PLAN.md:38-41).

## Single source and generation chain

```
schema.ts (TypeBox spec + status + reason tuple + IMAGE_DIGEST rule + DURATION pattern)
  -> scripts/gen-crd.ts
       -> deploy/crds/functions.krun.io.yaml          (plain CRD, committed)
       -> deploy/helm/krun/templates/crd-functions.yaml (same object inside
          `{{- if .Values.crds.install }}`, `helm.sh/resource-policy: keep`
          when `crds.keep`; SPEC.md:123-125, 1366-1369)
       -> docs/schemas/function-v1alpha1.json         (editor schema)
```

- Generate the chart template FROM the plain manifest object so the two can
  never diverge (SPEC.md:122-124).
- Export `DURATION_PATTERN`, `IMAGE_DIGEST_RULE` (regex + CEL + message) and
  `READY_REASONS` beside the schema; CEL, layer two and tests share them.
- P0.8 test outline and the property/default table: `references/crd-shape.md`
  sections 3-4 and 10. `make generate` must be byte-stable (sorted keys,
  LF, no timestamps).

## Two validation layers

| Layer | Where | Catches | Reports as |
|---|---|---|---|
| 1 CRD + CEL | API server at apply; `krun validate` (Ajv over the TypeBox JSON + mirrored digest rule) | required, types, enums, minimums, duration pattern, digest | apply error / validate line |
| 2 pure function | informer handler in both processes; `krun validate` | compile, size, `$ref`, ceilings, allowlists, `krun-*` secretRefs, callback host | `Ready=False` reason; public 404 |

- Check order, reason per rule and the P2.2 case per rule:
  `references/validation-rules.md`. First failing rule wins.
- Callback host check calls the P2.1 host-glob matcher in
  `packages/shared/src/webhook` (PLAN.md:313); with
  `KRUN_WEBHOOK_ALLOWED_HOSTS` empty any `callback.url` is
  `CallbackNotAllowed` (SPEC.md:1214, PLAN.md:338-340). No DNS in layer two.
- `krun validate` applies CRD defaults before layer two (as the API server
  does in-cluster): a missing `serviceAccountName` is `krun-job-default` (SPEC.md:93).

## Informer cache (P2.3)

- One module `{ kc, namespace, ceilings, logger, metrics }` used identically
  by gateway and scheduler; pseudocode in `references/informer-cache.md`.
  `makeInformer(kc, '/apis/krun.io/v1alpha1/namespaces/<ns>/functions',
  listFn)`, `listFn` = `CustomObjectsApi.listNamespacedCustomObject`.
- Handlers: `add`/`update` -> same `uid+generation` reuses the entry (no
  compile; refresh `resourceVersion` and cached status), otherwise run
  `validateFunction` and replace it; `delete` removes; recompute
  `krun_functions{ready}` after each event.
- `synced`: resolved once after the first successful initial list, never
  rejected; `/readyz` and the scheduler's start gate await it
  (SPEC.md:158-160, 188); set `krun_functions_synced` to 1 then.
- `error` handler: warn (debug for watch `TimeoutError`), then
  `setTimeout(() => informer.start(), delay)` doubling to a cap, reset on
  `connect`; a LIST 404 before the CRD is Established takes the same path.
  `stop()` on SIGTERM clears the restart timer.

## Status writer (P4.7)

- Leader only: started after Lease acquisition, stopped on loss
  (SPEC.md:776-779); on start it walks the whole cache once (a new leader
  converges objects it never observed), then follows cache events.
- Desired status `{ observedGeneration: metadata.generation, conditions:
  [{ type: 'Ready', status, reason, message }] }` is compared field by field
  with the cached object's own `status`, never a local "last written"
  memory; patch only when different (SPEC.md:157-158, PLAN.md:538-541).
- Patch call: `CustomObjectsApi.patchNamespacedCustomObjectStatus({ group:
  'krun.io', version: 'v1alpha1', namespace, plural: 'functions', name,
  body: { status } }, setHeaderOptions('Content-Type',
  PatchStrategy.MergePatch))`. Without the header override the client sends
  `application/json-patch+json` and the API server rejects the body
  (node-stack-facts.md:285-295, VERIFIED).
- The resulting informer `update` carries the same generation: no recompile
  (rule 7), desired == cached, no second patch - that is the P4.7 "repeated
  event" acceptance. Patch errors: warn with `name` and `code`, never throw;
  the next event or leader pass retries. Messages never include
  `inputSchema` contents or a full `callback.url`.

## Library facts (node-stack-facts.md, kept VERIFIED/UNVERIFIED)

- `makeInformer(kc, path, listFn, labelSelector?)` returns `Informer &
  ObjectCache`; `start()` LISTs then watches; on any error other than
  410/`TimeoutError`/clean close it emits `error` and STOPS - the caller
  restarts it; no resync exists; `update` fires only when `resourceVersion`
  differs (VERIFIED, node-stack-facts.md:362-407). Whether `start()`
  resolves only after the LIST completed is UNVERIFIED: read
  `dist/cache.js` before building `synced` on it (fallback in
  `references/informer-cache.md` section 4).
- `ApiException { code, body, headers }` for non-2xx; LIST 404 before the
  CRD is Established surfaces as `error` with `code === 404` (VERIFIED,
  node-stack-facts.md:304-312, 405-407).
- `CustomObjectsApi.*NamespacedCustomObject*` return `Promise<any>`: type
  the object from `Static<typeof FunctionSchema>` (VERIFIED, node-stack-facts.md:279-284).
- ajv: `import { Ajv2020 } from 'ajv/dist/2020.js'`; `compile` is synchronous
  when no `$async` and all `$ref`s resolve locally; an unknown `$ref` throws
  `MissingRefError` - still walk the schema first so a remote `$ref` is
  reported deterministically (VERIFIED, node-stack-facts.md:706-720). Ajv
  caches by object identity, so the uid+generation cache must hold the
  compiled function itself (node-stack-facts.md:722-724).
- ajv-formats under ESM has a default-export wrapping quirk
  (`mod.default?.default ?? mod.default ?? mod`; VERIFIED for the Fastify
  provider, node-stack-facts.md:710-714). yaml: `parseAllDocuments` for
  multi-doc files, `doc.errors` non-empty = invalid; `parse()` throws on
  multi-doc input (VERIFIED, node-stack-facts.md:771-776).
- SPEC RISK (TypeBox line): PLAN.md:53 allows `@sinclair/typebox` +
  `@fastify/type-provider-typebox`, but provider 6.x peers on `typebox@1`
  and rejects `@sinclair/typebox`; the last provider line for
  `@sinclair/typebox` is 5.2.0 with `@sinclair/typebox >=0.26 <=0.34`
  (node-stack-facts.md:436-455, VERIFIED). `schema.ts` only needs the
  TypeBox core, but the pin is shared with the gateway: do not pick; add a
  Decisions row (PLAN.md:23-30) or write BLOCKED before installing.

## Lessons from Knative Serving and KEDA

- Bump `observedGeneration` on every status write, including `Ready=False`,
  so a client can tell "rejected" from "not seen yet" (serving
  `vendor/knative.dev/pkg/reconciler/reconcile_common.go:74-82`).
- `krun deploy`'s 120 s wait (SPEC.md:756) must require
  `observedGeneration == metadata.generation && Ready=True`, else a stale
  `True` from the previous spec satisfies it instantly
  (`pkg/apis/serving/v1/revision_lifecycle.go:70-84`); tell `krun-sdk-cli`.
- A missing `Ready` condition is Unknown, never True or False
  (`vendor/knative.dev/pkg/apis/condition_types.go:88-109`).
- Never mutate informer-cache objects; build the desired status from a copy
  and diff before patching, which is what stops informer churn
  (`revision/reconciler.go:279-300`; KEDA `pkg/scaling/scale_handler.go:461-466`).
- Status patches do not bump `generation`; KEDA filters them out with
  `GenerationChangedPredicate` (`scaledjob_controller.go:86-106`). krun's
  uid+generation key is the same guard, applied in the handler.
- Put constant defaults in the CRD `default:` so stored objects are complete
  and CEL sees them; KEDA had to inline a Go default into a CEL rule
  (`scaledobject_types.go:101`). When adding an `enum` later include the
  implicit default or stored objects fail the next apply (KEDA `CHANGELOG.md:106`).
- Serving has no CEL and validates in a webhook; krun has CEL and no
  webhook. Copy only the message shape: `<message>: <path1>, <path2>` plus a
  details line, canonical phrases `missing field(s)`, `invalid value: X`,
  `expected lo <= v <= hi` (`vendor/knative.dev/pkg/apis/field_error.go:265-277,393-480`).
- Dapr idles the informer with a warning when the CRD is absent instead of
  crashing (`pkg/operator/api/informer/informer.go:94-113`); krun's 404-retry
  keeps the rest of the process serving the same way.

## Pitfalls

- Reasons are a closed enum; do not add `Reconciling`, `NotReady` or
  `InvalidImage` (SPEC.md:154-157). The first observation of a Function gets
  its real result, not an Unknown placeholder.
- SPEC.md:84 says `metadata.name` is a DNS-1123 label; Serving enforces
  DNS-1035 (letter-first). SPEC wins; add no name CEL rule without a
  Decisions row.
- `kubectl get functions` is ambiguous beside OpenFaaS/Fission; use
  `functions.krun.io` or `kfn` in docs and scripts (SPEC.md:77-78).
- A deleted Function's queued runs expire with the 1 h default; nothing
  cascades (SPEC.md:335, 808-811).
- Keep only the fields the processes need per entry, not the raw informer
  object (`references/informer-cache.md` section 1).
- `krun validate` never consults the cluster or `KRUN_NAMESPACE`; it is a
  file tool for CI in function repositories (SPEC.md:168-170).
- `kubernetes-operator` (installed skill) is Go/controller-runtime with
  webhooks, finalizers and conversion; krun has none of those and
  hand-rolled loops. Use it for CRD design vocabulary only.
- Never log `inputSchema`, `env` values, `callback.url` or whole Function
  objects; log `name`, `uid`, `generation`, `reason` (SPEC.md:1088-1089).

## Before marking a task done

- P0.8: `make generate` twice -> `git status --porcelain` empty; the CRD
  parse test passes; `make helm-lint` passes (PLAN.md:188-191).
- P2.2: table test, one invalid case per rule incl. non-compiling schema,
  65 KiB schema, `heartbeatTimeout: 5s`, remote `$ref`, forbidden service
  account (PLAN.md:313-316); checklist in `references/validation-rules.md`.
- P2.3: stubbed-informer test: invalid Function absent from the served map,
  delete reflected, status-only update does not recompile (PLAN.md:323-326).
- P2.5: fixture with one valid + one tag-image function -> two lines, exit 1;
  `callback.url` fixture fails `CallbackNotAllowed` by default and passes
  with `KRUN_WEBHOOK_ALLOWED_HOSTS`; after `make docker`, `docker run -v
  "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml` prints its line
  and exits 1 (PLAN.md:337-342).
- P4.7: stubbed API: invalid Function gets `Ready=False` with the reason; a
  repeated event causes no second patch (PLAN.md:539-541).
- Then `make check`, mark `[x]`, append `2026-MM-DD P<n> <sha> note` to
  PLAN.md section 6, commit on branch `p0-8-...`, Conventional Commit with
  scope (`feat(shared): ...`, `feat(cli): ...`), PR to main, merge when CI
  is green; no `Co-Authored-By` (PLAN.md:13-22, CLAUDE.md:7).

## Limitations

- SPEC names no `Ready` reason for `maxConcurrency < 1` or the
  `heartbeatTimeout >= 30s` floor (SPEC.md:140, 154-157); this skill maps
  the floor to `InvalidDuration` and leaves `maxConcurrency` to the CRD
  `minimum` - record a Decisions row if a reason is needed.
- SPEC does not fix the `krun validate` line format, the exit code when a
  path contains no Function documents, or the informer restart backoff
  constants; proposals in the references are marked as such.
- The condition carries exactly `type status reason message` (SPEC.md:114);
  `lastTransitionTime` is not in SPEC and not added here.
- Whether `inputSchema` is `required` in the CRD is not stated in
  SPEC.md:80-115; `references/crd-shape.md` proposes `[image, inputSchema]`
  - confirm before P0.8 or note it in the progress log.
