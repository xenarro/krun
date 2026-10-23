# krun technology stack

Status: normative, 2026-10-23. Versions verified against the npm registry
on that date. PLAN.md section 2 is the dependency allowlist and points
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
   deadlines) and make every timer testable with `TestClock`.
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

### 2.3 Data

| Package | Range | Use | Rules |
|---|---|---|---|
| `kysely` | `^0.29` | typed SQL for both dialects, `Migrator` with `FileMigrationProvider` | Wrapped in an Effect `Database` service; every query runs through `Effect.tryPromise` and maps failures to tagged errors. Requires Node 22 or newer. |
| `pg` | `^8.23` | Postgres driver for Kysely's `PostgresDialect`; a dedicated client for `LISTEN` | Pool size 5 plus the `LISTEN` client; `query_timeout` 10000. |
| `better-sqlite3` | `^13.0` | SQLite for Kysely's `SqliteDialect` in embedded mode | Synchronous; `begin immediate` through a `SqliteDriver` subclass. Native addon: glibc base image, prebuilt binary for Node 24. |

Considered and rejected: `@effect/sql-kysely` (supports Effect 3 and
Kysely 0.28 only); `@effect/sql-pg` with `@effect/sql-sqlite-node` (Effect
4 native, but `effect/sql` is marked unstable and models rows with Effect
Schema, against principle 2). Revisit when `effect/sql` is stable.

### 2.4 Kubernetes and storage

| Package | Range | Use | Rules |
|---|---|---|---|
| `@kubernetes/client-node` | `^2.0` | Jobs, Pods, Secrets, Leases, Functions (CustomObjectsApi), informers | 2.x runs on undici. Wrapped in a `Kube` service: every call under the `KRUN_K8S_CONCURRENCY` semaphore and a 10 s `Effect.timeout`; informers exposed as `Stream`s. |
| `@aws-sdk/client-s3` | `^3.1156` | object existence check | `requestChecksumCalculation: "WHEN_REQUIRED"`. |
| `@aws-sdk/s3-request-presigner` | `^3.1156` | presigned PUT (host only signed) and GET | No signed `Content-Type`. |

### 2.5 Utilities

| Package | Range | Use | Rules |
|---|---|---|---|
| `ajv` | `^8.20` | compile Function `inputSchema` (`Ajv2020`, `strict: true`, no `loadSchema`) | Never for krun's own schemas. |
| `ajv-formats` | `^3.0` | `format` keywords in `inputSchema` | |
| `uuid` | `^14.0` | UUIDv7 run, delivery and request ids | `v7({ msecs })` with the time from `Clock`, so ids are deterministic under `TestClock`. |
| `canonicalize` | `^5.1` | RFC 8785 (JCS) serialisation for `request_hash` | Reference implementation by the RFC's author. |
| `yaml` | `^2.9` | `keys.yaml`, Function documents for `krun validate` | Parsed value goes straight into a Zod schema. |
| `ipaddr.js` | `^2.5` | webhook address classification and CIDR allowlist | |
| `prom-client` | `^15.1` | Prometheus metrics on the admin listener | Effect `Metric` is not used; one registry per process. |
| `pino` | bundled with Fastify | JSON logs | The Effect `Logger` is replaced by one that writes to the Fastify pino instance, so every line has one format and the redaction rules apply everywhere. |

Node built-ins: `node:crypto` (SHA-256, HMAC, `timingSafeEqual`,
`randomBytes`), `node:dns/promises`, `node:fs`, `node:util` `parseArgs`
for the CLI.

### 2.6 Removed from the earlier plan

| Package | Replaced by |
|---|---|
| `@sinclair/typebox`, `@fastify/type-provider-typebox`, `json-schema-to-ts` | Zod 4 with `fastify-type-provider-zod` and `z.toJSONSchema` |
| `@fastify/under-pressure` | a five-line readiness route on the admin listener |
| `close-with-grace` | `NodeRuntime.runMain` and scope finalizers |
| `node:test` | Vitest with `@effect/vitest` |

## 3. Development dependencies

| Package | Range | Use |
|---|---|---|
| `typescript` | `^7.0` | `tsc` (native compiler) for type-checking and emitting `dist/` |
| `vitest` | `^5.0` | test runner for every TypeScript package; requires Node 22.12 or 24 |
| `@effect/vitest` | `~4.0.6` | `it.effect`, `it.scoped`, `layer(...)`, `TestClock` for every Effect test |
| `fast-check` | `^4.10` | property tests: request fingerprint, filter parser, duration grammar, address checks |
| `testcontainers` | `^12.2` | Postgres and MinIO in integration tests |
| `@testcontainers/postgresql` | `^12.2` | |
| `@testcontainers/minio` | `^12.2` | |
| `@biomejs/biome` | `^2.6` | lint and format |
| `@types/node` | `^24` | |
| `@types/better-sqlite3`, `@types/pg` | latest | |

Editor only, never in CI: `@effect/tsgo` (Effect diagnostics on the
TypeScript 7 language server; alpha).

TypeScript settings in `tsconfig.base.json`: `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `module` and `moduleResolution` `nodenext`,
`target` `es2024`. Erasable syntax only (no enums, no parameter
properties), so sources stay runnable under Node's type stripping for
quick scripts.

Python SDK (`sdk/python`): Python 3.11 or newer, standard library only at
runtime; `uv`, `ruff`, `pytest`, `mypy --strict` for development.

Tools on the agent machine (PLAN.md section 2): Node 24, pnpm, uv, Docker,
Helm 4, kind 0.24 or newer, kubectl, actionlint, gh, helm-docs, promtool;
in CI also Trivy, cosign, syft.

## 4. How the pieces fit

### 4.1 Process shape

```ts
// apps/gateway/src/main.ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

const Main = Layer.mergeAll(PublicServer, InternalServer, AdminServer).pipe(
  Layer.provide(AppLayer), // Config, Logger, Database, Store, Functions, Keys, Metrics
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

- Domain failures are `Data.TaggedError` classes (`FunctionNotFound`,
  `RunNotFound`, `QueueFull`, `IdempotencyConflict`, `TokenInvalid`, ...).
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
`Context.Service`, `Runtime<R>` is gone, `FiberRef` is
`Context.Reference`.

| Area | Skills | Phases |
|---|---|---|
| Effect | `effect-core-patterns`, `effect-error-handling`, `effect-dependency-injection`, `effect-resource-management`, `effect-concurrency`, `effect-testing` | all |
| Fastify | `fastify-best-practices` | 0, 3, 5 |
| Data | `kysely`, `using-relational-databases` | 1 |
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
