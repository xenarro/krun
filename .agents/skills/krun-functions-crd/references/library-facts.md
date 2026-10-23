# Library facts and prior art for Functions

Source: docs/research/node-stack-facts.md; VERIFIED/UNVERIFIED kept per
fact. For Effect names not listed here, check Effect's `MIGRATION.md`.

## client-node

- `makeInformer(kc, path, listFn, labelSelector?)` returns `Informer &
  ObjectCache`. `start()` LISTs, then watches. On any error other than
  410/`TimeoutError`/clean close it emits `error` and STOPS: the caller
  restarts it. No resync exists. `update` fires only when `resourceVersion`
  differs (VERIFIED, docs/research/node-stack-facts.md:362-407).
- UNVERIFIED: whether `start()` resolves only after the LIST completed.
  Read `dist/cache.js` before building `synced` on it (fallback in
  `informer-cache.md` section 4).
- `ApiException { code, body, headers }` for non-2xx. LIST 404 before the
  CRD is Established surfaces as `error` with `code === 404` (VERIFIED,
  docs/research/node-stack-facts.md:304-312, 405-407). The `Kube` service
  maps it to `KubeApiError` with the status.
- `CustomObjectsApi.*NamespacedCustomObject*` return `Promise<any>`. Type
  the object as `z.infer<typeof FunctionSpec>` inside a `FunctionObject`
  type. The API server already validated it: do not re-parse on every
  event (VERIFIED, docs/research/node-stack-facts.md:279-284).

## ajv, ajv-formats, yaml

- ajv: `import { Ajv2020 } from 'ajv/dist/2020.js'`. `compile` is
  synchronous when no `$async` and all `$ref`s resolve locally. An unknown
  `$ref` throws `MissingRefError`; still walk the schema first, so a remote
  `$ref` is reported deterministically (VERIFIED,
  docs/research/node-stack-facts.md:706-720). Ajv caches by object
  identity, so the uid+generation cache must hold the compiled function
  itself (docs/research/node-stack-facts.md:722-724).
- ajv-formats under ESM has a default-export wrapping quirk
  (`mod.default?.default ?? mod.default ?? mod`; VERIFIED,
  docs/research/node-stack-facts.md:710-714).
- yaml: `parseAllDocuments` for multi-doc files; `doc.errors` non-empty =
  invalid; `parse()` throws on multi-doc input (VERIFIED,
  docs/research/node-stack-facts.md:771-776).

## Zod 4.6 `z.toJSONSchema` (VERIFIED against the 4.6.7 source)

- `strictObject` always emits `additionalProperties: false`.
- With the default `io: "output"` a field with `.default()` lands in
  `required`; with `io: "input"` it stays optional.
- `target: "openapi-3.0"` emits no `$schema` and no `propertyNames` for
  records.
- `.meta({...})` keys are copied verbatim into the node. An `id` key
  extracts the node into `$defs`, so never use `id`.
- The `override` callback can rewrite any node.

## Effect 4.0.6 (VERIFIED against the package source)

`Stream.callback`, `Stream.retry` (re-runs acquisition, resets after the
first element), `Schedule.exponential`, `Schedule.modifyDelay`,
`Deferred`, `SubscriptionRef.changes`, `PubSub`,
`Effect.forkScoped`/`forkIn`. `TestClock` is imported from
`effect/testing`.

## Prior art: Knative Serving, KEDA, Dapr

Lesson, then the krun rule it backs.

- Bump `observedGeneration` on every status write, including
  `Ready=False`, so a client can tell "rejected" from "not seen yet"
  (serving `vendor/knative.dev/pkg/reconciler/reconcile_common.go:74-82`).
- `krun deploy`'s 120 s wait (SPEC.md:756) must require
  `observedGeneration == metadata.generation && Ready=True`; else a stale
  `True` from the previous spec satisfies it instantly
  (`pkg/apis/serving/v1/revision_lifecycle.go:70-84`). Tell `krun-sdk-cli`.
- A missing `Ready` condition is Unknown, never True or False
  (`vendor/knative.dev/pkg/apis/condition_types.go:88-109`).
- Never mutate informer-cache objects. Build the desired status from a
  copy and diff before patching; that stops informer churn
  (`revision/reconciler.go:279-300`; KEDA `pkg/scaling/scale_handler.go:461-466`).
- Status patches do not bump `generation`. KEDA filters them out with
  `GenerationChangedPredicate` (`scaledjob_controller.go:86-106`); krun's
  uid+generation key is the same guard, applied in the handler.
- Put constant defaults in the CRD `default:` so stored objects are
  complete and CEL sees them; KEDA had to inline a Go default into a CEL
  rule (`scaledobject_types.go:101`). When adding an `enum` later, include
  the implicit default, or stored objects fail the next apply (KEDA
  `CHANGELOG.md:106`).
- Serving has no CEL and validates in a webhook; krun has CEL and no
  webhook. Copy only the message shape: `<message>: <path1>, <path2>` plus
  a details line, canonical phrases `missing field(s)`, `invalid value: X`,
  `expected lo <= v <= hi` (`vendor/knative.dev/pkg/apis/field_error.go:265-277,393-480`).
- Dapr idles the informer with a warning when the CRD is absent instead of
  crashing (`pkg/operator/api/informer/informer.go:94-113`). krun's
  404-retry keeps the rest of the process serving the same way.
