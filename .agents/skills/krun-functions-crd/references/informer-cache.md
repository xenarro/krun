# Function informer cache and status writer (SPEC.md:146-162, 776-779; PLAN.md:336-345, 557-561)

Shared module `packages/shared/src/functions/cache.ts` (name proposal): an
Effect `Functions` service and its layer, built once per process from the
`Kube` service (`packages/shared/src/runtime`). The Job/Pod informers are a
different module (`krun-scheduler-k8s` `references/informers.md`); only the
client-node facts and the `Kube` informer `Stream` overlap.

Effect API names below were checked against `effect` 4.0.6; anything not
listed in SKILL.md "Library facts": check Effect's `MIGRATION.md`.

## 1. Entry shape and service

```ts
type FunctionEntry = {
  readonly name: string;
  readonly uid: string;
  readonly generation: number;
  readonly resourceVersion: string;
  readonly spec: FunctionSpec;            // z.infer of the spec schema; defaults applied by the API server
  readonly result: ValidationResult;      // from validateFunction (references/validation-rules.md)
  readonly status?: FunctionStatus;       // last status seen on the object, for the writer's diff
};

export class Functions extends Context.Service<Functions, {
  readonly get: (name: string) => Effect.Effect<Option.Option<FunctionEntry>>;    // served: result.ok only
  readonly getAny: (name: string) => Effect.Effect<Option.Option<FunctionEntry>>; // Ready or not, for queueTimeout
  readonly list: Effect.Effect<ReadonlyArray<FunctionEntry>>;                     // ListFunctions, served only, by name
  readonly synced: Effect.Effect<void>;                                           // Deferred.await
  readonly isSynced: Effect.Effect<boolean>;                                      // Deferred.isDone, for /readyz
  readonly changes: Stream.Stream<FunctionEntry>;                                 // for the status writer
}>()("krun/Functions") {}
```

- Keep the fields above, not the raw informer object (KEDA strips
  `managedFields`/spec for memory, `pkg/util/cache_transform.go:24-65`;
  Dapr keeps a metadata-only cache, dapr.md:55-56). Functions are few, but
  holding the informer's object graph couples you to its mutation.
- The map is a `Ref<ReadonlyMap<string, FunctionEntry>>` (or a
  `SubscriptionRef` if `changes` is derived from it); handlers replace
  entries, never mutate them. `changes` can equally be a `PubSub` the
  handler publishes to; pick one and test it.
- `get` returns the entry only when `result.ok` (the "served" map,
  SPEC.md:149-153); `getAny` returns it Ready or not (for `queueTimeout`,
  SPEC.md:808-811); `list` feeds `ListFunctions` (docs/API.md 3.1: Ready
  only, ordered by `name`); the key-glob filter is the gateway's job.

## 2. Construction

```ts
export const FunctionsLive = Layer.effect(Functions, Effect.gen(function* () {
  const kube = yield* Kube;
  const config = yield* Config;                       // ceilings + KRUN_NAMESPACE
  const map = yield* Ref.make<ReadonlyMap<string, FunctionEntry>>(new Map());
  const synced = yield* Deferred.make<void>();
  const events = kube.informer<FunctionObject>({      // Stream of add/update/delete (+ a synced marker)
    path: `/apis/krun.io/v1alpha1/namespaces/${config.namespace}/functions`,
    list: (api) => api.customObjects.listNamespacedCustomObject({
      group: 'krun.io', version: 'v1alpha1', namespace: config.namespace, plural: 'functions' }),
  });
  yield* events.pipe(
    Stream.tapError(logInformerError),
    Stream.retry(restartSchedule),
    Stream.runForEach(handle),                        // section 3
    Effect.forkScoped,                                // dies with the layer scope (SIGTERM)
  );
  return Functions.of({ /* get, getAny, list, synced: Deferred.await(synced), ... */ });
}));
```

- The `Kube.informer` shape above is a proposal; `krun-process-runtime`
  and `krun-scheduler-k8s` own the `Kube` service. Underneath it is
  `Stream.callback` around `makeInformer(kc, path, listFn)`: acquisition
  registers the `add`/`update`/`delete`/`error` handlers and calls
  `start()`, the finalizer calls `stop()`, an `error` event fails the queue
  with a `KubeApiError` carrying the status.
- No label selector for Functions. If one were ever added it must go BOTH
  into `makeInformer(..., labelSelector)` and into `listFn`; the informer
  only adds it to the watch URL (docs/research/node-stack-facts.md:366-370, VERIFIED).
- `listNamespacedCustomObject` returns `Promise<any>`; cast to
  `KubernetesListObject<FunctionObject>` (docs/research/node-stack-facts.md:279-284).
- KubeConfig loading is `packages/shared/src/k8s` (P2.3): in-cluster first,
  default kubeconfig otherwise; one `KubeConfig` shared by every client,
  provided to the `Kube` layer.

## 3. Event handling

```ts
const handle = (ev: InformerEvent<FunctionObject>) => Effect.gen(function* () {
  switch (ev._tag) {
    case 'Synced': return yield* markSynced;                       // section 4
    case 'Delete': yield* Ref.update(map, (m) => without(m, ev.obj.metadata.name)); break;
    case 'Add': case 'Update': yield* upsert(ev.obj); break;
  }
  yield* afterChange;                                              // metrics, changes
});

const upsert = (obj: FunctionObject) => Ref.update(map, (m) => {
  const { name, uid, generation, resourceVersion } = obj.metadata;
  const prev = m.get(name);
  const entry = prev && prev.uid === uid && prev.generation === generation
    ? { ...prev, resourceVersion, status: obj.status }               // status patch or re-list: no recompile
    : { name, uid, generation, resourceVersion, spec: obj.spec, status: obj.status,
        result: validateFunction(obj.spec, ceilings) };
  return withEntry(m, name, entry);
});
```

- The cache key for compilation is `uid + generation` (SPEC.md:147-149).
  `uid` guards against delete-and-recreate with the same name and
  generation 1; `generation` changes only on `spec` edits, never on status
  patches (KEDA relies on the same fact via `GenerationChangedPredicate`,
  `scaledjob_controller.go:86-106`).
- `update` already fires only when `resourceVersion` differs
  (docs/research/node-stack-facts.md:384-386), but a status patch does change
  `resourceVersion`, so the generation short-circuit above is what the P2.3
  acceptance "a status-only update does not recompile" tests. Prove it by
  injecting a counting `validateFunction` into the layer under test.
- Handlers are idempotent; the initial list replays every object through
  `add` (docs/research/node-stack-facts.md:374-378), and so does every retry of the
  stream. Dapr skips initial-list adds as "new" events
  (`pkg/operator/api/informer/informer.go:115-127`); krun has no per-event
  side effect except the status writer, which diffs first, so no
  special-casing is needed.
- `afterChange` recomputes `krun_functions{ready="true"|"false"}` from the
  map (two gauge series, SPEC.md:1145) and publishes the changed entry to
  `changes` (read only by the scheduler leader's status writer).
- Never log the object; log `{ name, uid, generation, reason }` at info on
  a reason change and at debug otherwise (SPEC.md:1088-1089).

## 4. Start, `synced`, 404 before Established, retry with backoff

```ts
// proposal; SPEC says only "with backoff"
const restartSchedule = Schedule.exponential('1 second').pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(60)))),
);
const markSynced = Effect.gen(function* () {
  if (yield* Deferred.succeed(synced, undefined)) metrics.functionsSynced.set(1);
});
const logInformerError = (e: KubeApiError) =>
  e.name === 'TimeoutError' ? Effect.logDebug('function informer timeout, restarting', { code: e.status })
                            : Effect.logWarning('function informer error, restarting', { code: e.status });
```

- client-node stops the ListWatch for good on any error other than 410,
  watch `TimeoutError` or a clean close; something must start it again
  (docs/research/node-stack-facts.md:387-397, 869-871, VERIFIED). Here that is
  `Stream.retry`: it re-runs the stream's acquisition (a fresh `start()`)
  on every failure. A LIST failure (404 while the CRD is not Established,
  403 before RBAC lands) also arrives as a stream failure
  (docs/research/node-stack-facts.md:405-407).
- `Stream.retry` resets the schedule once an element flows again, which is
  the old "reset the delay on `connect`": a flapping API server does not
  leave the informer at the 60 s cap forever.
- `synced` is a `Deferred<void>` completed once, after the first successful
  LIST, and never failed: a failed `synced` would make `/readyz` fail
  instead of answering 503 (SPEC.md:158-160, 188). Readiness reads
  `isSynced` into its `Ref`; the scheduler's start gate awaits `synced`.
  Until then `krun_functions_synced` is 0 and the `KrunFunctionsNotSynced`
  alert fires after 2 m (SPEC.md:1396).
- UNVERIFIED: whether `informer.start()` resolves after the LIST completed
  or returns earlier. Check `dist/cache.js` `doneHandler`; if it returns
  early, emit the `Synced` marker from the first `connect` followed by the
  LIST's `add` replay, and write the test against the stubbed `Kube` layer
  so the behaviour is pinned either way.
- Never `Effect.die` or exit from the error path; the rest of the gateway
  keeps serving its other listeners and `/readyz` reports the unsynced
  target (Dapr idles the informer on a missing CRD for install-order skew,
  `pkg/operator/api/informer/informer.go:94-113`). The retrying stream has
  no terminal failure, so the forked fiber only ends on scope close.
- Do not log watch `TimeoutError`s as failures; the 30 s inactivity timeout
  is by design and reconnects from the last RV (docs/research/node-stack-facts.md:872-873).
- Tests: `it.effect` with a stub `Kube` layer whose informer `Stream` the
  test drives (a `Queue` turned into a stream); fail it, then
  `TestClock.adjust('1 second')` and assert a second acquisition. No
  `setTimeout`, no real sleeps.

## 5. Metrics (SPEC.md:1144-1145)

| Metric | Type | Labels | Set when |
|---|---|---|---|
| `krun_functions_synced` | gauge | none | 1 after the first successful initial list; starts at 0 |
| `krun_functions` | gauge | `ready` = `"true"`/`"false"` | recomputed after every add/update/delete |

Both processes expose them on the admin listener through `prom-client`
(`krun-process-runtime`; Effect `Metric` is not used). No per-function
label on either (cardinality rule, keda.md section 4.7).

## 6. Status writer (P4.7, SPEC.md:153-158, 776-779)

```ts
const desiredStatus = (e: FunctionEntry) => {
  const c = e.result.ok
    ? { type: 'Ready', status: 'True',  reason: 'Valid', message: '' }
    : { type: 'Ready', status: 'False', reason: e.result.reason, message: e.result.message };
  return { observedGeneration: e.generation, conditions: [c] };
};
const needsPatch = (e: FunctionEntry) => {
  const cur = e.status; const want = desiredStatus(e);
  const cc = cur?.conditions?.find((x) => x.type === 'Ready');
  return cur?.observedGeneration !== want.observedGeneration
      || cc?.status !== want.conditions[0].status
      || cc?.reason !== want.conditions[0].reason
      || cc?.message !== want.conditions[0].message;
};
const write = (e: FunctionEntry) => needsPatch(e)
  ? kube.call((api) => api.customObjects.patchNamespacedCustomObjectStatus(
      { group: 'krun.io', version: 'v1alpha1', namespace: ns, plural: 'functions', name: e.name,
        body: { status: desiredStatus(e) } },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch))).pipe(
      Effect.catchTag('KubeApiError', (err) =>
        Effect.logWarning('function status patch failed', { name: e.name, code: err.status })))
  : Effect.void;

// leader scope: full pass, then follow changes
const statusWriter = Effect.gen(function* () {
  const fns = yield* Functions;
  yield* Effect.forEach(yield* fns.listAll, write, { discard: true });
  yield* fns.changes.pipe(Stream.runForEach(write));
});
```

- `kube.call` stands for the `Kube` service's wrapper (semaphore,
  `Effect.timeout('10 seconds')`, `Effect.tryPromise` mapping to
  `KubeApiError`); its real name is set by `krun-process-runtime`.
  `listAll` (every entry, Ready or not) is a proposal; add it to the
  service only for the writer.
- Leader only: forked into the leader scope after Lease acquisition and
  interrupted with it on loss or SIGTERM (SPEC.md:776-779); the gateway
  never builds it and its Role has no `status` verb (SPEC.md:1040-1044).
- On start, iterate the whole map once (a new leader converges objects it
  never saw change; Knative enqueues a full pass on promotion,
  `revision/controller.go:71-92`), then follow `changes`. Subscribe before
  the full pass (or accept one duplicate check) so no change between the
  two is lost; `needsPatch` makes duplicates free.
- The diff is against the object's own `status` as seen by the informer,
  not against an in-memory "last written" value, so a status wiped by
  `kubectl edit` or a lost patch is repaired on the next event
  (Knative compares `original.Status` vs desired, `revision/reconciler.go:279-300`;
  KEDA `pkg/scaling/scale_handler.go:461-466`).
- `observedGeneration` is written on every patch, including `Ready=False`
  (Knative `reconcile_common.go:74-82`): clients tell "rejected" from
  "not yet seen".
- Content-Type MUST be overridden: the generated client defaults to
  `application/json-patch+json` and a merge body is rejected
  (docs/research/node-stack-facts.md:285-295, VERIFIED). No `resourceVersion`, so no 409
  loop for a merge patch (keda.md section 2.3).
- Failures: log warn `{ name, code }`, count nothing new (no metric in SPEC
  for status patches), never fail the writer fiber; the next event or the
  5-minute leader reconcile (`krun-scheduler-k8s`) can re-run the pass over
  the cache.
- Test (PLAN.md:559-561): stub `Kube` layer recording patch calls; feed an
  invalid Function -> one call with `Ready=False` and the reason; replay
  the same event (same uid/generation, and then the update carrying the
  patched status) -> still one call.

## 7. Shutdown and leader loss

| Event | Function informer | Status writer |
|---|---|---|
| process start | layer built on every replica (SPEC.md:776-777) | not running |
| Lease acquired | unchanged | forked into the leader scope, full pass, follow `changes` |
| Lease lost | unchanged | interrupted with the leader scope (an in-flight patch is interrupted with it) |
| SIGTERM | layer scope closes: consumer fiber interrupted, informer `stop()` in the finalizer | interrupted first (leader scope closes before the app layers) |
| CRD deleted while running | stream fails -> `Stream.retry` with backoff; map keeps the last state until the next successful LIST replay diff empties it | patches fail 404, logged at warn |

Note on the last row: a re-list replays `add` for objects that exist but
emits no `delete` for ones that vanished while the watch was down unless
client-node's cache diff does so; check `dist/cache.js` and, if it does
not, rebuild the map from the LIST result on each `Synced` marker.
