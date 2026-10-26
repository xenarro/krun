# krun technology stack

Status: normative, 2026-10-23. Versions verified against the npm registry
on that date. Runtime: Node.js 26 (LTS to April 2029). PLAN.md section 2 is the dependency allowlist and points
here for the reasons; SPEC.md D35 records the decision. A library not in
this file needs a Decisions row before it is added.

## 1. Principles

1. **Effect is the foundation of every process.** Gateway, scheduler,
   `krun migrate` and the CLI are Effect programs: services are
   `Context.Service`s, wiring is `Layer`s, failures are typed, resources
   are scoped, time comes from `Clock`. Fastify is the HTTP engine inside
   that program, not the other way round.
2. **One schema language: Zod.** Every boundary schema (HTTP bodies and
   query strings, the `Function` spec, environment variables, `keys.yaml`,
   internal API bodies) is a Zod 4 schema. JSON Schema and OpenAPI are
   generated from Zod, never written by hand. Effect Schema
   (`effect/schema`) is not used: two schema languages would mean two
   sources of truth.
3. **Ajv only for user-supplied schemas.** A Function's `inputSchema` is
   arbitrary JSON Schema 2020-12 authored by a function team; Zod cannot
   execute it. Ajv compiles it; nothing else uses Ajv.
4. **No date library.** Effect's `DateTime`, `Duration` and `Clock` cover
   every need (RFC 3339 UTC with milliseconds, the duration grammar, leases,
   deadlines) and make every timer testable with `TestClock`. Node 26 ships
   `Temporal` natively; krun code does not use it, because it bypasses
   `Clock`. date-fns, Day.js and Luxon are rejected (section 2.7).
7. **Effect before a utility package.** Retries, concurrency limits,
   caches, pattern matching, `Option`/`Result`, array and record helpers
   come from Effect. A utility package is added only for a job Effect does
   not do (section 2.7).
8. **No native addons.** Every runtime dependency is pure JavaScript or
   built into Node, so the image needs no build toolchain and no ABI
   rebuild on a Node upgrade.
5. **Stable APIs only in the core path.** Effect 4 marks some modules
   `@stability unstable` (may break in minor releases). krun uses them only
   where this file says so, pinned to an exact minor.
6. **The Node.js SDK stays dependency-free and Effect-free.** It runs inside
   other teams' images.

## 2. Runtime dependencies

Versions are the ranges to put in `package.json`; `pnpm-lock.yaml` pins
exact versions.

### 2.1 Foundation

| Package | Range | Use | Rules |
|---|---|---|---|
| `effect` | `~4.0.6` | Effect, Layer, Context, Scope, Schedule, Stream, Queue, Semaphore, Clock, DateTime, Duration, Data.TaggedError, Logger, ManagedRuntime | Core modules from `effect` only. Subpath modules (`effect/sql`, `effect/http`, `effect/cli`, `effect/schema`, ...) are not used in v1. Tilde range: Effect ships ecosystem packages in lockstep. 4.x has bug fixes until September 2029. |
| `@effect/platform-node` | `~4.0.6` | `NodeRuntime.runMain`: process entry, SIGTERM and SIGINT turn into fiber interruption, finalizers run, exit code set | Same version as `effect`. Its `Undici` module is unstable and not used. |
| `zod` | `^4.6` | every boundary schema; `z.toJSONSchema` for the CRD (`target: "openapi-3.0"`) and editor schema (`draft-2020-12`) | `z.strictObject` for request bodies (unknown fields rejected), `.optional()` never `.nullable()` on API shapes, `.meta({ description })` for documentation. |

### 2.2 HTTP

| Package | Range | Use | Rules |
|---|---|---|---|
| `fastify` | `^5.12` | the three listeners (public, internal, admin), routing, body limits, pino logging | One Fastify instance per listener. `setErrorHandler` and `setNotFoundHandler` render the AIP-193 envelope. |
| `fastify-type-provider-zod` | `^7.0` | Zod schemas on routes: validation, serialisation, static types | `validatorCompiler`, `serializerCompiler`, `jsonSchemaTransform` for swagger. Peer: `zod >= 4.1.5`, `fastify ^5.5`. |
| `@fastify/swagger` | `^9.9` | OpenAPI 3.1 documents generated from the routes into `docs/api/` | Generation only; no UI is served. |
| `undici` | `^8.12` | webhook delivery through a pinned-address `Agent` (`connect.lookup`) | Also the transport under `@kubernetes/client-node`. |

Fastify's pino dependency currently resolves `thread-stream@4.2.0`. Its
published `TransferListItem` declaration is incompatible with Node 26 types.
SPEC D39 records the tracked, declaration-only pnpm patch deriving that type
from `Worker.postMessage`; runtime JavaScript is unchanged. Do not replace
this with `skipLibCheck`, a Node-type downgrade or a supply-chain exception.
The container copies the patch before both frozen installs.

The gateway imports the approved Fastify 5/Zod 4 provider compilers directly.
`fastify-type-provider-zod` 7's published declarations require the approved
`@fastify/swagger` peer even before OpenAPI generation is wired. Declare it as
a gateway development dependency for strict type checking, not an application
Swagger listener; keep `autoInstallPeers` disabled and use the normal guarded
installation. Its compiler runtime does not import Swagger. P3.1c uses the
existing development dependency in `apps/gateway/dev/openapi.ts`: real dynamic
Swagger/provider transforms over the shared public Zod route descriptors write
OpenAPI3.1 without installing production methods or opening a listener. A scoped
registry plus the native conversion hook preserves nested metadata without global
component registration; unsupported conversion fails closed. A body-less 307 is
modeled with JSON Schema never before its content is omitted. D57 adds exact
opaque custom-leaf projection (all other unrepresentable leaves still throw) and
bidirectional nested codecs for ignored output-only request members. This keeps
the strict request root and ordinary response validation unchanged. No handwritten declarations,
skipped library checks, new dependency or unused-dependency exception is needed.

The shared HTTP observability adapter (P3.1b, SPEC D54) uses Fastify's native
pino instance and public LogController callbacks, not an added logger/plugin.
Root/request/Effect logging uses one configured redaction policy per listener;
request fibers replace CurrentLoggers and map KRUN_LOG_LEVEL to MinimumLogLevel.
The captured Effect context preserves Clock and the Telemetry-owned MetricRegistry
at native callback edges. Isolated factories without Config retain its info
default; production wiring supplies Config normally. No module reads ambient env.

### 2.3 Data

| Package | Range | Use | Rules |
|---|---|---|---|
| `kysely` | `^0.29` | typed SQL for both dialects, `Migrator` with `FileMigrationProvider` | Wrapped in an Effect `Database` service; every query runs through `Effect.tryPromise` and maps failures to tagged errors. Requires Node 22 or newer. Postgres 16 or newer; CI runs against 18. |
| `pg` | `^8.23` | Postgres driver for Kysely's `PostgresDialect`; a dedicated client for `LISTEN` | Pool size 5 plus the `LISTEN` client; `query_timeout` 10000. |
| `node:sqlite` | built into Node 26 | SQLite in embedded mode | Release candidate in Node 26. Kysely reaches it through an in-house `SqliteDialect`-compatible adapter (`packages/shared/src/store/sqlite/dialect.ts`, about 40 lines over `Database.prepare`); synchronous; transactions open with `begin immediate`. |

SPEC D43 requires the in-house SQLite adapter to override
`SqliteAdapter.supportsTransactionalDdl` to `true`, alongside the
`begin immediate` driver. Kysely 0.29.7 otherwise leaves partial schema
changes after a failed multi-statement migration. Preserve its existing
single-connection mutex and normal migration-history validation.

Alternatives not used: `better-sqlite3` (native addon); Drizzle ORM (1.0 still a release candidate; its Effect
integration is beta); `@effect/sql-kysely` (supports Effect 3 and
Kysely 0.28 only); `@effect/sql-pg` with `@effect/sql-sqlite-node` (Effect
4 native, but `effect/sql` is marked unstable and models rows with Effect
Schema, against principle 2). Revisit when `effect/sql` is stable.

### 2.4 Kubernetes and storage

| Package | Range | Use | Rules |
|---|---|---|---|
| `@kubernetes/client-node` | `^2.0` | Jobs, Pods, Secrets, Leases, Functions (CustomObjectsApi), informers | 2.x runs on undici. Wrapped in a `Kube` service: every call under the `KRUN_K8S_CONCURRENCY` semaphore and a 10 s `Effect.timeout`; informers exposed as `Stream`s. D86: Job/Pod informers use makeInformer’s public `ListWatch` cache with a scoped `Watch` subclass; native typed LIST and watch handshakes share that bound, watch bodies follow the leader scope, initial sync follows processed LIST rather than connect. |
| `@aws-sdk/client-s3` | `^3.1156` | object existence check | `requestChecksumCalculation: "WHEN_REQUIRED"`. |
| `@aws-sdk/s3-request-presigner` | `^3.1156` | presigned PUT (host only signed) and GET | No signed `Content-Type`. |

### 2.5 Utilities

| Package | Range | Use | Rules |
|---|---|---|---|
| `ajv` | `^8.20` | compile Function `inputSchema` (`Ajv2020`, `strict: true`, no `loadSchema`) | Never for krun's own application/runtime schema validation. Development-only tests may evaluate generated editor JSON Schema for standards conformance (SPEC D41); its sole definition remains Zod. |
| `ajv-formats` | `^3.0` | `format` keywords and the default format-comparison plugin keywords in `inputSchema` | Register the actual plugin, not only its internal format-definition table. |
| `uuid` | `^14.0` | UUIDv7 run, delivery and request ids | `v7({ msecs })` with the time from `Clock`, so ids are deterministic under `TestClock`. |
| `canonicalize` | `^5.1` | RFC 8785 (JCS) serialisation for `request_hash` | Reference implementation by the RFC's author. |
| `yaml` | `^2.9` | `keys.yaml`, Function documents for `krun validate` | Parsed value goes straight into a Zod schema. |
| `ipaddr.js` | `^2.5` | webhook address classification and CIDR allowlist | |
| `picomatch` | `^4.0` | API key function globs (`report-*`) and webhook host globs | Never a hand-written glob regex; `picomatch(pattern, { nocase: false, dot: true })`, compiled once per reload. |
| `pino` | bundled with Fastify | JSON logs | The Effect `Logger` writes to the Fastify pino instance, so every line has one format and the redaction rules apply everywhere; lines inside a span carry `traceId` and `spanId`. |

SPEC D48 records the tracked Ajv 8.20.0 compiler patch: retain every own
JSON schema-map key and use null-prototype membership/evaluation dictionaries,
including dependency-map splitting. This corrects omitted `__proto__`
constraints without banning/renaming user fields or transforming schemas.
Published TypeScript and runtime JavaScript are patched together. Both frozen
container installs apply the same patch; tests cover properties, patterns,
additional/unevaluated properties, local references, dependencies and ordinary
prototype-named controls. Strictness, synchronous compilation, no loader,
release-age checks and SDK runtime-dependency rules are unchanged.

### 2.6 Observability

| Package | Range | Use | Rules |
|---|---|---|---|
| `@effect/opentelemetry` | `~4.0.6` | Effect spans and metrics to OpenTelemetry (`NodeSdk.layer`) | Same version as `effect`. |
| `@opentelemetry/api` | `~1.9.0` | | SDK 2.12 peers require `<1.10.0`; a caret on 1.9 would still admit 1.10 (SPEC D38). |
| `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base` | `^2.12` | tracer provider, batch span processor | Stay on 2.x: `@effect/opentelemetry` 4.0.6 peers on `<3`. |
| `@opentelemetry/sdk-metrics`, `@opentelemetry/resources` | `^2.12` | meter provider, service resource | 2.x, same reason. |
| `@opentelemetry/exporter-prometheus` | `~0.223` | `/metrics` on the admin listener | 0.2xx line (peer `<0.300`); mounted on the admin Fastify instance, not its own port. |
| `@opentelemetry/exporter-trace-otlp-http` | `~0.223` | OTLP/HTTP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | |
| `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/semantic-conventions` | `~0.223`, `~0.223`, `^1.43` | peers of `@effect/opentelemetry` | logs stay in pino; OpenTelemetry logs are not exported in v1 |

Metrics are Effect `Metric`s (counters, gauges, histograms). Instrument
names are chosen so the Prometheus exporter's suffixes yield exactly the
names in SPEC.md section 11; PLAN P4.6 asserts them on `/metrics`.

### 2.7 CLI only (`packages/cli`)

| Package | Range | Use |
|---|---|---|
| `@clack/prompts` | `^1.8` | interactive `krun init` when `--lang` is missing on a TTY; spinners for `krun deploy` steps |
| `picocolors` | `^1.1` | coloured status lines; respects `NO_COLOR` |
| `tinyexec` | `^1.3` | runs `docker` and `kubectl` from `krun deploy`, wrapped in Effect |

Arguments are parsed with `node:util` `parseArgs`. `krun init --name`
defaults to the target directory's name; a missing `--lang` prompts on a
TTY and fails with a usage message otherwise. Non-TTY runs never prompt.

### 2.8 Utility libraries considered

Weekly npm downloads on 2026-10-23 in parentheses.

| Need | Chosen | Rejected, and why |
|---|---|---|
| validation | Zod 4 (207M) | Valibot (13M), ArkType (1.3M): smaller or faster, but Zod has the Fastify type provider and `z.toJSONSchema` targets krun needs; Effect Schema: second schema language |
| dates and times | Effect `DateTime`, `Duration`, `Clock` | date-fns (56M), Day.js (44M), Luxon (24M), `temporal-polyfill`, native `Temporal`: none integrates with `TestClock` |
| collection helpers | Effect `Array`, `Record`, `Struct`, `String` | es-toolkit (34M), lodash-es (30M), Remeda (7M): duplicate Effect |
| pattern matching, results | Effect `Match`, `Option`, `Result` | ts-pattern (3.8M), neverthrow (1.9M) |
| retries, timeouts, circuit breaking | Effect `Schedule`, `Effect.timeout` | p-retry (32M), cockatiel (1.2M) |
| concurrency limits | Effect `Semaphore`, `Effect.forEach({ concurrency })` | p-limit (202M) |
| caching | a `Map` keyed by uid and generation; Effect `Cache` if eviction is ever needed | lru-cache (349M) |
| ids | `uuid` v7 (174M) | nanoid (167M), ULID (6.8M), cuid2: not time-ordered UUIDs, D9 |
| globs | `picomatch` (316M) | minimatch (427M): slower, larger; hand-written regex: error-prone at a trust boundary |
| environment | a Zod schema over `process.env` | `@t3-oss/env-core` (2.9M), envalid (0.4M): wrappers over the same idea |
| HTTP client | `undici` (133M) and global `fetch` | ky (4M), ofetch (16M): no pinned-address dispatcher |
| child processes | `tinyexec` (100M), CLI only | execa (100M): larger, more features than `krun deploy` needs |
| CLI arguments | `node:util` `parseArgs` | commander (314M), citty (21M), cac (30M): three subcommands do not need them |
| CLI prompts and colour | `@clack/prompts` (18M), `picocolors` (151M) | ora (55M), consola (33M) |
| canonical JSON | `canonicalize` (3M), RFC 8785 reference implementation | `safe-stable-stringify` (39M): not RFC 8785 |
| YAML | `yaml` (133M) | js-yaml: no CST, weaker errors |
| HTTP mocking in tests | local `http.createServer` and undici `MockAgent` | msw (13M): browser-oriented, not needed for server tests |

Node built-ins: `node:crypto` (SHA-256, HMAC, `timingSafeEqual`,
`randomBytes`), `node:dns/promises`, `node:fs`, `node:util` `parseArgs`
for the CLI.

## 3. Development dependencies

| Package | Range | Use |
|---|---|---|
| `typescript` | `^7.0` | `tsc` (native compiler) for type-checking and emitting `dist/` |
| `vitest` | `^5.0` | test runner for every TypeScript package; requires Node 22.12, 24 or 26 |
| `vite` | `^8.3` | required peer of Vitest 5, development only (SPEC D37); never used to bundle application code or shipped in the runtime image |
| `@effect/vitest` | `~4.0.6` | `it.effect` (already scoped; there is no `it.scoped` in 4.x), `layer(...)`, `TestClock` for every Effect test |
| `fast-check` | `^4.10` | property tests: request fingerprint, filter parser, duration grammar, address checks |
| `testcontainers` | `^12.2` | Postgres and MinIO in integration tests |
| `@testcontainers/postgresql` | `^12.2` | |
| `@testcontainers/minio` | `^12.2` | |
| `@biomejs/biome` | `^2.6` | lint and format |
| `@types/node` | `^26` | |
| `@types/pg` | latest | |
| `@types/picomatch` | `^4.0` | development-only declarations for the approved picomatch 4 runtime (SPEC D47) |
| `knip` | `^6.42` | unused files, exports and dependencies; runs in `make check` |
| `publint`, `@arethetypeswrong/cli` | `^0.3`, `^0.18` | package export checks for `@krun/sdk` and `@krun/cli` before publish (P9.5) |

Testcontainers' transitive `cpu-features`, `ssh2` and `protobufjs` install
scripts are explicitly denied by pnpm 12's `allowBuilds` map (SPEC D44).
The SSH/CPU accelerators are optional and protobufjs only warns about
version notation; local Docker/Postgres tests require none of these scripts.
Preserve the deny rules, strict release-age policy and disabled automatic peers.

Editor only, never in CI: `@effect/tsgo` (Effect diagnostics on the
TypeScript 7 language server; alpha).

TypeScript settings in `tsconfig.base.json`: `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `module` and `moduleResolution` `nodenext`,
`target` `es2025`. Erasable syntax only (no enums, no parameter
properties), so sources stay runnable under Node's type stripping for
quick scripts.

Internal workspace consumers declare `@krun/shared: workspace:*` and import
its built `dist` subpaths. `pnpm -r build` orders shared before its consumers;
`make lint` depends on that build so a clean checkout has declarations before
consumer no-emit checks (SPEC D50). Keep each package's existing source/output
root, native ESM and full type/lint checks; do not copy schemas or bundle shared.

Python SDK (`sdk/python`): Python 3.11 or newer, standard library only at
runtime; `uv`, `ruff`, `pytest`, `hypothesis` (property tests, the
counterpart of fast-check), `mypy --strict` for development.

Tools on the agent machine (PLAN.md section 2): Node 26, pnpm, uv, Docker,
Helm 4, kind 0.31 or newer, kubectl, actionlint, gh, helm-docs, promtool;
in CI also Trivy, cosign, syft. OpenSSL CLI is a test-only prerequisite
for owned ephemeral webhook TLS receiver certificates; the Node trust
store is restored and the generated key/certificate are deleted after
each test. It is not an application runtime dependency or a TLS bypass.

## 4. How the pieces fit

### 4.1 Process shape

```ts
// apps/gateway/src/main.ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

const Main = Layer.mergeAll(PublicServer, InternalServer, AdminServer).pipe(
  Layer.provide(AppLayer), // Config, Logger, Database, Store, Functions, Keys
  Layer.provide(Telemetry), // @effect/opentelemetry NodeSdk: tracer, meter, Prometheus reader
)
NodeRuntime.runMain(Layer.launch(Main))
```

- Each Fastify listener is a scoped layer: acquire builds the instance and
  calls `listen`; release flips readiness to 503, waits
  `KRUN_SHUTDOWN_DELAY`, closes the listener, ends SSE streams and answers
  in-flight waits. Finalizers run in reverse order, so the database pool
  closes last.
- Route handlers run Effects with the services captured when the layer was
  built (a `ManagedRuntime` or the captured context, whichever Effect 4
  documents for embedding; follow `MIGRATION.md` and the runtime guide).
  The client's abort signal is passed in, so a disconnect interrupts the
  handler's fiber.
- The scheduler has the same shape with the admin listener only; its loops
  are fibers forked into the leader scope.

### 4.2 Errors

- Public gateway failures use `ApiError`, a `Data.TaggedError` with a closed
  `reason` union mapped to API section 4 (SPEC D52). Other domain failures
  are `Data.TaggedError` classes (`FunctionNotFound`,
  `RunNotFound`, `QueueFull`, `IdempotencyConflict`, `TokenInvalid`, ...);
  the store's own `NotFoundError` and `ConflictError` (PLAN P1.1) are
  translated into them at the gateway.
  One function maps each tag to its AIP-193 envelope (docs/API.md section
  4, docs/INTERNAL-API.md section 6); a defect is 500 `INTERNAL`.
- Infrastructure failures (`DatabaseError`, `KubeApiError` with the HTTP
  status, `ObjectStoreError`) are tagged too; the scheduler's transient and
  permanent classification (SPEC.md section 8) is a function of the tag
  and status.
- No `throw` in application code outside adapters; adapters convert
  rejections with `Effect.tryPromise`.

### 4.3 SPEC rules mapped to Effect

| SPEC rule | Effect construct |
|---|---|
| `KRUN_K8S_CONCURRENCY` cap | `Semaphore` around every Kubernetes call |
| metrics in SPEC section 11 | Effect `Metric`, exported by the OpenTelemetry Prometheus exporter |
| spans for requests, iterations, store and Kubernetes calls | `Effect.withSpan`, exported over OTLP when configured |
| API key and webhook host globs | `picomatch` matchers compiled at load |
| 10 s per API call, 5 s per internal store call, 2 s readiness check | `Effect.timeout` |
| retries with backoff | `Effect.retry` with `Schedule.exponential` and `Schedule.recurs` |
| main loop every second, sweep every 10 minutes, heartbeat every 10 s | `Effect.repeat` with `Schedule.spaced` |
| coalesced `state` notifies, no overlapping iterations | one loop fiber reading a sliding `Queue` of capacity 1 |
| 10 s iteration deadline | `Effect.timeout` on the iteration, leases released in `Effect.ensuring` |
| leader election | a scoped layer whose renew fiber interrupts the leader scope (loops, informers) on loss |
| informers | `Stream` built from the client-node informer events; the reconcile timer is a `Schedule` |
| SIGTERM order | scope finalizers |
| leases, deadlines, staleness, `reportTime` | `Clock` and `DateTime`; `TestClock` in tests |
| durations in config and the CRD | Zod refinement of `^\d+(ms|s|m|h)$` into `Duration` |

### 4.4 Time

- Application code never calls `Date.now()` or `new Date()`. It reads
  `Clock.currentTimeMillis` or `DateTime.now`; formats with
  `DateTime.formatIso` (RFC 3339, UTC, milliseconds); compares with
  `DateTime` and `Duration`.
- Database timestamps are written from `DateTime` values: `timestamptz` in
  Postgres, RFC 3339 text in SQLite.
- Tests advance time with `TestClock.adjust`; no test sleeps.

## 5. Skills for the implementing agent

Claude Code skills. Seven are vendored in this repository under
`.claude/skills` (pinned by `skills-lock.json`), so any checkout has them:
`fastify-best-practices`, `kysely`, `node`, `pnpm`,
`helm-chart-scaffolding`, `kubernetes-operator`, `kubernetes-skill`. The
others are installed at user level on the owner's machine; an agent on
another machine without them works from this file and the libraries' own
documentation. Load the ones for the task before writing code (`Skill`
tool). Where a skill predates Effect 4,
Effect's `MIGRATION.md` and this file win: `Context.Tag` is
`Context.Service`, there is no `Runtime<R>`, `FiberRef` is
`Context.Reference`.

| Area | Skills | Phases |
|---|---|---|
| Effect | `effect-core-patterns`, `effect-error-handling`, `effect-dependency-injection`, `effect-resource-management`, `effect-concurrency`, `effect-testing` | all |
| Fastify | `fastify-best-practices` | 0, 3, 5 |
| Data | `kysely`, `using-relational-databases` | 1 |
| Observability | `observability-and-instrumentation`, `agent-observability` (span and redaction rules only) | 0, 4 |
| Node and workspace | `node`, `pnpm`, `typescript-project-contracts` | 0, all |
| Kubernetes | `kubernetes-operator` (informers, reconcile), `kubernetes-skill`, `operating-kubernetes`, `kubernetes-hardening` | 4, 7, 9 |
| Chart | `helm-chart-scaffolding` | 7 |
| API | `designing-apis`, `api-and-interface-design` | 3, 5 |
| Security | `security-and-hardening` | 2, 3, 9 |
| Tests | `test-driven-development`, `testing-strategies`, `pytest-advanced` | all, 8 |
| Build and CI | `building-ci-pipelines`, `github-actions-advanced`, `dockerfile-optimise` | 0, 9 |
| CLI | `building-clis` | 2, 8 |
| Python SDK | `python-patterns`, `python-type-system` | 8 |
| Process | `incremental-implementation`, `git-workflow-and-versioning`, `code-review-and-quality` | all |

## 6. Upgrade policy

- Renovate proposes updates; CI decides. Effect packages move together in
  one pull request, always the same version.
- A major version of any runtime dependency needs a Decisions row.
- Before v0.1.0, re-check that `effect/sql` is still unstable and
  `@effect/sql-kysely` still Effect 3 only; if either changed, record the
  choice again.
