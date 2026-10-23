# krun Node stack facts (verified against published packages and official docs)

Date: 2026-10-22. Host Node used for inspection: v26.7.0 (npm 11.19.0). Target
runtime: Node 24 LTS; Node 24 docs cited are the v24.22.1 set
(https://nodejs.org/docs/latest-v24.x/api/). Latest Node 24 release at writing:
v24.22.1 (2026-10-20, LTS "Krypton", npm 11.19.1, V8 13.6) per
https://nodejs.org/dist/index.json.

Method: `npm view` for versions/dist-tags; `npm pack` + tarball inspection
under `/home/worxbend/.hermes/cache/scratch/krun-skills/pkgs/<pkg>/package`
(README, `.d.ts`, compiled `.js`); a shallow clone of
kubernetes-client/javascript at commit `008fc0b1b6ce7e9a50a2b4c3d853825afc5f9742`
under `src/k8s-javascript`; Node docs fetched with curl into `docs/*.txt`;
GitHub release notes via the API. No runtime execution of the libraries was
possible in this session (the install step was denied), so every "runtime"
behaviour claim is labelled either VERIFIED (read directly from shipped source
or official docs) or UNVERIFIED.

Coverage note: sections 1-3 were inspected in depth. Sections 4-6 were only
version-checked (VERIFIED) because the session's command execution was denied
after the Fastify inspection; their API facts are marked UNVERIFIED and must be
confirmed by the implementer before relying on them. SPEC items that this
research contradicts are flagged with **SPEC RISK**.

Version table (all `npm view <pkg> version` / `dist-tags.latest`, VERIFIED
2026-10-22):

| package | latest | notes |
|---|---|---|
| @kubernetes/client-node | 2.0.1 | `next` = 2.0.0-rc.1; `patch-1.1.3` = 1.1.3 |
| fastify | 5.12.7 | `next` = 6.0.0-alpha.5 |
| @fastify/type-provider-typebox | 6.3.0 | peers on `typebox ^1.1.14`, NOT `@sinclair/typebox` |
| @sinclair/typebox | 0.34.52 | 0.x LTS line (CJS+ESM) |
| typebox | 1.4.3 | 1.x line, ESM only, needs TS 6.0-7.0+ |
| @fastify/under-pressure | 9.2.1 | |
| @fastify/swagger | 9.9.2 | |
| close-with-grace | 2.5.0 | |
| kysely | 0.29.7 | `next` = 0.30.0-beta.2 |
| better-sqlite3 | 13.0.3 | |
| pg | 8.23.1 | |
| uuid | 14.0.3 | legacy-13 = 13.0.2 |
| ajv | 8.20.0 | |
| ajv-formats | 3.0.1 | |
| prom-client | 15.1.3 | |
| undici | 8.12.3 | `seven` = 7.30.1 |
| ipaddr.js | 2.5.0 | |
| @aws-sdk/client-s3 / s3-request-presigner | 3.1156.0 | |
| yaml | 2.9.1 | `next` = 3.0.0-2 |
| testcontainers / @testcontainers/postgresql | 12.2.1 | |
| @biomejs/biome | 2.6.2 | |
| typescript | 7.0.2 | `latest` is TS 7 (Go-native compiler); 7.1.0-beta also tagged |
| pino | 10.4.0 | fastify 5.12.7 depends on `pino ^9.14.0 || ^10.1.0` |
| @types/node | 26.6.5 | `old-version` tag = 24.19.2; pin `@types/node@24` for krun |

---

## 1. Node 24 type stripping and `node --test`

Source for all bullets unless stated: `docs/node24-typescript.txt`
(https://nodejs.org/docs/latest-v24.x/api/typescript.html),
`docs/node24-test.txt` (…/test.html), `docs/node24-cli.txt` (…/cli.html).

### Flags
- Type stripping is **on by default and Stable (Stability 2)** in Node 24:
  "v24.12.0 Type stripping is now stable", "v24.3.0 … no longer emits an
  experimental warning", "v23.6.0 … enabled by default". No flag is needed for
  `node --test` on `.ts` files. VERIFIED (typescript.html History table).
- The opt-out flag is `--no-strip-types` (renamed from
  `--no-experimental-strip-types`). VERIFIED (cli.html).
- `--experimental-transform-types` (Stability 1.2, release candidate) enables
  non-erasable syntax (enums, parameter properties, namespaces with values,
  `import x = require()` aliases) and "Implies --enable-source-maps". krun does
  not need it if the codebase stays erasable-only. VERIFIED (cli.html).
- On Node 24.22.1 any *older* `--experimental-strip-types` flag is not listed
  in the CLI docs; the typescript page only documents the default-on behaviour
  and `--no-strip-types`. Do not put `--experimental-strip-types` in scripts.
  VERIFIED (absence in cli.html index; search for the string returned -1).

### Erasable vs non-erasable syntax
- Node "will replace TypeScript syntax with whitespace, and no type checking is
  performed". VERIFIED.
- Errors (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) without transform flag: enum
  declarations, `namespace` with runtime code, parameter properties, import
  aliases (`import x = …`). Type-only namespaces (`namespace T { export type A
  = string }`) are fine. VERIFIED.
- Decorators are "not transformed and will result in a parser error" even with
  transform-types. VERIFIED.
- `.tsx` is unsupported. `.mts` always ESM, `.cts` always CJS, `.ts` follows
  nearest `package.json` `"type"`. krun must have `"type": "module"` in every
  workspace package. VERIFIED.
- **File extensions are mandatory in import specifiers**: `import './file.ts'`,
  not `import './file'`. Same for `require('./file.ts')`. VERIFIED.
- `import type { X }` / `import { fn, type X }` are required for type-only
  imports; without the `type` keyword Node treats it as a value import and the
  module throws at runtime. `verbatimModuleSyntax` makes tsc enforce the same.
  VERIFIED.
- `tsconfig` `paths` are not honoured ("produce an error"); use `#` subpath
  imports in `package.json` `imports` instead. VERIFIED.
- Node refuses to strip TypeScript under any `node_modules` path, so workspace
  packages consumed via `workspace:` links must be consumed through built `.js`
  or via a path that is not under `node_modules` (pnpm symlinks resolve through
  `node_modules/@krun/x` → realpath; Node checks the *resolved* path, which for
  a pnpm workspace symlink is the source dir, not node_modules — UNVERIFIED,
  test it). The rule itself is VERIFIED.
- Source maps: not generated in strip mode because whitespace replacement keeps
  line/column numbers. VERIFIED.
- Node recommends TypeScript ≥5.8 with `tsconfig`:
  `{"noEmit": true (optional), "target": "esnext", "module": "nodenext",
  "rewriteRelativeImportExtensions": true, "erasableSyntaxOnly": true,
  "verbatimModuleSyntax": true}`. VERIFIED (typescript.html).
- `allowImportingTsExtensions` lets tsc type-check `.ts` specifiers. If krun
  only type-checks (noEmit) and runs sources directly it needs
  `allowImportingTsExtensions: true`; if it also emits `.js` for published
  packages (`@krun/sdk`, `@krun/cli`) use `rewriteRelativeImportExtensions:
  true` so the emitted JS points at `.js`. VERIFIED (typescript.html names the
  option; the emit interaction is from the TS docs, UNVERIFIED here).
- `--import=module` preloads an ESM module before the entry (and into test child
  processes). Useful for a test setup file. VERIFIED (cli.html).

### Test runner discovery and globs
- Default patterns include `**/*.test.{cjs,mjs,js}`, `**/*-test.*`,
  `**/*_test.*`, `**/test-*.*`, `**/test.*`, `**/test/**/*.*` AND, unless
  `--no-strip-types`, the same with `{cts,mts,ts}`. So `node --test` with no
  args already picks up `*.test.ts` across the repo (including anything under
  `node_modules`? the doc does not say it excludes node_modules for discovery
  — UNVERIFIED; pass explicit globs to be safe). VERIFIED.
- Explicit globs: `node --test "packages/**/*.test.ts"` — patterns are the
  final args, follow glob(7), and "should be enclosed in double quotes on the
  command line to prevent shell expansion". VERIFIED.
- Execution model: default `--test-isolation=process` runs each file in a child
  process; `--test-isolation=none` imports all files into one process and runs
  top-level tests with concurrency 1 (and `--test-concurrency` is ignored).
  VERIFIED (cli.html, test.html "Test runner execution model").
- `--test-concurrency` defaults to `os.availableParallelism() - 1`. VERIFIED.
- Child processes inherit Node options except `--test`,
  `--experimental-test-coverage`, `--experimental-test-tag-filter` (filtered).
  VERIFIED.
- `--test-force-exit` exits once tests finish even if the loop is alive (useful
  when a leaked timer/handle would hang CI). VERIFIED.
- `--test-timeout` (ms) default Infinity. VERIFIED.
- `--test-only` is "not necessary when test isolation is disabled". VERIFIED.
- `--test-global-setup=module` (Node 24.0.0, Stability 1.0). VERIFIED.
- `--test-randomize` / `--test-random-seed=<n>` added in 24.16.0 (early
  development); randomises file order and queued tests. Note sequentially
  awaited `t.test()` subtests keep declaration order. VERIFIED.
- `--experimental-test-module-mocks` is required for `mock.module()`
  (Stability 1.0). VERIFIED.
- `--experimental-test-coverage` is Experimental; test files are excluded from
  the report by default. VERIFIED.

### Test runner APIs
- `describe`/`it`/`suite`/`test`, `before`/`after`/`beforeEach`/`afterEach`
  exist; `after([fn][, options])` has `signal` and `timeout` options and "is
  guaranteed to run" even if tests fail. `t.after()` (TestContext.after) is the
  per-test teardown. VERIFIED (test.html TOC + after section).
- `mock.method(object, methodName[, implementation][, options])`: throws if
  `object[methodName]` is not a function; options `getter`, `setter`, `times`
  (auto-restore after N calls); returns a Proxy with `.mock`
  (MockFunctionContext: `callCount()`, `calls`, `restore()`…). Use
  `t.mock.method` so it is restored at test end. VERIFIED.
- Also available: `mock.fn`, `mock.getter`, `mock.setter`, `mock.property`,
  `mock.module` (flag-gated), `mock.reset()`, `mock.restoreAll()`. VERIFIED
  (TOC).
- Fake timers: `mock.timers.enable({ apis: ['setTimeout','setInterval',
  'setImmediate','Date'], now?: number|Date })`; default mocks all four;
  mocking a timer also mocks its `clear*`; mocks `node:timers`,
  `node:timers/promises` and `globalThis`. `tick(ms)` advances (positive
  numbers only), `runAll()` fires all pending timers and advances mocked
  `Date`, `setTime(ms)`, `reset()`, `[Symbol.dispose]()`. VERIFIED.
- Fake-timer pitfall: with `apis: ['setTimeout']` only, `Date.now()` is real;
  krun's lease logic that judges expiry on the local clock must mock `Date` too.
  VERIFIED (doc: "Mocking Date will affect the behavior of the mocked timers as
  they use the same internal clock").
- `t.waitFor(condition[, options])`, `t.plan(count)`, `t.assert.snapshot`,
  `t.signal`, `t.diagnostic`, tags via `tags` option (24.19.0). VERIFIED (TOC
  / cli.html).

---

## 2. @kubernetes/client-node 2.x

Current major IS 2.x: 2.0.0 published 2026-08-13, 2.0.1 published 2026-10-20
(`npm view` dist-tags + GitHub releases API). VERIFIED. Package is
`"type": "module"` (ESM only since 1.0.0), `main: dist/index.js`, no `exports`
map, no `engines` field; dependencies include `undici ^8.7.0`, `@types/node
^26.0.0`, `openid-client`, `ws`, `js-yaml ^5`. VERIFIED
(`pkgs/kubernetes-client-node-2.0.1/package/package.json`).

### What changed in 2.0 (release notes, VERIFIED)
- HTTP backend moved from node-fetch to **undici** (`fetch` from `undici`,
  not global fetch); the client configures an undici `Dispatcher` instead of a
  node-fetch agent (#2306).
- Dropped Node 18, 20 and 23; Node 26 added to CI. Node 24 is supported.
- undici pinned `^8.0.0`; socks-proxy-agent 10.x; SOCKS proxy on the
  dispatcher path.
- Generated against Kubernetes **release-1.36**; README compatibility table
  only lists up to 1.4.x ↔ k8s 1.34 (table is stale for 2.x).
- Informer fix: TimeoutError treated as reconnectable; exponential backoff on
  reconnect (#2813).
- 1.0.0 → 1.x notes still relevant for krun: ESM only; `request` library gone;
  per-call middleware (#2275); "Revisions needed for no non-erasable types"
  (#2302) — the library itself compiles under erasable-only rules;
  `PatchStrategy` exported (#2316); abort-signal support via regenerated OpenAPI
  (1.4.0, #2583); `makeInformer` return type includes `ObjectCache` (1.4.0,
  #2645); informer `error`/`connect` callbacks re-added (1.4.0, #2646).

### KubeConfig
- `loadFromDefault(opts?, contextFromStartingConfig = false, platform =
  process.platform)`: order is `$KUBECONFIG` (path-delimited list, merged) →
  `~/.kube/config` → (win32 WSL hacks) → if
  `/var/run/secrets/kubernetes.io/serviceaccount/token` exists then
  `loadFromCluster()` → else fallback `http://localhost:8080`. VERIFIED
  (`dist/config.js` lines 355-415).
- `loadFromCluster(pathPrefix = '')` builds server from
  `KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` (http scheme when port is
  80/8080/8001, IPv6 bracketed), `caFile` + `tokenFile` auth provider, and
  reads the namespace file into the context. VERIFIED (`config.js` 259-305).
- `makeApiClient(ApiClass)` creates a `Configuration` with `baseServer =
  cluster.server`, `authMethods: { default: this }`, and a User-Agent
  middleware. VERIFIED (`config.js` 416-432).
- `applySecurityAuthentication(ctx)` sets headers (Basic or whatever the
  authenticator adds, e.g. Bearer from tokenFile), copies TLS material
  (ca/cert/key/pfx/passphrase/rejectUnauthorized/servername) and calls
  `createDispatcher` → undici `Agent({ connect: { ...tls, keepAlive: true,
  keepAliveInitialDelay: 30000 } })` (30 s chosen to match client-go and avoid
  60 s LB idle races), `ProxyAgent` for `proxyUrl`, SOCKS connector for
  `socks*`. Plain `http:` server without `skipTLSVerify` throws
  "HTTP protocol is not allowed when skipTLSVerify is not set or false".
  VERIFIED (`config.js` createDispatcherOptions).
- **A new undici Agent is created on every request** (no dispatcher cache in
  `applySecurityAuthentication`) — I saw no caching in 2.0.1 `config.js`
  (grep for a cache map found none). Implication: connection reuse across
  calls is not guaranteed; krun's 8-way limiter still bounds sockets.
  VERIFIED-by-absence; treat as "likely" and re-check in later patch releases.
- `setDefaultAuthentication` does **not** exist on `KubeConfig` in 2.0.1
  (`config.d.ts` has no such member; `authMethods.default` is set internally
  by `makeApiClient`). SPEC/notes mentioning `setDefaultAuthentication` are
  from the 0.x generator. **SPEC RISK**. VERIFIED.
- `addAuthenticator(custom)` exists for injecting authenticators (must be
  called before loading). VERIFIED (`config.js` 86).

### API client classes — object-parameter style
- Every exported `XxxApi` is the `ObjectXxxApi` from
  `gen/types/ObjectParamAPI.d.ts` (`export { ObjectBatchV1Api as BatchV1Api
  }` in `gen/index.d.ts`). Methods take a single request object plus optional
  `options?: ConfigurationOptions`. VERIFIED.
- `BatchV1Api.createNamespacedJob(param: { namespace: string; body: V1Job;
  pretty?; dryRun?; fieldManager?; fieldValidation? }, options?):
  Promise<V1Job>`; `createNamespacedJobWithHttpInfo` returns
  `HttpInfo<V1Job>` (status + headers + body). VERIFIED (ObjectParamAPI.d.ts
  12667-12707, 13975-13980).
- `BatchV1Api.deleteNamespacedJob(param: { name; namespace; pretty?;
  body?: V1DeleteOptions; dryRun?; gracePeriodSeconds?;
  ignoreStoreReadErrorWithClusterBreakingPotential?; orphanDependents?;
  propagationPolicy?: string }, options?)`. `propagationPolicy` is a
  top-level query param ('Orphan' | 'Background' | 'Foreground'); you may
  also put it in `body: { propagationPolicy: 'Background' }`. Use
  `'Background'` (or Foreground) explicitly — Job's default is decided by the
  existing finalizers/resource default and for Jobs via the REST API the
  default is Orphan (pods left behind); kubectl adds Background itself.
  Default-is-Orphan is Kubernetes-documented, UNVERIFIED here. Signature
  VERIFIED (13014-13070).
- `CoreV1Api.readNamespacedPodLog(param: { name; namespace; container?;
  follow?; insecureSkipTLSVerifyBackend?; limitBytes?; pretty?; previous?;
  sinceSeconds?; stream?; tailLines?; timestamps? }, options?):
  Promise<string>` — returns the whole body as a string (not a stream). For
  streaming use the separate `Log` class: `new Log(kc).log(namespace, pod,
  container, writable, { follow, tailLines, limitBytes, previous, sinceSeconds,
  sinceTime, timestamps }) → Promise<AbortController>`. VERIFIED
  (ObjectParamAPI.d.ts 27535-27612, 30887; `dist/log.d.ts`).
- krun's "last 100 lines / 16 KB" tail: pass `tailLines: 100, limitBytes:
  16384` to `readNamespacedPodLog`; `limitBytes` "may not display a complete
  final line". VERIFIED (log.d.ts doc comments mirror the API).
- `CoordinationV1Api`: `createNamespacedLease`, `readNamespacedLease({ name,
  namespace })`, `replaceNamespacedLease({ name, namespace, body: V1Lease,
  fieldManager?, … })`, `patchNamespacedLease` — all return `Promise<V1Lease>`.
  Optimistic concurrency is via `body.metadata.resourceVersion` on replace
  (409 Conflict → `ApiException.code === 409`). VERIFIED (17295-17375).
- `CustomObjectsApi.patchNamespacedCustomObjectStatus(param: { group;
  version; namespace; plural; name; body: any; dryRun?; fieldManager?;
  fieldValidation?; force? }, options?): Promise<any>`; also
  `getNamespacedCustomObject`, `listNamespacedCustomObject`,
  `listClusterCustomObject` → `Promise<any>` (untyped). VERIFIED (32576-32640,
  33115-33225).
- **Patch Content-Type pitfall**: generated patch methods pick the first
  "preferred" media type from `["application/json-patch+json",
  "application/merge-patch+json", "application/apply-patch+yaml"]` → by
  default **JSON Patch** (`application/json-patch+json`), so a merge-patch body
  like `{status: {...}}` will be rejected unless you override the header:
  `api.patchNamespacedCustomObjectStatus(params,
  setHeaderOptions('Content-Type', PatchStrategy.MergePatch))`. `PatchStrategy`
  = `{ JsonPatch, MergePatch, StrategicMergePatch, ServerSideApply:
  'application/apply-patch+yaml' }`. VERIFIED (`gen/apis/CustomObjectsApi.js`
  1570-1576, `ObjectSerializer.getPreferredMediaType`, `dist/patch.d.ts`,
  `examples/patch-example.js`, `docs/docs/request-options.md`).
- Server-side apply: pass `PatchStrategy.ServerSideApply` as Content-Type plus
  `fieldManager: 'krun-scheduler'` and `force: true` in params. `fieldManager`
  is a plain optional query param on create/replace/patch. VERIFIED (param
  types); SSA end-to-end behaviour UNVERIFIED.
- `setHeaderOptions(key, value, opt?)` returns `ConfigurationOptions` with
  `middlewareMergeStrategy: 'append'`; `setHeaderMiddleware` is the raw
  middleware. VERIFIED (`dist/middleware.js`).

### Errors
- `ApiException<T> extends Error { code: number; body: T; headers:
  Record<string,string> }` thrown for non-2xx; `body` is the parsed Status
  object for k8s. VERIFIED (`gen/apis/exception.d.ts`).
- Network/undici errors (ECONNREFUSED, `TypeError: fetch failed`, `DOMException
  name 'TimeoutError'`/`'AbortError'`) are not `ApiException`; classify by
  `err instanceof ApiException` first, then `err.name`. `Retry-After` is
  available from `err.headers['retry-after']` on 429/503. VERIFIED (types);
  exact undici error shapes UNVERIFIED.

### Request timeouts / AbortSignal
- 2.0.1 published `dist/middleware.d.ts` exports only `setHeaderMiddleware`
  and `setHeaderOptions`. The repo `main` (commit 008fc0b…, version 2.0.0 in
  package.json — i.e. unreleased work) adds `requestTimeoutMiddleware(ms)`
  and `setRequestTimeoutOptions(ms, opt?)` which call
  `request.setSignal(AbortSignal.timeout(ms))`, plus `ApiRequestOptions`
  type and `examples/timeout-example.js`. **Not in 2.0.1.** VERIFIED (diff of
  `dist/middleware.d.ts` vs `src/middleware.ts`).
- krun can implement the same today: `RequestContext.setSignal(signal)` exists
  in 2.0.1 (`gen/http/http.d.ts` line 80) and `IsomorphicFetchHttpLibrary.send`
  passes `signal: request.getSignal()` to undici `fetch`. Write a 10-line
  middleware `{ pre: ctx => { ctx.setSignal(AbortSignal.timeout(10_000));
  return of(ctx) }, post: r => of(r) }` using `of` from
  `@kubernetes/client-node`'s… — note `rxjsStub.of` is **not** exported from
  the package index; use a `PromiseMiddleware` instead (`pre(ctx): Promise`,
  `post`) and pass via `options.middleware` wrapped by
  `PromiseMiddlewareWrapper` — also not exported. Practical path: pass
  `{ middleware: [{ pre: (c) => { c.setSignal(sig); return Promise.resolve(c)
  } , post: (r) => Promise.resolve(r) }], middlewareMergeStrategy: 'append' }`
  as the *promise* options: `createNamespacedJob(param, promiseOptions)` —
  the Object API methods take `ConfigurationOptions` = Promise form
  (`wrapOptions` converts). VERIFIED that `ObjectParamAPI` methods accept
  `ConfigurationOptions`, that `wrapOptions(PromiseConfigurationOptions)`
  exists (`gen/configuration.d.ts`), and that `setSignal` reaches fetch;
  whether `ConfigurationOptions` in the Object API is the Promise or
  Observable flavour is UNVERIFIED — check `gen/types/ObjectParamAPI.d.ts`
  import of `ConfigurationOptions` (it imports from `../configuration.js`
  where the default `M = Middleware` is Observable). If Observable, return
  `{ subscribe }`-shaped values or copy the 2-line `of()` helper. **Expect
  friction here; budget a spike.**
- `AbortSignal.timeout()` timers do not keep the process alive. VERIFIED
  (src/middleware.ts comment; Node semantics).

### Watch
- `new Watch(kc).watch(path, queryParams, callback(phase, apiObj, watchObj),
  done(err)) → Promise<AbortController>`. Internals (2.0.1): uses undici
  `fetch` with `signal`, 30 s `requestTimeoutMs` that acts as a **connect
  timeout then an inactivity timeout** (reset on every `data` chunk); on
  timeout it aborts with `DOMException('…', 'TimeoutError')` and `done()`
  receives that TimeoutError; non-200 → `Error` with `statusCode`; body is
  parsed line-by-line via `readline`, JSON parse errors are ignored; `done` is
  called once. Calling `controller.abort()` ends the watch and triggers
  `done`. `Watch.SERVER_SIDE_CLOSE = { error: 'Connection closed on server' }`
  is a legacy constant. VERIFIED (`dist/watch.js`).
- Consequence: a quiet watch will be torn down and re-established every 30 s;
  that is by design (matches client-go). Do NOT treat `TimeoutError` from a
  watch as an error. VERIFIED.

### Informer (`makeInformer`) — all VERIFIED from `dist/informer.js`, `dist/cache.js`
- `makeInformer<T>(kubeconfig, path, listPromiseFn: () =>
  Promise<KubernetesListObject<T>>, labelSelector?: string): Informer<T> &
  ObjectCache<T>` → `new ListWatch(path, new Watch(kc), listFn, autoStart =
  false, labelSelector)`. There is **no fieldSelector argument** on
  `makeInformer` (only on the `ListWatch` constructor, 6th param). You must
  also pass the same `labelSelector` inside your `listFn`
  (`listNamespacedJob({ namespace, labelSelector })`) — the informer only adds
  it to the *watch* query.
- Events: `on('add'|'update'|'delete', (obj) => void)`, `on('change', cb)` =
  shorthand that registers for add+update+delete, `on('error', (err?) =>
  void)`, `on('connect', () => void)`; `off(...)` mirrors. Unknown verb throws.
- `start(): Promise<void>` resets `stopped=false`, backoff and `hasConnected`,
  then runs `doneHandler(null)`: emits `connect`, if no `resourceVersion` does
  a full LIST (diffs the cache, emitting `delete` for vanished objects and
  add/update for the rest, then stores `list.metadata.resourceVersion`), then
  opens a watch at that RV with the label/field selector.
- `stop(): Promise<void>` sets `stopped=true` and aborts the current watch
  request. After `stop()`, the watch's `done` fires with no error and
  `doneHandler` returns early ("do not auto-restart").
- Cache: `get(name, namespace?)`, `list(namespace?)` (all namespaces when
  omitted), `latestResourceVersion()`. Objects are keyed by
  `metadata.namespace || ''` then `metadata.name`. `update` callbacks fire only
  when `resourceVersion` differs (`isSameVersion`), so the periodic
  re-LIST will not spam updates for unchanged objects.
- Reconnect semantics: on watch end with 410 Gone (`err.statusCode === 410 ||
  err.code === 410`, or an `ERROR` event with `obj.code === 410`) the RV is
  cleared → next cycle re-LISTs. On `TimeoutError` it reconnects immediately
  from last RV with `reconnectDelayMs = 0`. On **any other error it emits
  `error` and STOPS — it does not restart itself**; the caller must call
  `informer.start()` again (the official example does `setTimeout(() =>
  informer.start(), 5000)` inside the error handler). On clean server close
  (no error) it reconnects with exponential backoff 1 s → 2 s → … capped at
  30 s (`BASE_RECONNECT_DELAY_MS = 1000`, `MAX_RECONNECT_DELAY_MS = 30000`),
  reset to 0 on each received event. SPEC's "informer error handler restarts
  watch with backoff" must therefore be implemented in krun, not assumed.
- **Resync**: none. There is no periodic re-list or resync callback; a
  re-LIST only happens when RV is lost (410 or first start). SPEC's 5-minute
  reconcile timer over `informer.list()` is the correct mitigation. VERIFIED
  (no timer in cache.js).
- Watch `BOOKMARK` events are handled (no-op) but the informer never sets
  `allowWatchBookmarks=true`, so bookmarks are not requested; RV is advanced
  from every event's `metadata.resourceVersion`. VERIFIED.
- The informer catches LIST failures (emits `error`, stops) — a 404 before the
  CRD is Established therefore surfaces as `error` with an `ApiException`
  (`code 404`), and krun must retry `start()` with backoff. VERIFIED.
- `delayFn` (for tests) is only settable via the `ListWatch` constructor
  `options.delayFn`, not via `makeInformer`; to unit-test backoff construct
  `new ListWatch(path, watch, listFn, false, labelSelector, undefined,
  { delayFn })` with a fake `Watch`. VERIFIED (`cache.d.ts`).

### Misc
- README "Known Issues": credentials cached per kubeconfig username collide
  across kubeconfigs; fetch merges duplicate headers (Impersonate-Group).
  VERIFIED.
- `KubernetesObjectApi` (`dist/object.d.ts`) offers generic
  `create/read/patch/delete/list` with `patchStrategy` param; the `patch`
  signature there is positional. VERIFIED (object.d.ts line 93).
- Package pulls `@types/node ^26` as a *runtime* dependency; with
  `@types/node@24` pinned in krun you will get two `@types/node` copies — pnpm
  will dedupe only if ranges intersect (they don't). Expect possible
  duplicate-global-type errors; fix via pnpm `overrides` or `resolutions`
  (UNVERIFIED consequence; dependency fact VERIFIED).

---

## 3. Fastify 5 + TypeBox provider + under-pressure + swagger + close-with-grace

Sources: `pkgs/fastify-5.12.7/package/docs/Reference/*.md` (these are the
docs shipped with the exact installed version; same content as
https://fastify.dev/docs/latest/Reference/), `pkgs/fastify-type-provider-
typebox-6.3.0/package/{README.md,index.ts,package.json}`,
`pkgs/fastify-under-pressure-9.2.1/package/README.md`, `pkgs/typebox/package`.

### TypeBox provider — **SPEC RISK**
- `@fastify/type-provider-typebox@6.x` (6.0.0 2025-09-20 … 6.3.0 2026-10-12)
  has `peerDependencies: { "typebox": "^1.1.14" }` and does `export * from
  'typebox'`, `import { Compile } from 'typebox/compile'`, `Value` from
  `typebox/value`, `Format` from `typebox/format`. It does **not** accept
  `@sinclair/typebox`. VERIFIED (package.json, index.ts).
- The last provider line for `@sinclair/typebox` is 5.x: 5.2.0 (2025-07-14)
  peers `@sinclair/typebox >=0.26 <=0.34`; dist-tag `next` = 5.0.0. VERIFIED
  (`npm view @fastify/type-provider-typebox@5 peerDependencies`).
- `typebox@1.x` is "ESM only", developed against TypeScript 6.0-7.0+,
  "native JSON Schema 2020-12 support", "backwards compatibility with 0.x
  types"; `@sinclair/typebox@0.x` is the LTS line (CJS+ESM, TS 5.0-6.0).
  VERIFIED (typebox readme "Versions"; `typebox/package.json` `"type":
  "module"`).
- Decision for krun (recommendation): pick ONE of
  (a) `typebox@1` + provider 6.x + TypeScript ≥6 (TS 7.0.2 is `latest`;
  TS 6.x is the last JS-based compiler — check `tsc` 7 support for
  `erasableSyntaxOnly`/`verbatimModuleSyntax`, UNVERIFIED), or
  (b) `@sinclair/typebox@0.34` + provider `5.2.0` pinned. SPEC/BRIEF say
  "@sinclair/typebox"; that implies (b). Do not mix.
- `Type.Object(props, { additionalProperties: false })` — `TObjectOptions`
  has `additionalProperties?: TSchema | boolean`, `minProperties`,
  `maxProperties`, plus standard `$id`, `title`, `description`,
  `default`, `examples`. Same shape in both 0.34 (`TAdditionalProperties`)
  and 1.x. VERIFIED (`typebox/build/type/types/schema.d.mts` 57-69;
  `sinclair-typebox/package/build/esm/type/object/object.d.mts` 33).
- Provider usage: `const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()`
  — must be chained on construction ("the following will not work: const f =
  Fastify(); f.withTypeProvider<…>()"). Inference: `validator`/`serializer` =
  `Static<this['schema']>`. Helper types `FastifyPluginAsyncTypebox`,
  `FastifyPluginCallbackTypebox`, and the README pattern
  `FastifyRequestTypeBox<typeof Schema>`/`FastifyReplyTypeBox<…>` for handlers
  declared outside route calls. VERIFIED (README, index.ts).
- Optional `TypeBoxValidatorCompiler` replaces Ajv: `Compile(schema)` with
  `Value.Convert` for querystring/params/headers (not body). Default is
  Fastify's Ajv 8 (`@fastify/ajv-compiler ^4`) which is what krun should keep
  so `additionalProperties`, `format` etc. behave as JSON Schema. VERIFIED.
- Fastify's own docs now show `import { Type } from 'typebox'`. VERIFIED
  (Type-Providers.md).

### Route schema / body limits
- Route option `bodyLimit` (integer bytes) overrides the global `bodyLimit`
  (default 1048576 = 1 MiB); too-large → `FST_ERR_CTP_BODY_TOO_LARGE` (413).
  If a `preParsing` hook returns a stream, the limit applies to the decoded
  size. VERIFIED (Server.md, Routes.md).
- Route option `handlerTimeout` (ms; server-level too; route value wins;
  once set at server level routes cannot opt out) aborts `request.signal`
  and sends 503; cooperative; cancelled by `reply.hijack()`. Useful for
  `?wait=` requests only if the wait itself honours `request.signal`.
  VERIFIED (Server.md, Lifecycle.md).
- `ajv.customOptions`/`plugins`/`onCreate` configure Fastify's internal Ajv
  (e.g. `removeAdditional`). VERIFIED (Server.md).

### Request IDs / proxies
- `requestIdHeader` default **`false`** (Fastify 5): `true` → `'request-id'`,
  string → that header; `''` → false. When the header is present `genReqId`
  is NOT called. Warning: callers can set arbitrary `reqId`. VERIFIED.
- `genReqId(rawReq)` default = monotonically increasing integers; "must be
  error-free". For krun use `randomUUID()`/uuid v7. VERIFIED.
- `requestIdLogLabel` top-level option is deprecated in favour of
  `logController: { requestIdLogLabel }` (removed in v6). VERIFIED.
- `trustProxy`: `true|false`, IP/CIDR string (comma list), array, or
  `fn(address, hop)`. **Numeric hop-count is disabled in 5.12.x** ("Hop-count-only
  trust is disabled because it cannot validate the immediate peer"). Exposes
  `request.ip`, `ips`, `host`, `protocol`. VERIFIED (Server.md).

### Logging / redaction
- `logger: { level, redact: ['req.headers.authorization', …], serializers,
  transport, stream }` is passed to the Pino constructor; `redact` paths are
  pino's (fast-redact syntax, supports `*` wildcards and `censor`). krun paths
  to redact: `req.headers.authorization`, `req.headers["x-api-key"]`, any
  `token`/`secret` fields. Default serializers for `req`/`res`/`err` are added
  unless you override. `loggerInstance` for a pre-built pino. VERIFIED
  (Server.md, Logging.md "Log Redaction").
- Fastify 5.12.7 accepts `pino ^9.14.0 || ^10.1.0`; `pino@10.4.0` is latest.
  VERIFIED.

### Hook ordering (Lifecycle.md / Hooks.md, VERIFIED)
- Request path: Routing → `onRequest` → `preParsing` → Parsing →
  `preValidation` → Validation (400) → `preHandler` → handler → Reply →
  `preSerialization` → `onSend` → response → `onResponse`. `request.body` is
  `undefined` in `onRequest`/`preParsing`. Auth (API key) belongs in
  `onRequest`; anything needing the parsed body (idempotency key hashing)
  belongs in `preHandler`. Hooks are encapsulated per plugin scope.
- Server lifecycle hooks: `onReady` (before listen, serial, cannot add
  routes), `onListen` (errors logged and ignored; not run under `inject()`),
  `preClose`, `onClose` (child hooks before parent). VERIFIED.

### SSE via `reply.raw` / `hijack`
- `reply.hijack()` may be called any time before `reply.send()`; it stops
  Fastify from sending the response and from running remaining hooks/handler;
  `reply.sent` becomes true. If you then write with `reply.raw`,
  `onResponse` hooks still run. In an async handler call `reply.hijack()`
  and the resolved return value is ignored. `handlerTimeout` is cancelled by
  hijack. VERIFIED (Reply.md, Lifecycle.md).
- `reply.raw` is the Node `http.ServerResponse`; headers set via
  `reply.header()` are NOT applied when you write through `raw` — set them
  with `reply.raw.writeHead(200, {...})`. VERIFIED (Reply.md).
- `close()` note: "Upgraded connections (WebSocket) are not tracked … will
  prevent server.close() from completing. Close them explicitly in a
  `preClose` hook." SSE responses are regular HTTP responses kept open, so
  they are in-flight requests and will also block step 4 (server.close waits
  for in-flight) → end all SSE streams in `preClose`. VERIFIED (Server.md
  shutdown lifecycle, Hooks.md preClose explicitly names "Server-Sent Events
  streams").

### Error / 404 handlers
- `setErrorHandler((error, request, reply) => …)`: statusCode < 400 is
  bumped to 500 before the handler; does not catch `onResponse` errors, 404s,
  or stream errors after headers sent. Default handler logs ≥500 as error,
  4xx as info. `allowErrorHandlerOverride` default `true` (will flip to false
  in v6) — don't set the handler twice in one scope. If the error handler's
  Content-Type differs from the route's, set it explicitly. VERIFIED.
- `setNotFoundHandler([{ preValidation, preHandler }], handler)` is
  encapsulated by prefix; runs the full lifecycle; bad URLs go to `onBadUrl`.
  VERIFIED.

### Listeners / close
- `listen({ port, host, listenTextResolver })` — default host is
  `localhost`; use `host: '0.0.0.0'` or `'::'` in containers. A Fastify
  instance has one `server`; for three ports (public, internal, admin) create
  three instances (or `serverFactory`). VERIFIED (Server.md listen,
  serverFactory).
- `close()` sequence: flag closing (new requests → 503 + `Connection: close`
  when `return503OnClosing` true [default]) → `preClose` hooks → connection
  draining per `forceCloseConnections` → `server.close()` (waits in-flight)
  → `onClose` hooks → promise resolves. VERIFIED.
- `forceCloseConnections` default `"idle"` when the HTTP server supports it
  (`closeIdleConnections`), else `false`; `true` destroys all persistent
  connections without checking request completion; prefers Node's
  `closeAllConnections`. For HTTP/2, Node ≥24 closes active sessions by
  default. VERIFIED.
- Keep-alive default `keepAliveTimeout: 72000`; `connectionTimeout: 0`;
  `requestTimeout: 0` (docs recommend non-zero e.g. 120 s when not behind a
  proxy). VERIFIED.
- krun shutdown plan maps cleanly: flip readiness → wait
  `KRUN_SHUTDOWN_DELAY` → `preClose` ends SSE → `close()` → `onClose` closes
  DB. SPEC-consistent. VERIFIED (doc semantics).

### @fastify/under-pressure 9.2.1 (README, VERIFIED)
- Options: `maxEventLoopDelay`, `maxHeapUsedBytes`, `maxRssBytes`,
  `maxEventLoopUtilization` (all default 0 = disabled), `message`,
  `retryAfter`, `customError`, `pressureHandler(request, reply, type,
  value)` (global or per-route `config.pressureHandler`), `sampleInterval`
  (1000 ms on modern Node), `eventLoopUtilizationMode: 'interval'`.
- `healthCheck: async (fastify) => boolean | object`, run every
  `healthCheckInterval` ms AND on each status-route call; "service health is
  considered unhealthy until it has started to return true".
- `exposeStatusRoute: true` → `GET /status` `{ status: 'ok' }`; string →
  custom path; object `{ url, routeOpts, routeSchemaOpts,
  routeResponseSchemaOpts }` (`routeSchemaOpts.response` entries merge with
  defaults 200/500/503; `routeSchemaOpts.hide: true` hides from swagger).
  Returned object fields from `healthCheck` need
  `routeResponseSchemaOpts` to be serialised.
- Decorators: `fastify.isUnderPressure()`, `fastify.memoryUsage()`. Uses
  `setTimeout` not `setInterval`.
- UNVERIFIED (not inspected): exact 503 payload shape and whether the plugin
  returns 503 for the status route when `healthCheck` is false (README
  implies yes via default 503 response schema).
- Fit for krun: krun needs `/healthz` (liveness: always 200 while process
  alive) and `/readyz` (503 during shutdown and until informer initial list).
  under-pressure's status route couples both into one `healthCheck`; simpler
  to hand-write `/readyz` and register under-pressure only for load-shedding
  on the public listener (or skip it). Recommendation, not a fact.

### @fastify/swagger 9.9.2 and close-with-grace 2.5.0
- Versions VERIFIED. APIs UNVERIFIED in this session (command execution was
  denied before inspection). Known-from-docs items to confirm: register with
  `{ openapi: { openapi: '3.1.0', info, servers } }`; after `await
  app.ready()` call `app.swagger()` to get the document object (or
  `app.swagger({ yaml: true })`); TypeBox schemas work because they are plain
  JSON Schema — strip `$id`-less `Type.Ref` usage or register shared schemas
  with `app.addSchema({ $id, …})`; route `schema.hide: true` hides a route.
  Confirm against `pkgs/fastify-swagger-9.9.2/package/README.md`.
- close-with-grace: `closeWithGrace({ delay: 500 }, async ({ signal, err,
  manual }) => { await app.close() })` returns `{ close, uninstall }`;
  listens for SIGINT/SIGTERM/uncaughtException/unhandledRejection; `delay`
  is the max time before forced exit. UNVERIFIED (from memory of README; the
  tarball is at `pkgs/close-with-grace-2.5.0/package/README.md`).

---

## 4. Kysely 0.29.7

Version VERIFIED. All API facts below UNVERIFIED in this session (tarball is
unpacked at `pkgs/kysely-0.29.7/package`; check `dist/esm/migration/*.d.ts`,
`dist/esm/dialect/sqlite/*.d.ts`, `dist/esm/dialect/postgres/*.d.ts`,
`dist/esm/raw-builder/sql.d.ts`). Items to confirm, listed with what to look
for:
- `Migrator({ db, provider: new FileMigrationProvider({ fs: fs/promises, path,
  migrationFolder }) , migrationTableName?, migrationLockTableName?,
  allowUnorderedMigrations? })`; default table names `kysely_migration` and
  `kysely_migration_lock`. `FileMigrationProvider` `import()`s every file in
  the folder (ESM dynamic import works for `.ts` under type stripping only
  when the specifier includes the extension — it imports by absolute path so
  fine) and sorts by **file name** (string order), so name migrations
  `0001_init.ts` / ISO timestamps. Each module must export `up(db)` and
  optionally `down(db)`.
- `migrateToLatest()` → `Promise<{ error?: unknown; results?:
  MigrationResult[] }>` where `MigrationResult = { migrationName, direction:
  'Up'|'Down', status: 'Success'|'Error'|'NotExecuted' }`. It does not throw
  — check `error`.
- `sql` tag: `sql<T>\`…${val}…\``, `sql.ref('col')`, `sql.table()`, `sql.raw()`,
  `sql.join([...])`, `sql.lit()`; `.execute(db)` or embed in builders. Tuple
  comparison: use `eb.refTuple('a','b')` with `eb.tuple(x, y)` (Kysely
  ≥0.27 has `refTuple`/`tuple`) → `("a","b") < ($1,$2)`; otherwise
  `sql\`(a, b) < (${x}, ${y})\``.
- `returning('id')`/`returningAll()` on insert/update/delete; SQLite
  (better-sqlite3 ≥ SQLite 3.35) supports RETURNING; Postgres yes.
- `SqliteDialect({ database: new Database(file) | () => Promise<Database> })`
  uses the `better-sqlite3`-compatible `SqliteDatabase` interface
  (`prepare(sql)` → `{ reader: boolean; all(params); run(params) }`, `close()`).
  Transactions are started by `SqliteDriver.beginTransaction` running
  `sql\`begin\``. To get `BEGIN IMMEDIATE`, subclass `SqliteDriver` and
  override `beginTransaction(connection, settings)` to execute
  `begin immediate`, then pass a custom `Dialect` whose `createDriver()`
  returns it (Dialect = `{ createDriver, createQueryCompiler,
  createAdapter, createIntrospector }`). SQLite connection is a single
  connection serialised by a mutex in `SqliteDriver`.
- `PostgresDialect({ pool: new Pool(...) | () => Promise<Pool>,
  onCreateConnection?: async (conn) => void, onReserveConnection? })`; the
  pg `Pool` is owned by you; `db.destroy()` ends it.
- `jsonb`: pg returns parsed objects for json/jsonb by default; insert with
  `JSON.stringify(value)` or `sql\`${JSON.stringify(v)}::jsonb\``; typed via
  `JSONColumnType<T>` helper in table types; `ColumnType<Select, Insert,
  Update>`.
- Kysely is ESM+CJS dual, zero deps.

## 5. Drivers and utilities

Versions VERIFIED (table above). API bullets UNVERIFIED unless noted; tarballs
are unpacked under `pkgs/` for the implementer to confirm quickly.

### better-sqlite3 13.0.3
- Prebuilt binaries: the package uses `prebuild-install` to fetch
  `better-sqlite3-v13.0.3-node-v<ABI>-linux-x64.tar.gz` from GitHub releases;
  Node 24's ABI is `137` (`process.versions.modules`). Whether 13.0.3 ships a
  Node 24 (ABI 137) and Node 26 prebuilt is UNVERIFIED — check the GitHub
  release assets for v13.0.3 before pinning; otherwise the install compiles
  with node-gyp (needs python3 + build-essential in the Docker build stage).
- `db.pragma('journal_mode = WAL')`, `db.pragma('busy_timeout = 5000')`,
  `db.pragma('synchronous = NORMAL')`; `pragma(str, { simple: true })`
  returns the scalar. `busy_timeout` makes a locked write wait up to N ms
  before `SQLITE_BUSY`; it does NOT apply to the deadlock case of a deferred
  transaction upgrading to write while another writer holds the lock
  (that returns SQLITE_BUSY immediately) → hence `BEGIN IMMEDIATE`.
- `db.transaction(fn)` returns a wrapped function; `.immediate(...)`,
  `.deferred(...)`, `.exclusive(...)` variants exist; nested calls become
  savepoints. Kysely does not use this API (it issues `begin` itself).
- Synchronous API; one connection per process is fine for krun embedded mode.

### pg 8.23.1 LISTEN/NOTIFY
- Use a dedicated `new Client(config)` (not the pool) for `LISTEN channel`;
  `client.on('notification', (msg: { channel, payload, processId }) => …)`;
  `client.on('error')` and `client.on('end')` fire on connection loss — on
  either, create a **new** Client (a pg Client cannot reconnect), re-`connect()`,
  re-`LISTEN`, and trigger a full poll because notifications during the gap
  are lost. Payload limit 8000 bytes. `NOTIFY` inside a transaction is
  delivered on commit. Keep the SPEC's 1 s poll as the safety net.

### uuid 14.0.3
- `import { v7 } from 'uuid'` exists since uuid 10; v7 is time-ordered
  (48-bit ms timestamp + counter); the implementation guarantees
  monotonicity **within a process** via an internal sequence counter when
  called multiple times in the same millisecond (per the README's "v7"
  section). Across processes/replicas ordering is only by millisecond.
  Node ≥ 24 does NOT have `crypto.randomUUIDv7` (Bun does) — keep the
  dependency, or use `crypto.randomUUID()` for v4 where ordering is not
  required.

### ajv 8.20.0 + ajv-formats 3.0.1
- `import { Ajv2020 } from 'ajv/dist/2020.js'` (named export `Ajv2020` and
  default) for draft 2020-12 schemas (what Function CRD input schemas should
  declare). `new Ajv2020({ strict: true, allErrors: false, allowUnionTypes:
  false })`; `addFormats(ajv)` from `ajv-formats` (ESM: `import addFormats
  from 'ajv-formats'` — there is a default-export wrapping quirk under
  ESM/CJS interop; `@fastify/type-provider-typebox` handles it with
  `(ajvFormats.default?.default ?? ajvFormats.default ?? ajvFormats)` —
  VERIFIED that the provider needs that workaround, index.ts lines 24-27).
- `ajv.compile(schema)` is synchronous when the schema has no
  `$async: true` and all `$ref`s resolve locally; a `$ref` to an unknown URI
  throws `MissingRefError` at compile time (good: rejection technique is
  "compile and catch"). To forbid `$ref`/`$dynamicRef` altogether validate the
  schema first with a meta-schema that lacks those keywords, or walk the
  schema. `ajv.validateSchema(schema)` checks against the meta-schema.
- `strict: true` rejects unknown keywords, `strictTypes`, `strictTuples`,
  `strictRequired` (off by default). Compiled validators are cached by
  schema object identity, not deep-equal — krun's "cache per uid+generation"
  must hold the compiled function itself.

### prom-client 15.1.3
- `new Registry()`, `collectDefaultMetrics({ register })`, `new Histogram({
  name, help, labelNames, buckets, registers: [register] })`, default
  buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`;
  `exponentialBuckets(start, factor, count)`, `linearBuckets`. `await
  register.metrics()` is async (returns string); set
  `Content-Type: register.contentType`. ESM import: `import { Registry,
  Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client'`
  (CJS package with named-export detection — works in Node).

### undici 8.12.3
- `new Agent({ connect: { lookup: (hostname, opts, cb) => …, servername,
  timeout, rejectUnauthorized } })` — `connect.lookup` has the `dns.lookup`
  signature and is the hook for SSRF pinning (resolve, filter with ipaddr.js,
  return the chosen IP; set `servername: hostname` so TLS SNI/verification
  still uses the original hostname). `fetch(url, { dispatcher: agent,
  redirect: 'manual' })` — with `'manual'`, undici returns the 3xx response
  (`response.status` 301/302…) with `Location` header instead of following
  (note: undici's `redirect: 'manual'` returns the actual response, not an
  opaque-redirect filtered one as browsers do). `signal:
  AbortSignal.timeout(ms)`, `headersTimeout`/`bodyTimeout` on the Agent.
  Prefer `undici`'s `request()` for lower overhead if streaming isn't needed.
  Node 24's global fetch is undici 6.x internally; using the `undici@8`
  package gives a separate implementation — do not mix `Dispatcher` objects
  between global fetch and the package (`setGlobalDispatcher` from the package
  does not affect Node's bundled fetch).

### ipaddr.js 2.5.0
- `ipaddr.process(str)` parses v4 or v6 and converts IPv4-mapped IPv6 to IPv4;
  `addr.range()` returns `'unicast' | 'private' | 'loopback' | 'linkLocal' |
  'multicast' | 'broadcast' | 'carrierGradeNat' | 'reserved' | 'unspecified' |
  'uniqueLocal' | 'ipv4Mapped' | '6to4' | 'teredo' | …`; `ipaddr.subnetMatch
  (addr, { name: [ [ipaddr.parse('169.254.169.254'), 32], … ] }, 'default')`
  for custom lists (block metadata endpoints, `100.64/10` CGNAT, `::ffff:`
  mapped, `64:ff9b::/96` NAT64). Types ship in the package (`lib/ipaddr.js.d.ts`).

### @aws-sdk/s3-request-presigner 3.1156.0
- `getSignedUrl(s3Client, new PutObjectCommand({ Bucket, Key, ContentType,
  ContentLength? }), { expiresIn: 900 })` and `GetObjectCommand` likewise;
  `expiresIn` seconds, max 7 days for SigV4. Signed headers in the command
  (e.g. `ContentType`) must be sent by the uploader exactly. Existence check:
  `await s3.send(new HeadObjectCommand({ Bucket, Key }))` → throws `NotFound`
  (`err.name === 'NotFound'`, `$metadata.httpStatusCode === 404`). For MinIO
  set `forcePathStyle: true` and `endpoint`.

### yaml 2.9.1
- `parseAllDocuments(src)` returns `Document[]` for multi-doc (`---`) files;
  `doc.toJS()` per document; `doc.errors` non-empty → invalid. `parse()`
  throws on multi-document input. For keys.yaml use `parse` (single doc) with
  `{ schema: 'core' }` to avoid YAML 1.1 `yes/no` booleans; `yaml` 2.x
  defaults to YAML 1.2 core schema already.

### testcontainers 12.2.1 / @testcontainers/postgresql 12.2.1
- `const pg = await new PostgreSqlContainer('postgres:17-alpine').start()`;
  `pg.getConnectionUri()`, `pg.getHost()`, `pg.getPort()`, `pg.getDatabase()`,
  `getUsername()/getPassword()`; `await pg.stop()`. MinIO: `new
  GenericContainer('minio/minio').withCommand(['server','/data'])
  .withExposedPorts(9000).withEnvironment({ MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
  }).withWaitStrategy(Wait.forHttp('/minio/health/live', 9000)).start()`;
  `container.getMappedPort(9000)`. Needs a Docker socket; set
  `TESTCONTAINERS_RYUK_DISABLED=true` in CI without privileged Ryuk. Node test
  runner: start containers in `before()` with a generous `timeout` option.

### biome 2.6.2
- `biome.json` with `"$schema": "https://biomejs.dev/schemas/2.6.2/schema.json"`,
  `{ "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "indentStyle": "space", "indentWidth": 2 }, "javascript": {
  "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } },
  "files": { "includes": ["packages/**", "!**/dist"] } }`. Biome 2 uses
  `files.includes` with negations (not `ignore`), and `"vcs": { "enabled":
  true, "clientKind": "git", "useIgnoreFile": true }`. Run `biome check
  --write .` / `biome ci .`. Biome 2 supports `.ts` with `import type`
  enforcement via `style/useImportType`.

### pnpm workspace
- `pnpm-workspace.yaml`: `packages: ['packages/*', 'sdk/*']` and
  `catalog: { fastify: ^5.12.7, … }`; reference with `"fastify": "catalog:"`
  in each package.json; internal deps `"@krun/core": "workspace:*"` (replaced
  with the real version on publish). `pnpm -r --filter ./packages/... run
  test`. pnpm ≥9 for catalogs; pnpm 10 defaults `ignore-scripts`-like
  behaviour for dependencies' build scripts (`onlyBuiltDependencies` must
  list `better-sqlite3` or its native build is skipped silently) — this is a
  well-known pnpm 10 gotcha and highly relevant to better-sqlite3;
  UNVERIFIED here, check pnpm 10 docs.

## 6. Python 3.12 SDK facts

All UNVERIFIED in this session (no network docs fetched for Python; stdlib
behaviour is stable and the implementer can confirm in a REPL):
- `urllib.request.Request(url, data=bytes, method='PUT', headers={...})`,
  `urlopen(req, timeout=10)`; `HTTPError` (has `.code`, `.read()`),
  `URLError` (`.reason`, wraps `socket.timeout`/`TimeoutError`). Retry loop:
  for attempt in range(3): try/except (URLError, TimeoutError, HTTPError with
  code ≥500 or 429) → `time.sleep(base * 2**attempt + jitter)`; do not retry
  4xx other than 429. `HTTPError` is a subclass of `URLError` — catch
  HTTPError first.
- Heartbeat: `t = threading.Timer(interval, fn); t.daemon = True; t.start()`
  (daemon threads do not block interpreter exit; re-arm inside `fn` for
  periodic behaviour, or use a `threading.Thread(target=loop, daemon=True)`
  with `Event.wait(interval)` for clean cancel). Node equivalent is
  `setInterval(...).unref()`.
- `uv init --lib krun` creates `pyproject.toml` with `[build-system] requires
  = ["uv_build>=…"] build-backend = "uv_build"` (uv ≥0.7) or hatchling
  (`requires = ["hatchling"] build-backend = "hatchling.build"`), `src/krun/`
  layout, `[project] requires-python = ">=3.12"`, no runtime deps (stdlib
  only). `uv build` produces sdist+wheel; `uv publish`.
- ruff: `[tool.ruff] line-length = 100 target-version = "py312"`,
  `[tool.ruff.lint] select = ["E","F","I","UP","B"]`; `uv run ruff check .`,
  `uv run ruff format .`.
- pytest from the repo root for a nested project: `uv run --directory
  sdk/python pytest` (or `--project`); add `[tool.pytest.ini_options]
  testpaths = ["tests"]`; `uv add --dev pytest`. With `uv_build`/hatchling
  the package is installed editable into the project venv so `import krun`
  works in tests.

---

## Pitfalls summary

1. Run tests with plain `node --test "packages/**/*.test.ts"` — no
   `--experimental-strip-types`; the flag no longer appears in Node 24 docs and
   stripping is stable/default (24.12+).
2. Every relative import must carry `.ts`; Node does not resolve
   extension-less specifiers or `tsconfig.paths`. Use `#imports` for aliases.
3. Mark type-only imports with `type`; a bare `import { Interface }` throws at
   runtime under stripping. Enforce with `verbatimModuleSyntax`.
4. Ban `enum`, parameter properties, value namespaces and decorators
   (`erasableSyntaxOnly: true`); Node errors on them without
   `--experimental-transform-types`.
5. Node never strips TS under `node_modules`; publish built `.js` for
   `@krun/sdk`/`@krun/cli`, and test the pnpm-symlink case before relying on
   source imports across workspace packages.
6. When faking time for lease/heartbeat tests, enable `'Date'` in
   `mock.timers.enable({ apis })` too — `setTimeout` mocking alone leaves
   `Date.now()` real and the expiry logic will disagree with the timers.
7. Use `--test-isolation=process` (default) for tests touching globals/env;
   `none` runs everything in one process with concurrency 1 and ignores
   `--test-concurrency`.
8. Treat `@kubernetes/client-node` as ESM-only, Node ≥24, undici-backed; do
   not import node-fetch types or `setDefaultAuthentication` (does not exist
   in 2.x).
9. Pass `labelSelector` BOTH to `makeInformer(…, labelSelector)` and inside
   the `listFn` call; the informer only injects it into the watch URL.
10. Implement informer restart yourself: on `'error'` the ListWatch stops for
    good; call `informer.start()` after a backoff (official example uses
    5 s). Only timeouts/clean closes/410 are auto-recovered.
11. Do not log `TimeoutError` from watches/informers as failures — the 30 s
    inactivity timeout is by design and reconnects from the last RV.
12. There is no informer resync; keep SPEC's periodic reconcile over
    `informer.list()` because `update` fires only on resourceVersion change.
13. Override Content-Type for every patch: the generated client defaults to
    `application/json-patch+json`; use `setHeaderOptions('Content-Type',
    PatchStrategy.MergePatch)` (or `ServerSideApply` + `fieldManager` +
    `force`) for status patches.
14. Pass `propagationPolicy: 'Background'` on `deleteNamespacedJob`; the
    API default for Jobs orphans pods.
15. Per-call timeouts: 2.0.1 lacks `setRequestTimeoutOptions`; add a
    middleware calling `ctx.setSignal(AbortSignal.timeout(10_000))`, and
    expect `DOMException` `name === 'TimeoutError'`, not `ApiException`.
16. Classify k8s errors by `instanceof ApiException` → `code`/`body`/`headers`
    (Retry-After); everything else is network/transient.
17. Choose a TypeBox line deliberately: `@fastify/type-provider-typebox@6`
    requires `typebox@1` (ESM-only, TS ≥6); for `@sinclair/typebox@0.34` pin
    the provider to `5.2.0`. Mixing yields missing-peer and type mismatch.
18. Chain `Fastify().withTypeProvider<TypeBoxTypeProvider>()` at construction;
    calling it later on the instance does not type routes.
19. Keep Fastify's Ajv for validation (not `TypeBoxValidatorCompiler`) so
    `additionalProperties: false`, `format` and ajv-formats behave like the
    function-input validator; set per-route `bodyLimit` for result uploads.
20. `requestIdHeader` defaults to `false` in Fastify 5; opt in explicitly or
    set `genReqId` to a UUID — and never trust a client-supplied id for
    security decisions.
21. `trustProxy` numeric hop counts are rejected in 5.12.x; pass CIDR strings
    or a function.
22. Put API-key auth in `onRequest` (no body yet) and idempotency/body-hash
    logic in `preHandler`; `request.body` is undefined before `preValidation`.
23. For SSE call `reply.hijack()` then `reply.raw.writeHead(...)`; headers
    set via `reply.header()` are not flushed through `raw`; end all SSE
    streams in a `preClose` hook or `close()` never resolves.
24. One Fastify instance per listener (public 8080, internal 8081, admin
    9090) and `host: '0.0.0.0'`/`'::'` — the default host is `localhost`.
25. `fastify.close()` already returns 503 to new requests
    (`return503OnClosing`); default `forceCloseConnections: 'idle'` keeps
    in-flight requests alive — do not set `true` unless you accept cut
    responses.
26. Redact `req.headers.authorization` and `x-api-key` via `logger.redact`;
    pino redaction paths are fast-redact syntax.
27. `@kubernetes/client-node` depends on `@types/node ^26`; pin krun's
    `@types/node@24` and add a pnpm override if duplicate global types break
    `tsc`.
28. With pnpm 10, list `better-sqlite3` in `onlyBuiltDependencies` or its
    native binary is never built/downloaded (UNVERIFIED but high-risk).
29. For SQLite writes under contention subclass Kysely's `SqliteDriver` to
    issue `BEGIN IMMEDIATE`; `busy_timeout` alone does not prevent
    SQLITE_BUSY on deferred-transaction write upgrades.
30. pg LISTEN clients cannot reconnect: on `error`/`end` build a new Client,
    re-LISTEN and run an immediate poll to cover the gap.
