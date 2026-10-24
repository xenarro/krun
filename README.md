# krun

HTTP-triggered functions, executed as one-off Kubernetes Jobs. Callers submit JSON input over HTTP and observe durable status, results and failures without holding Kubernetes credentials.

## Development status

The scaffold, configuration and admin health/telemetry layers are implemented. This is not a runnable function platform yet:

- Strict TypeScript workspace on Node.js 26, with Effect 4 process entrypoints.
- Zod configuration schemas and Effect services for gateway and scheduler settings.
- Dependency-free Node.js and Python SDK package skeletons; SDK runtime behavior is pending.
- Digest-pinned, non-root distroless container packaging.
- CI checks for types, formatting, tests, unused code, generated files, container packaging, chart lint and critical vulnerabilities.

Admin health and telemetry are implemented as reusable scoped layers, not yet wired into the finite process commands. The separate admin app serves `/healthz`, Ref-backed `/readyz` with a two-second database timeout, initial Function-LIST and shutdown gates, and non-gating leader status. `TelemetryLive` bridges Effect metrics to the OpenTelemetry Prometheus exporter on `/metrics` without an exporter-owned port or global registry. When a parsed OTLP endpoint is set it installs the real HTTP batch trace exporter, using the parsed service name and explicit sampler; otherwise traces are not exported. Scope exit closes the reader and flushes/shuts down tracing. Invalid sampler values fall back nonfatally with variable-name-only warnings; an invalid endpoint disables tracing without disabling metrics.

Readiness's HTTP deadline does not wait for database cancellation cleanup. Overlapping probes share at most one DB worker; the readiness layer owns that worker until its cleanup completes, so repeated timeouts cannot accumulate abandoned checks. Client disconnects cancel both Effect-backed admin routes. Admin scope release cancels and settles active handlers before dependent layers close. Cleanup remains cooperative: uninterruptible cleanup is awaited by its owner, not detached or forcibly discarded.

Health/telemetry acceptance covers real Prometheus collection through Fastify `inject`, stalled-database timing through `TestClock` (including slow finalizers and uninterruptible work), real socket disconnects, handler/dependency teardown ordering, reader/provider cleanup, and actual OTLP JSON sent to a disposable local collector. Run `pnpm exec vitest run packages/shared/src/health packages/shared/src/runtime` for this slice. P0.7 module acceptance and hosted CI passed for [PR #3](https://github.com/xenarro/krun/pull/3), including the reviewed lifecycle repairs, container rebuild, smoke, audit and fixable-critical scan. [Code CI](https://github.com/xenarro/krun/actions/runs/40019565091) verified reconciled head `9f870d4`, containing implementation commit `afc0375`. The PR remains unmerged pending required independent approval. PLAN records this bounded task; Phase 0 and the application are not complete.

The `gateway`, `scheduler` and `validate` server-image commands still print their names and exit; listeners and Function CLI validation are not wired yet. `migrate` is a real database command as described below. Reusable Function schemas and generated CRD/editor artifacts are available, while Store methods and actual gateway/scheduler wiring remain later implementation steps. See [PLAN.md](PLAN.md) for acceptance criteria and progress.

## Check the current implementation

Prerequisites: Node.js matching `.node-version`, pnpm matching `package.json`, [uv](https://docs.astral.sh/uv/), Docker, Helm 4 and actionlint.

```sh
pnpm install --frozen-lockfile
uv sync --directory sdk/python --frozen
make check
make helm-lint
actionlint
make docker
```

Run a finite scaffold command from source build output or the container:

```sh
make build
node bin/krun.js gateway
docker run --rm --read-only --network none krun:local gateway
```

Both commands print `gateway` and exit 0. The `scheduler` and `validate` scaffold commands behave the same way; `migrate` instead requires database settings and performs real migrations. The kind/e2e Make targets fail explicitly until their planned harness is implemented; the Helm chart is currently a minimal lintable skeleton.

Tests include configuration defaults and boundaries, process-specific validation, namespace resolution, typed/redacted failures, Effect layers, command dispatch and build/CI contracts. `make check` also runs Python lint/type checks and Knip.

P0.8 provides the strict composite Function spec, resource/status schemas and separate raw-input/parsed-output TypeScript types in `packages/shared/src/functions/schema.ts`. Minimal create input requires image and an explicit object `inputSchema`; documented defaults are applied without inventing readiness. Queue/heartbeat duration floors, leading-zero equivalence and safe-integer overflow agree across Zod, editor JSON Schema and the structural CRD. SPEC D40 records the delegated contract decisions; D41 limits the independent JSON Schema conformance evaluator to development tests. Review repairs in D42 make callback URI validation byte-preserving and consistent across Zod/editor/CRD, and preserve opaque own JSON keys such as `__proto__` without rebuilding dictionaries or mutating prototypes. Wire URI syntax does not replace the later runtime webhook allowlists.

`make generate` runs the native Node TypeScript generator and reproducibly writes `deploy/crds/functions.krun.io.yaml`, the conditional Helm CRD template and `docs/schemas/function-v1alpha1.json`. Runtime consumers import the source module, not these files. Tests cover isolated drift repair, actual Helm install/keep combinations and preservation of arbitrary user-schema keywords. A disposable Kubernetes 1.33.7 test cluster verified CRD establishment, native defaults/pruning, opaque `inputSchema`, duration bounds and status behavior; no production cluster was used. Independent reviews identified callback URI parity and opaque-key preservation defects; both were repaired and the reviewer-authored regression assertions pass at delivery. [P0.8 code CI](https://github.com/xenarro/krun/actions/runs/40067784483) passed exact code head `263c22b60108d5b022767cefd8eb30fa36c10719` in [stacked PR #4](https://github.com/xenarro/krun/pull/4), including 199 TypeScript tests and one Python test, generated-clean checks, the rebuilt container, Helm, audit and scanning. The PR targets the still-unmerged `feat/admin-health-telemetry` parent; no stack layer was auto-merged. Phase 0 remains incomplete. CLI validation, informer/runtime policy and actual serving processes remain later PLAN work.

P1.1 adds the normalized Store model, plain Kysely-compatible Postgres/SQLite table interfaces, canonical `toRun`/`toRunSummary` mappers, tagged errors and all 23 Effect Store method contracts in `packages/shared/src/store`. BASIC is whitelisted directly without reading FULL-only columns or error details; opaque JSON keys and falsy results are preserved. Both independent reviews found no material defects. Task/root no-emit checks, 33 focused tests and `make check` (232 TypeScript tests and one Python test) pass. [P1.1 code CI](https://github.com/xenarro/krun/actions/runs/40072000762) verified exact code commit `82d3a69239e728e0954dedf27ea7add2cee021e7` in [stacked PR #6](https://github.com/xenarro/krun/pull/6), including current-source container build/smoke, generated-clean, Helm, audit and scanning. The PR targets the still-unmerged `build/release-preconditions` parent; no layer was auto-merged. That delivery covers model/interface/mapper contracts, not Store methods. P1.2's migrations are described below; real SQLite/Postgres Store behavior and the full Phase 1 dual-backend gate remain pending. P0.9 publishing preconditions remain independently unresolved.

P1.2 implements `krun migrate` with Kysely `Migrator`/`FileMigrationProvider` and forward-only raw SQL files for both dialects. It reads only `KRUN_DB_MODE`, `KRUN_DB_DSN` and `KRUN_DB_PATH`: Postgres is the default and requires the database setting; embedded mode defaults to `/data/krun.db`. Scoped production layers own the Postgres pool (five connections, ten-second query bound) or built-in SQLite connection. Unknown recorded migrations with nothing pending warn and exit 0 without changing history; unknown plus pending exits 1 before application DDL. Driver failures retain no raw connection data. Real CLI tests against temp-file SQLite and digest-pinned Postgres 18 via Testcontainers cover migration twice, both history branches, transactional rollback, unrelated-schema bookkeeping, config isolation and scoped release. SPEC D43 records the SQLite transactional-DDL correction; D44 records explicit denial of unused transitive install scripts. Both independent reviews and repair found no material defects. `make check` passes 263 TypeScript tests and one Python test; the Store suite passes 61 checks. [P1.2 code CI](https://github.com/xenarro/krun/actions/runs/40097891636) verified exact code commit `d862527a4dcf6c66f3400dae3850925b42af1485` in [stacked PR #7](https://github.com/xenarro/krun/pull/7), including frozen dependencies, generated-clean checks, rebuilt non-root image with actual embedded migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-contract` parent; no layer was merged or auto-merged. The full P1.3-P1.11 Store contract gate and P1.9 remain separate, incomplete work.

P1.3 now implements the declared `createRun` method as a Database-backed factory, without fake implementations of later Store methods (SPEC D45). It uses the existing composite partial index and one transaction for the queued run, actor event and Postgres notification. A shared `canonicalize`/SHA-256 helper hashes the API 3.3 projection with absent priority as 0 and absent callback as null, before Function callback fallback; requestId and wait are excluded. The existing NewRun contract supplies ids, timestamps and hashes. Shared tests against temp-file SQLite and Postgres 18 exercise 20 concurrent duplicates, including mixed omitted/explicit-zero priority retries, nested key-order equivalence, changed-payload conflicts, owner/function scoping, null/empty keys, rollback, current-row decoding, opaque JSON keys and committed notifications. Both independent reviews reproduced the fingerprint-default mismatch; the repair now verifies normalized golden bytes and equivalent replay on both backends. Store suite 87 and `make check` (289 TypeScript tests and one Python test) pass. [P1.3 code CI](https://github.com/xenarro/krun/actions/runs/40102991839) verifies exact code commit `8a189d466286bb5721c916b7db5011cc70963509` in [stacked PR #8](https://github.com/xenarro/krun/pull/8), including frozen dependencies, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-migrations` parent; no layer was merged or auto-merged. Full Store-layer assembly, later Store methods and the complete Phase 1 gate remain pending.

## Dependency policy

[docs/STACK.md](docs/STACK.md) is the dependency allowlist. Automatic peer installation is disabled so unused Redis integration is not pulled in by the platform package. Process entrypoints import its public `NodeRuntime` subpath. Vite is development-only because Vitest 5 requires it (SPEC D37); neither Vite nor Redis belongs in the production image.

The release-age guard remains enabled. Repository-local exceptions cover only the explicitly approved Effect 4.0.6 packages, and strict mode prevents installs from silently adding other exceptions. SPEC D38 caps the OpenTelemetry API at `~1.9.0` for SDK 2.12 compatibility; it does not waive installation policy. SPEC D39 records a reproducible declaration-only pnpm patch for pino's transitive `thread-stream@4.2.0`, whose published types otherwise fail with Node 26; no runtime JavaScript or compiler checks are weakened.

## Design and operations

- [Problem and boundaries](docs/PROBLEM.md)
- [Behavioral specification and decisions](SPEC.md)
- [Public API contract](docs/API.md)
- [Internal container API contract](docs/INTERNAL-API.md)
- [Technology stack](docs/STACK.md)
- [Build plan](PLAN.md)
- [Operations](docs/OPERATIONS.md)

Non-goals include workflows/DAGs, a product web UI, automatic retries and a pool executor. The private local agent dashboard and orchestration checkpoints are Git-excluded development tooling, not part of krun or its container image.
