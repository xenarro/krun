# Function informer cache and status writer (SPEC.md:146-162, 776-779; PLAN.md:317-326, 537-541)

Shared module `packages/shared/src/functions/cache.ts` (name proposal),
constructed once per process. The Job/Pod informers are a different module
(`krun-scheduler-k8s` `references/informers.md`); only the client-node
facts overlap.

## 1. Entry shape

```ts
type FunctionEntry = {
  name: string;
  uid: string;
  generation: number;
  resourceVersion: string;
  spec: FunctionSpec;                 // defaults applied by the API server
  result: ValidationResult;           // from validateFunction (references/validation-rules.md)
  status?: FunctionStatus;            // last status seen on the object, for the writer's diff
};
```

- Keep the fields above, not the raw informer object (KEDA strips
  `managedFields`/spec for memory, `pkg/util/cache_transform.go:24-65`;
  Dapr keeps a metadata-only cache, dapr.md:55-56). Functions are few, but
  holding the informer's object graph couples you to its mutation.
- Public reads (proposal): `get(name)` returns the entry only when
  `result.ok` (the "served" map, SPEC.md:149-153); `getAny(name)` returns it
  Ready or not (for `queueTimeout`, SPEC.md:808-811); `list()` for
  `ListFunctions`; `synced: Promise<void>`; `countByReady()` for metrics.

## 2. Construction

```ts
const path = `/apis/krun.io/v1alpha1/namespaces/${ns}/functions`;
const api = kc.makeApiClient(CustomObjectsApi);
const listFn = () => api.listNamespacedCustomObject({ group: 'krun.io', version: 'v1alpha1', namespace: ns, plural: 'functions' });
const informer = makeInformer<FunctionObject>(kc, path, listFn);
```

- No label selector for Functions. If one were ever added it must go BOTH
  into `makeInformer(..., labelSelector)` and into `listFn`; the informer
  only adds it to the watch URL (node-stack-facts.md:366-370, VERIFIED).
- `listNamespacedCustomObject` returns `Promise<any>`; cast to
  `KubernetesListObject<FunctionObject>` (node-stack-facts.md:279-284).
- KubeConfig loading is `packages/shared/src/k8s` (P2.3): in-cluster first,
  default kubeconfig otherwise; one `KubeConfig` shared by every client.

## 3. Event handling

```ts
informer.on('add', upsert);
informer.on('update', upsert);
informer.on('delete', (obj) => { map.delete(obj.metadata.name); observeReady(); });
informer.on('connect', () => { restartDelay = base; });
informer.on('error', onError);

function upsert(obj) {
  const { name, uid, generation, resourceVersion } = obj.metadata;
  const prev = map.get(name);
  if (prev && prev.uid === uid && prev.generation === generation) {
    prev.resourceVersion = resourceVersion;   // status patch or re-list: no recompile
    prev.status = obj.status;
    return afterChange(prev);
  }
  const entry = { name, uid, generation, resourceVersion, spec: obj.spec,
                  status: obj.status, result: validateFunction(obj.spec, ceilings) };
  map.set(name, entry);
  afterChange(entry);
}
```

- The cache key for compilation is `uid + generation` (SPEC.md:147-149).
  `uid` guards against delete-and-recreate with the same name and
  generation 1; `generation` changes only on `spec` edits, never on status
  patches (KEDA relies on the same fact via `GenerationChangedPredicate`,
  `scaledjob_controller.go:86-106`).
- `update` already fires only when `resourceVersion` differs
  (node-stack-facts.md:384-386), but a status patch does change
  `resourceVersion`, so the generation short-circuit above is what the P2.3
  acceptance "a status-only update does not recompile" tests. Prove it by
  injecting a counting `validateFunction` into the module under test.
- Handlers are idempotent; the initial list replays every object through
  `add` (node-stack-facts.md:374-378). Dapr skips initial-list adds as "new"
  events (`pkg/operator/api/informer/informer.go:115-127`); krun has no
  per-event side effect except the status writer, which diffs first, so no
  special-casing is needed.
- `afterChange` recomputes `krun_functions{ready="true"|"false"}` from the
  map (two gauge series, SPEC.md:1145) and notifies the status writer when
  one is registered (scheduler leader only).
- Never log the object; log `{ name, uid, generation, reason }` at info on
  a reason change and at debug otherwise (SPEC.md:1088-1089).

## 4. Start, `synced`, 404 before Established, restart with backoff

```ts
let restartDelay = 1_000; const maxDelay = 60_000;   // proposal; SPEC says only "with backoff"
let timer: NodeJS.Timeout | undefined;
let resolveSynced!: () => void;
const synced = new Promise<void>((r) => { resolveSynced = r; });

async function start() {
  try {
    await informer.start();          // LIST then watch
    markSynced();                    // see note below
  } catch (err) { onError(err); }
}
function onError(err) {
  if (stopped) return;
  const code = err instanceof ApiException ? err.code : undefined;
  const level = err?.name === 'TimeoutError' ? 'debug' : 'warn';
  log[level]({ code, name: err?.name }, 'function informer error, restarting');
  timer = setTimeout(start, restartDelay).unref();
  restartDelay = Math.min(restartDelay * 2, maxDelay);
}
function markSynced() { metrics.functionsSynced.set(1); resolveSynced(); }
async function stop() { stopped = true; clearTimeout(timer); await informer.stop(); }
```

- client-node stops the ListWatch for good on any error other than 410,
  watch `TimeoutError` or a clean close; the caller must call `start()`
  again (node-stack-facts.md:387-397, 869-871, VERIFIED). A LIST failure
  (404 while the CRD is not Established, 403 before RBAC lands) also arrives
  as `error` (node-stack-facts.md:405-407).
- `synced` resolves once, after the first successful LIST, and is never
  rejected; a rejected promise would make `/readyz` throw instead of 503
  (SPEC.md:158-160, 188). Until then `krun_functions_synced` is 0 and the
  `KrunFunctionsNotSynced` alert fires after 2 m (SPEC.md:1396).
- UNVERIFIED: whether `informer.start()` resolves after the LIST completed
  or returns earlier. Check `dist/cache.js` `doneHandler`; if it returns
  early, resolve `synced` from the first `connect` followed by the LIST's
  `add` replay (or an `error`-free tick), and write the test against the
  stubbed informer so the behaviour is pinned either way.
- Reset the delay on `connect` so a flapping API server does not leave the
  informer at the 60 s cap forever; keep `unref()` on the timer so a
  pending restart never blocks process exit.
- Never `process.exit` from the error path; the rest of the gateway keeps
  serving its other listeners and `/readyz` reports the unsynced target
  (Dapr idles the informer on a missing CRD for install-order skew,
  `pkg/operator/api/informer/informer.go:94-113`).
- Do not log watch `TimeoutError`s as failures; the 30 s inactivity timeout
  is by design and reconnects from the last RV (node-stack-facts.md:872-873).

## 5. Metrics (SPEC.md:1144-1145)

| Metric | Type | Labels | Set when |
|---|---|---|---|
| `krun_functions_synced` | gauge | none | 1 after the first successful initial list; starts at 0 |
| `krun_functions` | gauge | `ready` = `"true"`/`"false"` | recomputed after every add/update/delete |

Both processes expose them on the admin listener (`krun-process-runtime`).
No per-function label on either (cardinality rule, keda.md section 4.7).

## 6. Status writer (P4.7, SPEC.md:153-158, 776-779)

```ts
function desiredStatus(e: FunctionEntry) {
  const c = e.result.ok
    ? { type: 'Ready', status: 'True',  reason: 'Valid', message: '' }
    : { type: 'Ready', status: 'False', reason: e.result.reason, message: e.result.message };
  return { observedGeneration: e.generation, conditions: [c] };
}
function needsPatch(e: FunctionEntry) {
  const cur = e.status; const want = desiredStatus(e);
  const cc = cur?.conditions?.find((x) => x.type === 'Ready');
  return cur?.observedGeneration !== want.observedGeneration
      || cc?.status !== want.conditions[0].status
      || cc?.reason !== want.conditions[0].reason
      || cc?.message !== want.conditions[0].message;
}
async function write(e: FunctionEntry) {
  if (!needsPatch(e)) return;
  await api.patchNamespacedCustomObjectStatus(
    { group: 'krun.io', version: 'v1alpha1', namespace: ns, plural: 'functions', name: e.name,
      body: { status: desiredStatus(e) } },
    setHeaderOptions('Content-Type', PatchStrategy.MergePatch));
}
```

- Leader only: constructed and started after Lease acquisition, stopped on
  loss or SIGTERM (SPEC.md:776-779); the gateway never instantiates it and
  its Role has no `status` verb (SPEC.md:1040-1041).
- On start, iterate the whole map once (a new leader converges objects it
  never saw change; Knative enqueues a full pass on promotion,
  `revision/controller.go:71-92`), then subscribe to cache changes.
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
  (node-stack-facts.md:285-295, VERIFIED). No `resourceVersion`, so no 409
  loop for a merge patch (keda.md section 2.3).
- Failures: log warn `{ name, code }`, count nothing new (no metric in SPEC
  for status patches), do not throw; the next event or the 5-minute leader
  reconcile (`krun-scheduler-k8s`) can re-run the pass over the cache.
- Test (PLAN.md:539-541): stub `patchNamespacedCustomObjectStatus` to record
  calls; feed an invalid Function -> one call with `Ready=False` and the
  reason; replay the same event (same uid/generation, and then the update
  carrying the patched status) -> still one call.

## 7. Shutdown and leader loss

| Event | Function informer | Status writer |
|---|---|---|
| process start | start on every replica (SPEC.md:776-777) | not running |
| Lease acquired | unchanged | start, full pass, subscribe |
| Lease lost | unchanged | stop, unsubscribe (no in-flight patch is awaited beyond its own promise) |
| SIGTERM | `stop()`, clear restart timer | stop |
| CRD deleted while running | watch ends with an error -> restart loop with backoff; map keeps the last state until the next successful LIST diff empties it | patches fail 404, logged at warn |
