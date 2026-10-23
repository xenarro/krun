# Admin listener and readiness (P0.7, SPEC.md:176-196)

Companion to `SKILL.md` rules 6-9. Line numbers from the working tree
2026-10-23; re-check before quoting.

## Shape

- `packages/shared/src/health`: a Fastify plugin on its own Fastify
  instance listening on `KRUN_ADMIN_LISTEN_ADDR`, wrapped in the
  `AdminServer` scoped layer. Gateway has three instances, scheduler one
  (SPEC.md:178-180; one Fastify instance owns one server). No plugin
  outside docs/STACK.md.
- A `Readiness` service holds a `Ref` of `{ ready: boolean, draining:
  boolean, leader?: boolean }`, plus
  `dbCheck: Effect<void, DatabaseError>` and
  `functionsSynced: Effect<boolean>`. `main.ts` flips `ready` after the
  first good check. The `Drain` finalizer sets `draining` (`Ref.set`,
  before any sleep).
- `/readyz` (probe `mod.test.mjs` passed with this shape):
  ```ts
  app.get("/readyz", async (_req, reply) => {
    const ok = await run(Effect.gen(function* () {
      const s = yield* Ref.get(readiness.state)
      if (s.draining || !s.ready || !(yield* readiness.functionsSynced)) return false
      return Option.isSome(yield* readiness.dbCheck.pipe(Effect.timeoutOption("2 seconds"), Effect.option, Effect.map(Option.flatten)))
    }))
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", ...leaderField })
  })
  ```
  `run` is `Effect.runPromiseWith(ctx)` over the context captured in the
  layer constructor. `leaderField` is `{ leader }` on the scheduler only.
- `/healthz`: plain route returning 200.
- `/metrics`: takes the exporter from the `Telemetry` layer (the
  `MetricsReader` service) and answers
  `serializer.serialize((await exporter.collect()).resourceMetrics)` as
  `text/plain; version=0.0.4; charset=utf-8`. Code, and why
  `getMetricsRequestHandler` is second choice: `telemetry.md`.
- Probe hits are not audit lines, not info logs, not spans.
- `onListen` hooks do not run under `inject()`: never put readiness wiring
  there.

## Acceptance (PLAN.md:201-202)

`@effect/vitest` `it.effect` with Fastify `inject` and `TestClock`. Build
the app inside the test from `yield* Effect.context()`, so handlers run on
the `TestClock`. A `ManagedRuntime` or context captured outside the
`it.effect` body runs on the live clock: `TestClock.adjust` then does
nothing, and the 2 s test hangs or sleeps for real.

- Stalled DB check: `dbCheck = Effect.never`. Fork
  `Effect.promise(() => app.inject("/readyz"))`. Run
  `TestClock.adjust("1999 millis")`; assert the fiber is still pending
  (`fiber.pollUnsafe()` is `undefined` after an `Effect.yieldNow`). Adjust
  1 ms more, join, expect 503.
- 200 when ready; 503 when `draining`.
- 404 for `/v1/functions` on the admin app.
- A `/metrics` scrape contains a counter registered in the test.
