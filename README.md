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

The four server-image commands currently print their names and exit successfully. They do not start listeners, migrate a database or validate Function resources yet. Function schemas, storage and the actual gateway/scheduler are later implementation steps. See [PLAN.md](PLAN.md) for acceptance criteria and progress.

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

Both commands print `gateway` and exit 0. The `scheduler`, `migrate` and `validate` scaffold commands behave the same way. The kind/e2e Make targets fail explicitly until their planned harness is implemented; the Helm chart is currently a minimal lintable skeleton.

Tests include configuration defaults and boundaries, process-specific validation, namespace resolution, typed/redacted failures, Effect layers, command dispatch and build/CI contracts. `make check` also runs Python lint/type checks and Knip.

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
