# `test/fake-kube` design

`test/fake-kube/` is an `http.createServer` Kubernetes API over in-memory
objects for process tests (PLAN.md:109). It is not a mock library: it is a
small server that speaks enough of the real API for `@kubernetes/client-node`
2.x to list, watch, create, update and delete the objects krun touches, so
P3.7, P4.6 and P4.11 can start the real `bin/krun.js` with `KUBECONFIG`
pointing at it (PLAN.md:416-417, 535-536, 576-579). Dapr's integration
framework does the same with an `http.ServeMux` (dapr
`tests/integration/framework/process/kubernetes/kubernetes.go:46-70`) and
is cheaper and more deterministic than kind for informer, Lease and
Job-create paths.

## Shape

```
test/fake-kube/
  server.ts        start({ namespace, jobsNamespace }) -> { url, kubeconfigPath, store, close() }
  store.ts         Map<kind, Map<"ns/name", object>> with resourceVersion counter and watchers
  routes.ts        path table below
  kubeconfig.ts    writes a kubeconfig file with insecure-skip-tls-verify: true
  scripts.ts       behaviours a test turns on: completeJobs, failJobs, holdLease, rejectCreate
  index.ts         exports start and the scripted behaviours
  server.test.ts   the fake's own tests (list, watch streaming, 409, 404)
```

The fake is TypeScript loaded by `node --test` and by the spawned process
tests only; it never ships in the image (`.dockerignore` lists `test/`).

## Kubeconfig

`loadFromDefault` reads `$KUBECONFIG` first (node-stack-facts.md:208-213).
Write:

```yaml
apiVersion: v1
kind: Config
clusters: [{ name: fake, cluster: { server: http://127.0.0.1:<port>, insecure-skip-tls-verify: true } }]
users: [{ name: fake, user: { token: fake-token } }]
contexts: [{ name: fake, context: { cluster: fake, user: fake, namespace: <namespace> } }]
current-context: fake
```

`insecure-skip-tls-verify: true` is required: an `http:` server without it
throws "HTTP protocol is not allowed" (VERIFIED, node-stack-facts.md:227-228).
The token is a constant placeholder, not a secret (PLAN.md:33); the fake
ignores `Authorization`.

## Endpoint table

Every list response is `{ apiVersion, kind: "<Kind>List", metadata: { resourceVersion }, items }`.
Every object carries `metadata.resourceVersion` (a global incrementing
integer as a string), `metadata.uid`, `metadata.creationTimestamp`.
Errors are Kubernetes `Status` objects with `code` and `reason` so
`ApiException.body.reason` reads `AlreadyExists`, `NotFound`, `Conflict`.

| Path | Verbs | Needed by | Semantics |
|---|---|---|---|
| `/apis/krun.io/v1alpha1/namespaces/{ns}/functions` | GET (list, `?watch=1`) | P3.7, P4.11 Function informer (`krun-functions-crd`) | returns the seeded Functions; 404 until `scripts.establishCrd()` ran, to test the "404 before Established" retry (SPEC.md:159-161) |
| `/apis/krun.io/v1alpha1/namespaces/{ns}/functions/{name}/status` | PATCH (`application/merge-patch+json`) | P4.7 status writer when run as a process | merges `status`, bumps resourceVersion, emits `MODIFIED` |
| `/apis/coordination.k8s.io/v1/namespaces/{ns}/leases/{name}` | GET, PUT | P4.11 leader election (`krun-scheduler-k8s` `references/lease.md`) | PUT requires `metadata.resourceVersion` equal to the stored one, else 409 `Conflict`; 404 before create |
| `/apis/coordination.k8s.io/v1/namespaces/{ns}/leases` | POST | P4.11 | 409 `AlreadyExists` when present |
| `/apis/batch/v1/namespaces/{jobs}/jobs` | GET (list, watch with `labelSelector`), POST | P4.6 | POST stores the Job with `status: {}`; `AlreadyExists` on a duplicate name; `scripts.completeJobs` later sets `status.conditions: [{type: Complete, status: "True"}]`, `succeeded: 1`, and creates a pod |
| `/apis/batch/v1/namespaces/{jobs}/jobs/{name}` | GET, DELETE | P4.6 | DELETE honours `propagationPolicy` only by deleting pods with the Job's `krun.io/run-id` label too; 404 when absent (SPEC.md:798-799 treats it as success) |
| `/api/v1/namespaces/{jobs}/pods` | GET (list, watch with `labelSelector`) | P4.6 pod informer | pods created by `completeJobs` with `status.phase` `Running` then `Succeeded`, `containerStatuses[0].state.terminated.exitCode` |
| `/api/v1/namespaces/{jobs}/pods/{name}/log` | GET | P4.8 fallback path when run as a process | returns a fixed text; honours `tailLines`, `limitBytes` loosely |
| `/api/v1/namespaces/{jobs}/secrets` | POST | P4.6 | stores; `AlreadyExists` on duplicate |
| `/api/v1/namespaces/{jobs}/secrets/{name}` | GET, DELETE | P4.6 | 404 when absent |
| `/api/v1/namespaces/{jobs}/secrets` | GET (list with `labelSelector`) | P4.10 sweep | lists by label |
| `/version`, `/api`, `/apis` | GET | client discovery if the client asks | static documents |

`labelSelector` support: `key=value` and `key` (exists), comma separated;
that is all the informers send (node-stack-facts.md:366-370). Reject any
other syntax with 400 so a test does not pass by accident.

## Watch streaming

- `?watch=1` answers `200` with `Transfer-Encoding: chunked`, one JSON line
  per event `{ type: "ADDED"|"MODIFIED"|"DELETED"|"ERROR", object }`, flushed
  immediately (`res.write` then no buffering).
- Keep one open response per watcher and push events as the store changes
  (dapr `informer.go:34-70`: one event per connection cost seconds per
  event through reflector backoff).
- `?resourceVersion=N` replays events after `N` from a bounded ring buffer;
  an unknown or too-old version answers an `ERROR` event with `code: 410`
  so the informer re-lists (node-stack-facts.md:387-389).
- The client's 30 s inactivity timeout tears down a quiet watch and
  reconnects (node-stack-facts.md:350-360); the fake must accept a reconnect
  at the last resourceVersion. For a test that needs a non-timeout error,
  `scripts.breakWatch(kind)` closes the response with `ERROR` `code: 500`
  once; the informer then stops and krun's restart logic must call
  `start()` again (SPEC.md D33, `krun-scheduler-k8s` `references/informers.md`).
- Bookmarks are never sent (the informer does not request them).

## Lease semantics

- `holdLease({ holderIdentity: 'other', renewEveryMs: 5000 })` seeds the
  Lease held by another pod and keeps bumping `renewTime` and
  `resourceVersion`, so the scheduler under test stays standby and
  `/readyz` reports 200 with leader false (P4.11, PLAN.md:576-578;
  SPEC.md:1161-1164).
- `releaseLease()` stops renewing; the scheduler must see the Lease
  unchanged for 15 s on its own clock (SPEC.md:788-790) and acquire. A test
  that cannot wait 15 s passes a shorter `KRUN_LEASE_*` value only if SPEC
  defines one; it does not, so the P4.11 standby test waits the real 15 s
  (the acceptance budget allows it) or asserts standby only.
- On SIGTERM the scheduler clears `holderIdentity` (SPEC.md:1171-1173); the
  fake exposes `store.get('leases', 'krun/krun-scheduler')` so the test
  asserts `spec.holderIdentity === ''` or absent within 5 s of the signal
  (PLAN.md:578-579).
- P4.11 acceptance names both "200 as standby" and "Lease cleared in the
  fake" (PLAN.md:576-579): a standby holds no Lease to clear. Read it as
  two phases in one test: standby readiness, then `releaseLease()`,
  acquisition, SIGTERM, cleared. If the 15 s wait is unacceptable, record
  the interpretation in the pull request; do not shorten SPEC's constant.

## Scripted behaviours

| Script | Effect | Used by |
|---|---|---|
| `establishCrd()` | Function endpoints stop answering 404 | P3.7 retry path |
| `completeJobs({ afterMs, exitCode = 0 })` | on Job POST: pod `Running` after `afterMs/2`, then terminated with `exitCode`, Job `Complete` or `Failed` | P4.6 metrics after one run (PLAN.md:535-536) |
| `rejectCreate(resource, code, { retryAfter })` | next POST answers `code` once (403, 422, 429, 503) | process-level check of error classification; unit tests use stubbed API classes instead (PLAN.md:482-484) |
| `holdLease`, `releaseLease` | above | P4.11 |
| `breakWatch(kind)` | one `ERROR` event then close | informer restart |
| `hang(path, ms)` | delays one response | 10 s `AbortSignal.timeout` paths |

## Driving a process against the fake

```ts
const kube = await startFakeKube({ namespace: 'krun', jobsNamespace: 'krun-jobs' })
kube.store.seed('functions', fixtureFunction)            // one Ready-able Function
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krun-'))
const child = spawn(process.execPath, ['bin/krun.js', 'gateway'], {
  env: { ...scrubbedEnv, KUBECONFIG: kube.kubeconfigPath, KRUN_DB_MODE: 'embedded',
         KRUN_DB_PATH: `${dir}/krun.db`, KRUN_API_KEYS_PATH: keysPath, KRUN_ADMIN_LISTEN_ADDR: '127.0.0.1:0' ... },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

- Scrub `KRUN_*` from a copied env; pass every variable explicitly
  (knative-func `pkg/testing/testing.go:377-385`).
- Ports: let the process bind `:0` only if the config allows it; otherwise
  reserve a free port with a throwaway `net.createServer().listen(0)`
  and pass it (dapr `ports/ports.go:40-46` keeps a freed-port grace of 30 s
  to avoid reuse races; mirror by not reusing a port within one test file).
- Readiness: poll TCP, then `GET /readyz` until 200 (dapr
  `daprd.go:256-307`), with the tri-state helper from
  `kind-recipe.md` "Wait helpers" so a crash (child `exit` event) fails
  immediately.
- Exit: `child.kill('SIGTERM')`, await `exit`, assert code 0 within 5 s
  (PLAN.md:420-421, 578-579); drain stdout and stderr before asserting on
  log lines so the last lines are captured (dapr `exec.go:159-236`).
- Log-line assertions use `logline`-style helpers: collect lines, assert a
  JSON line with `reason` or `msg` exists; never assert on a line that
  would contain a key, token or input (SPEC.md:1149-1154).
- `after`: close the child if still alive, `kube.close()`, remove the temp
  dir.

## What the fake deliberately does not do

- No RBAC, no admission, no CEL: the CRD's digest rule and PSA are proven
  on kind (P9.2) and by the CRD file tests (P0.8).
- No `Foreground` deletion semantics beyond deleting the pods; ordering
  assertions belong to unit tests with stubbed API classes (PLAN.md:562-563).
- No persistence across `close()`.
