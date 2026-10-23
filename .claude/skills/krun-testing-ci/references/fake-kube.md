# Kubernetes test doubles: the fake `Kube` layer and `test/fake-kube`

krun has two Kubernetes doubles with different jobs:

| Double | Speed and time | Used for |
|---|---|---|
| fake `Kube` layer (Effect `Layer`) | in-process, `TestClock` | every scheduler unit test: P4.2 leader, P4.3a limiter and classification, P4.3b main loop, P4.3c cancel, P4.4 informers and terminal path, P4.5 `job_lost`, P4.7 status writer, P4.8 failure detection, P4.9 heartbeat, P4.10 sweep (PLAN.md:488-591); P2.3 Function informer (PLAN.md:336-345) |
| `test/fake-kube` HTTP server | real sockets, real time | process tests that start `bin/krun.js` with `KUBECONFIG` at it: P3.7, P4.6, P4.11 (PLAN.md:432-441, 552-556, 592-599) |

Where PLAN says "stubbed `CoordinationV1Api`" or "stubbed `BatchV1Api` and
`CoreV1Api`" the krun form is the fake `Kube` layer: every Kubernetes call
in application code goes through the `Kube` service (STACK.md:72, 179-186),
so a test replaces the service, not the client-node classes.

## Part 1: the fake `Kube` layer

The `Kube` service interface is owned by `krun-scheduler-k8s` (shared
`KubeConfig` loading in `packages/shared/src/k8s`, PLAN.md:104). The fake
implements the same `Context.Service`:

```ts
// apps/scheduler/src/k8s/testing/FakeKube.ts (test-only, never imported by src)
import { Effect, Layer, Queue, Ref } from "effect"

export type Action = readonly [verb: "get" | "list" | "create" | "update" | "patch" | "delete" | "log",
                               resource: string, name: string]

export interface Script {
  // first matching rule answers instead of the store, once unless `times` is set
  readonly fail?: ReadonlyArray<{ verb: Action[0]; resource: string; error: KubeApiError; times?: number }>
  readonly hang?: ReadonlyArray<{ verb: Action[0]; resource: string }>   // Effect.never: proves Effect.timeout
}

export const FakeKube = {
  layer: (seed: Seed, script: Script = {}) => Layer.effect(Kube, Effect.gen(function*() {
    const objects = yield* Ref.make(seed.objects)          // Map<"kind/ns/name", object>
    const actions = yield* Ref.make<ReadonlyArray<Action>>([])
    const events = yield* Queue.unbounded<InformerEvent>()  // the test offers add/update/delete/error/synced
    // every method: record the action, apply the script, else read/write `objects`
    // informers: Stream.fromQueue(events) filtered by kind and label selector
    return Kube.of({ /* ... */ })
  })),
}
// plus a FakeKubeControl service from the same layer (Layer.provideMerge)
// exposing `actions`, `objects`, `emit(event)` for assertions
```

Rules for the fake:

- Record `[verb, resource, name]` before answering, including failed and
  hung calls: the assertion is the ordered list (SKILL.md rule 9).
- Failures are the same tagged errors the real adapter produces:
  `KubeApiError` with `status` (and `reason`, `retryAfter` for 429), plus
  the timeout/network failure the adapter maps from `TimeoutError`
  (STACK.md:168-171). The fake never throws.
- `AlreadyExists` (409 with reason), `NotFound` (404) and `Conflict` (409
  on a stale `resourceVersion` for Lease `update`) come from the store
  semantics, not from scripts, so the happy-path rows exercise them.
- `hang` returns `Effect.never`; the code under test bounds it with
  `Effect.timeout` (10 s per call, STACK.md:180). The test forks, then
  `TestClock.adjust("10 seconds")`, then asserts the timeout failure and
  that the in-flight slot was released (P4.3a "at most 8 calls in flight").
- No real time: the fake reads `Clock` for `creationTimestamp` and
  `renewTime`, so `TestClock` drives them.

### Table-driven reconciler rows

The knative-serving `TableTest` shape (`vendor/knative.dev/pkg/reconciler/
testing/table.go:44-113`) with `it.effect.each`:

```ts
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

const rows = [
  { name: "run already terminal: deletes only", seed: terminalRun, key: RUN,
    want: [["delete", "secrets", SECRET], ["delete", "jobs", JOB]] },
  { name: "Secret AlreadyExists is read", seed: secretPresent, key: RUN,
    want: [["create", "secrets", SECRET], ["get", "secrets", SECRET], ["create", "jobs", JOB]] },
  { name: "422 on Job create fails job_create_failed", seed: queuedRun, key: RUN,
    script: { fail: [{ verb: "create", resource: "jobs", error: unprocessable }] },
    want: [["create", "secrets", SECRET], ["create", "jobs", JOB], ["delete", "secrets", SECRET]],
    wantRun: { state: "failed", failureReason: "job_create_failed" } },
] as const

it.effect.each(rows)("main loop: $name", (row) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(FIXED_EPOCH)                 // fixed clock per row
    yield* iteration(row.key)
    const ctl = yield* FakeKubeControl
    expect(yield* ctl.actions).toStrictEqual(row.want)    // exact, ordered
    if ("wantRun" in row) expect(yield* storeRun(row.key)).toMatchObject(row.wantRun)
  }).pipe(Effect.provide(TestLayers(row.seed, row.script))))  // fresh layer per row
```

- Canonical first rows for every reconciler-style loop: bad id, row
  missing, already terminal, happy path; then one row per induced failure
  asserting which actions still happened (knative-serving
  `pkg/reconciler/revision/table_test.go:62-135`).
- Provide a fresh layer per row (`Effect.provide`), not a shared
  `layer(...)` block: shared state between rows hides ordering bugs.
- `TestLayers` merges `FakeKube.layer`, the in-memory `Store` layer, the
  fake object store and a `Config` layer; every service the loop needs is
  a layer, nothing is a module mock.
- The ordered list is where SPEC's sequences are proven: terminal path
  object-store check, compare-and-set, Secret delete, Job delete
  (SPEC.md:863-875); heartbeat log fetch, foreground Job delete,
  transition, Secret delete (SPEC.md:906-911); fetch before delete, always
  (SPEC.md:898-899).

### Loops, informers and leases under `TestClock`

- Fork the loop (`Effect.forkChild`), let it reach its first sleep
  (`Effect.yieldNow`), then `TestClock.adjust`, then assert; adjusting
  before the fork advances nothing.
- Coalesced notifies (P4.3b "two notifies during an iteration yielding one
  more"): offer two notifies to the loop's sliding `Queue` of capacity 1
  while a hung call holds the iteration, release it, adjust, assert
  exactly two iterations in the action log (STACK.md:183).
- 10 s iteration deadline: hang one call, `TestClock.adjust("10 seconds")`,
  assert the remaining claims were released (`Effect.ensuring`,
  STACK.md:184).
- Informer sync gates (D33, SPEC.md:1474): the heartbeat loop and the
  `job_lost` check must not act before the fake emits the initial-list
  event; a row adjusts past several heartbeat periods first and asserts no
  action.
- Informer restart: emit a non-timeout error event; assert the code
  re-subscribes after its backoff (`TestClock.adjust` by the backoff).
- Lease (P4.2, SPEC.md:783-792): seed the Lease held by `other`; adjust
  15 s with no `renewTime` change observed and assert acquisition by
  `update` with the read `resourceVersion`; a scripted 409 retries after
  2 s; a leader whose renew fails for 10 s ends its leader scope
  (informers stopped, visible in the action log) and the exit is asserted
  as a typed failure of the leader layer, not a real `process.exit`.
  Expiry is judged from the last observed change on the local clock, never
  by comparing `renewTime` with now: a row that seeds an old `renewTime`
  but keeps changing it must stay standby.

## Part 2: `test/fake-kube` (process tests)

`test/fake-kube/` is an `http.createServer` Kubernetes API over in-memory
objects (PLAN.md:126). It speaks enough of the real API for
`@kubernetes/client-node` 2.x to list, watch, create, update and delete the
objects krun touches, so P3.7, P4.6 and P4.11 can start the real
`bin/krun.js` with `KUBECONFIG` pointing at it. Dapr's integration
framework does the same with an `http.ServeMux` (dapr
`tests/integration/framework/process/kubernetes/kubernetes.go:46-70`).

### Shape

```
test/fake-kube/
  server.ts        start({ namespace, jobsNamespace }) -> { url, kubeconfigPath, store, close() }
  store.ts         Map<kind, Map<"ns/name", object>> with resourceVersion counter and watchers
  routes.ts        path table below
  kubeconfig.ts    writes a kubeconfig file with insecure-skip-tls-verify: true
  scripts.ts       behaviours a test turns on: completeJobs, holdLease, rejectCreate, breakWatch, hang
  index.ts         exports start and the scripted behaviours
  server.test.ts   the fake's own Vitest tests (list, watch streaming, 409, 404)
```

The fake is plain TypeScript (`node:http`, no Effect, no dependency): it is
test infrastructure, not application code, so it may use `Date` for
`creationTimestamp` (CLAUDE.md rule 8 binds application code). Vitest
compiles it; the krun process under test only talks to it over HTTP. It
never ships in the image (`.dockerignore` lists `test/`). `server.test.ts`
runs in the root Vitest project (SKILL.md "Runner and type checking").

### Kubeconfig

`loadFromDefault` reads `$KUBECONFIG` first. Write:

```yaml
apiVersion: v1
kind: Config
clusters: [{ name: fake, cluster: { server: http://127.0.0.1:<port>, insecure-skip-tls-verify: true } }]
users: [{ name: fake, user: { token: fake-token } }]
contexts: [{ name: fake, context: { cluster: fake, user: fake, namespace: <namespace> } }]
current-context: fake
```

`insecure-skip-tls-verify: true` is required (see "client-node facts").
The token is a constant placeholder, not a secret (PLAN.md:33); the fake
ignores `Authorization`.

### Endpoint table

Every list response is `{ apiVersion, kind: "<Kind>List", metadata: {
resourceVersion }, items }`. Every object carries
`metadata.resourceVersion` (a global incrementing integer as a string),
`metadata.uid`, `metadata.creationTimestamp`. Errors are Kubernetes
`Status` objects with `code` and `reason` so `ApiException.body.reason`
reads `AlreadyExists`, `NotFound`, `Conflict`.

| Path | Verbs | Needed by | Semantics |
|---|---|---|---|
| `/apis/krun.io/v1alpha1/namespaces/{ns}/functions` | GET (list, `?watch=1`) | P3.7, P4.11 Function informer (`krun-functions-crd`) | returns the seeded Functions; 404 until `scripts.establishCrd()` ran, to test the "404 before Established" retry (SPEC.md:159-161) |
| `/apis/krun.io/v1alpha1/namespaces/{ns}/functions/{name}/status` | PATCH (`application/merge-patch+json`) | P4.7 status writer as a process | merges `status`, bumps resourceVersion, emits `MODIFIED` |
| `/apis/coordination.k8s.io/v1/namespaces/{ns}/leases/{name}` | GET, PUT | P4.11 leader election (`krun-scheduler-k8s` `references/lease.md`) | PUT requires `metadata.resourceVersion` equal to the stored one, else 409 `Conflict`; 404 before create |
| `/apis/coordination.k8s.io/v1/namespaces/{ns}/leases` | POST | P4.11 | 409 `AlreadyExists` when present |
| `/apis/batch/v1/namespaces/{jobs}/jobs` | GET (list, watch with `labelSelector`), POST | P4.6 | POST stores the Job with `status: {}`; `AlreadyExists` on a duplicate; `scripts.completeJobs` later sets `Complete`, `succeeded: 1`, and creates a pod |
| `/apis/batch/v1/namespaces/{jobs}/jobs/{name}` | GET, DELETE | P4.6 | DELETE also deletes pods with the Job's `krun.io/run-id` label; 404 when absent (SPEC.md:798-799 treats it as success) |
| `/api/v1/namespaces/{jobs}/pods` | GET (list, watch with `labelSelector`) | P4.6 pod informer | pods created by `completeJobs`: `Running` then `Succeeded`, `containerStatuses[0].state.terminated.exitCode` |
| `/api/v1/namespaces/{jobs}/pods/{name}/log` | GET | P4.8 fallback as a process | fixed text; honours `tailLines`, `limitBytes` loosely |
| `/api/v1/namespaces/{jobs}/secrets` | POST, GET (list with `labelSelector`) | P4.6, P4.10 | stores; `AlreadyExists` on duplicate; lists by label |
| `/api/v1/namespaces/{jobs}/secrets/{name}` | GET, DELETE | P4.6 | 404 when absent |
| `/version`, `/api`, `/apis` | GET | client discovery if asked | static documents |

`labelSelector` support: `key=value` and `key` (exists), comma separated.
Reject any other syntax with 400 so a test does not pass by accident.

### Watch streaming

- `?watch=1` answers `200` chunked, one JSON line per event `{ type:
  "ADDED"|"MODIFIED"|"DELETED"|"ERROR", object }`, flushed immediately.
- One open response per watcher, events pushed as the store changes (dapr
  `informer.go:34-70`: one event per connection cost seconds per event).
- `?resourceVersion=N` replays events after `N` from a bounded ring
  buffer; an unknown or too-old version answers an `ERROR` event with
  `code: 410` so the informer re-lists.
- The client's 30 s inactivity timeout reconnects at the last
  resourceVersion; accept it. `scripts.breakWatch(kind)` closes the
  response with `ERROR` `code: 500` once: the informer stops and krun's
  restart logic must resubscribe (D33, SPEC.md:1474; `krun-scheduler-k8s`
  `references/informers.md`).
- No bookmarks.

### Lease semantics

- `holdLease({ holderIdentity: "other", renewEveryMs: 5000 })` seeds the
  Lease held by another pod and keeps bumping `renewTime` and
  `resourceVersion`, so the scheduler under test stays standby and
  `/readyz` reports 200 with leader false (P4.11, PLAN.md:596-598;
  SPEC.md:1162-1165).
- `releaseLease()` stops renewing; the scheduler must see the Lease
  unchanged for 15 s on its own clock (SPEC.md:788-790) before it acquires.
  A spawned process runs on the real clock: `TestClock` cannot reach into
  it, and SPEC defines no shorter lease setting, so a process test either
  waits the real 15 s (raise that test's timeout) or asserts standby only.
  The expiry arithmetic is proven in the fake `Kube` layer (part 1).
- On SIGTERM the scheduler clears `holderIdentity` (SPEC.md:1171-1173);
  the test reads `store.get("leases", "krun/krun-scheduler")` and asserts
  `spec.holderIdentity` empty or absent within 5 s of the signal
  (PLAN.md:598-599).
- P4.11 names both "`/readyz` 200 as standby" and "the Lease cleared in the
  fake" (PLAN.md:596-599): a standby holds no Lease to clear. Run two
  phases in one test (standby readiness, then `releaseLease()`,
  acquisition, SIGTERM, cleared) and record the interpretation in the pull
  request; do not invent a lease variable.

### Scripted behaviours

| Script | Effect | Used by |
|---|---|---|
| `establishCrd()` | Function endpoints stop answering 404 | P3.7 retry path |
| `completeJobs({ afterMs, exitCode = 0 })` | on Job POST: pod `Running`, then terminated with `exitCode`, Job `Complete` or `Failed` | P4.6 metrics after one run (PLAN.md:555-556) |
| `rejectCreate(resource, code, { retryAfter })` | next POST answers `code` once (403, 422, 429, 503) | process-level smoke only; classification is a fake `Kube` layer row (PLAN.md:502-504) |
| `holdLease`, `releaseLease` | above | P4.11 |
| `breakWatch(kind)` | one `ERROR` event then close | informer restart as a process |
| `hang(path, ms)` | delays one response | end-to-end smoke of the per-call `Effect.timeout` and abort signal |

### Driving a process against the fake

```ts
// apps/scheduler/src/main.process.test.ts (plain Vitest; real time, real process)
import { afterAll, beforeAll, expect, it } from "vitest"

let kube: FakeKube, child: ChildProcess, dir: string
beforeAll(async () => {
  kube = await startFakeKube({ namespace: "krun", jobsNamespace: "krun-jobs" })
  kube.store.seed("functions", fixtureFunction)
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "krun-"))
  child = spawn(process.execPath, ["bin/krun.js", "scheduler"], {
    env: { ...scrubbedEnv(), KUBECONFIG: kube.kubeconfigPath, KRUN_DB_MODE: "embedded",
           KRUN_DB_PATH: `${dir}/krun.db`, KRUN_ADMIN_LISTEN_ADDR: `127.0.0.1:${adminPort}` /* ... */ },
    stdio: ["ignore", "pipe", "pipe"],
  })
}, 30_000)
afterAll(async () => { child.kill("SIGKILL"); await kube.close(); await fs.rm(dir, { recursive: true }) })
```

- `bin/krun.js` dispatches to the built `dist/` entrypoints
  (PLAN.md:153-154): run `pnpm -r build` first (Vitest `globalSetup` or the
  `make test` order), or the test exercises stale code.
- Real time here: poll with the tri-state helper from `kind-recipe.md`
  "Wait helpers"; never a fixed sleep. A child `exit` event fails the poll
  at once.
- Scrub `KRUN_*` from a copied env; pass every variable explicitly
  (knative-func `pkg/testing/testing.go:377-385`).
- Ports: reserve free ports with a throwaway `net.createServer().listen(0)`
  and pass them; do not reuse a port within one file (dapr
  `ports/ports.go:40-46`).
- Exit: `child.kill("SIGTERM")`, await `exit`, assert code 0 within 5 s
  (PLAN.md:440-441, 598-599). `NodeRuntime.runMain` turns the signal into
  fiber interruption and runs the scope finalizers (readiness 503, drain,
  listener close, Lease clear, pool close; STACK.md:149-153); a non-zero
  code means a finalizer failed or the cause was not interrupt-only. Drain
  stdout and stderr before asserting on log lines (dapr `exec.go:159-236`).
- Log-line assertions parse JSON lines and match `msg` or `reason`; never
  assert on a line that would contain a key, token or input
  (SPEC.md:1149-1154).
- Raise `testTimeout` for these files (Vitest default 5000 ms); the
  `hookTimeout` default is 10000 ms.

### What the HTTP fake deliberately does not do

- No RBAC, no admission, no CEL: the CRD's digest rule and PSA are proven
  on kind (P9.2) and by the CRD file tests (P0.8).
- No `Foreground` deletion semantics beyond deleting the pods; ordering
  assertions belong to the fake `Kube` layer.
- No persistence across `close()`.

## client-node facts (2.0.1 tarball, VERIFIED unless marked)

- Non-2xx responses reject with `ApiException { code, body, headers }`
  (`dist/gen/apis/exception.js:10-18`); network failures, `TimeoutError`
  and `AbortError` are not `ApiException`. The `Kube` adapter maps both to
  tagged errors; the fake `Kube` layer reproduces only the tagged form.
- An `http:` server in a kubeconfig without `skipTLSVerify` throws "HTTP
  protocol is not allowed when skipTLSVerify is not set or false"
  (`dist/config.js:506-507`).
- Informers: watch `requestTimeoutMs` is 30000 (`dist/watch.js:8`); a
  `TimeoutError` reconnects from the last resourceVersion, a 410 re-lists,
  any other error invokes the `error` callbacks and the informer stops
  (`dist/cache.js:98-113`). krun restarts it; tests prove the restart with
  a non-timeout error.
- `RequestContext.setSignal` exists and the signal reaches `fetch`
  (`dist/gen/http/http.js:110`, `dist/gen/http/isomorphic-fetch.js:12`).
  How the `Effect.tryPromise({ try: (signal) => ... })` signal is threaded
  into a generated API call is UNVERIFIED: spike in P4.3a. The fake `Kube`
  layer cannot prove it, so add one `test/fake-kube` test where a hung
  request is interrupted and the server sees the connection close.
- `@types/node ^26` is a runtime dependency of client-node 2.0.1, and
  krun pins `@types/node` `^26` too (STACK.md section 3), so one copy
  should resolve; if `pnpm why @types/node` shows two, dedupe with pnpm
  `overrides`.
