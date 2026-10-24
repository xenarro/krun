import { get } from "node:http";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { FastifyInstance } from "fastify";
import { makeHealthApp } from "./index.js";
import { MetricsReader } from "./metrics.js";
import { Readiness, ReadinessLive } from "./readiness.js";

const turn = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))),
);
const text = { contentType: "text/plain", body: "krun-test-lifecycle\n" };
const metrics = Layer.succeed(MetricsReader, { scrape: Effect.succeed(text) });
const ready = Readiness.use((r) =>
  Ref.update(r.state, (s) => ({ ...s, ready: true, functionsSynced: true })),
);

for (const mode of ["slow-finalizer", "uninterruptible-body"] as const) {
  it.effect(`C1: two-second response, bounded outstanding work and recovery with ${mode}`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleanupDone = yield* Deferred.make<void>();
      let starts = 0;
      let healthy = false;
      const db = Effect.suspend(() => {
        starts++;
        if (healthy) return Effect.void;
        const body = Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          if (mode === "slow-finalizer") yield* Effect.never;
          else yield* Deferred.await(release);
        });
        return (mode === "uninterruptible-body" ? Effect.uninterruptible(body) : body).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.await(release);
              yield* Deferred.succeed(cleanupDone, undefined);
            }),
          ),
        );
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* makeHealthApp;
          yield* ready;
          const first = yield* Effect.promise(() => app.inject("/readyz")).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("2 seconds");
          yield* turn;
          const firstAtDeadline = first.pollUnsafe();
          const next = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              Effect.promise(() => app.inject("/readyz")).pipe(Effect.forkChild),
            ),
          );
          yield* TestClock.adjust("2 seconds");
          yield* turn;
          const allAtDeadline = next.every((fiber) => fiber.pollUnsafe() !== undefined);
          const startsWhileBlocked = starts;
          expect((yield* Effect.promise(() => app.inject("/healthz"))).statusCode).toBe(200);
          // Always release adversarial cleanup before assertions, including on the red path.
          healthy = true;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(cleanupDone);
          const firstResponse = yield* Fiber.join(first);
          const rest = yield* Effect.all(next.map(Fiber.join));
          yield* turn;
          expect(firstAtDeadline?._tag).toBe("Success");
          expect(firstResponse.statusCode).toBe(503);
          expect(allAtDeadline).toBe(true);
          expect(rest.map((response) => response.statusCode)).toEqual([503, 503, 503, 503]);
          expect(startsWhileBlocked).toBe(1);
          expect((yield* Effect.promise(() => app.inject("/readyz"))).statusCode).toBe(200);
          expect(starts).toBe(2);
        }),
      ).pipe(Effect.provide(Layer.merge(ReadinessLive(db), metrics)));
    }),
  );
}

for (const route of ["/readyz", "/metrics"]) {
  it.live(`C2: socket disconnect cancels ${route} work without waiting for its deadline`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let cancelled = false;
      const blocked = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
      );
      const deps = Layer.merge(
        ReadinessLive(route === "/readyz" ? blocked : Effect.void),
        Layer.succeed(MetricsReader, {
          scrape: route === "/metrics" ? blocked.pipe(Effect.as(text)) : Effect.succeed(text),
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* makeHealthApp;
          yield* ready;
          yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
          const address = app.server.address();
          if (!address || typeof address === "string")
            return yield* Effect.die("krun test listener missing");
          const request = get(`http://127.0.0.1:${address.port}${route}`);
          request.on("error", () => {});
          yield* Deferred.await(entered);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                request.once("close", () => setImmediate(() => setImmediate(resolve)));
                request.destroy();
              }),
          );
          const cancelledOnDisconnect = cancelled;
          yield* Deferred.succeed(release, undefined);
          yield* turn;
          expect(cancelledOnDisconnect).toBe(true);
        }),
      ).pipe(Effect.provide(deps));
    }),
  );
}

it.effect(
  "C2: admin release cancels handlers and waits for their cleanup before dependency release",
  () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<FastifyInstance>();
      const entered = yield* Deferred.make<void>();
      const closingStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let cancelled = false;
      let dependencyClosed = false;
      let cleanupBeforeDependencyClose = false;
      const scrape = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return text;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.await(release);
            cleanupBeforeDependencyClose = !dependencyClosed;
          }),
        ),
      );
      const dependency = Layer.effect(
        MetricsReader,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              dependencyClosed = true;
            }),
          );
          return { scrape };
        }),
      );
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* makeHealthApp;
          yield* Readiness.use((r) => Ref.update(r.state, (s) => ({ ...s, leader: true })));
          yield* Effect.addFinalizer(() => Deferred.succeed(closingStarted, undefined));
          yield* Deferred.succeed(acquired, app);
          yield* Effect.never;
        }),
      ).pipe(Effect.provide(Layer.merge(ReadinessLive(Effect.void), dependency)), Effect.forkChild);
      const app = yield* Deferred.await(acquired);
      const request = yield* Effect.promise(() => app.inject("/metrics")).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const closing = yield* Fiber.interrupt(owner).pipe(Effect.forkChild);
      yield* Deferred.await(closingStarted);
      yield* turn;
      const cancelledAtClose = cancelled;
      const closedBeforeCleanup = closing.pollUnsafe() !== undefined;
      const readinessWhileStopping = yield* Effect.promise(() => app.inject("/readyz"));
      expect((yield* Effect.promise(() => app.inject("/healthz"))).statusCode).toBe(200);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      const cancelledResponse = yield* Fiber.join(request);
      expect(readinessWhileStopping.statusCode).toBe(503);
      expect(readinessWhileStopping.json()).toEqual({ status: "unavailable", leader: true });
      expect(cancelledResponse.statusCode).toBe(503);
      expect(cancelledAtClose).toBe(true);
      expect(closedBeforeCleanup).toBe(false);
      expect(cleanupBeforeDependencyClose).toBe(true);
      expect(dependencyClosed).toBe(true);
    }),
);

it.effect(
  "C1: a timed-out DB worker remains owned until cleanup, before its dependency closes",
  () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<FastifyInstance>();
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let dependencyClosed = false;
      const db = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(cleanupEntered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              dependencyClosed = true;
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const app = yield* makeHealthApp;
              yield* ready;
              yield* Deferred.succeed(acquired, app);
              yield* Effect.never;
            }),
          ).pipe(Effect.provide(Layer.merge(ReadinessLive(db), metrics)));
        }),
      ).pipe(Effect.forkChild);
      const app = yield* Deferred.await(acquired);
      const request = yield* Effect.promise(() => app.inject("/readyz")).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(cleanupEntered);
      yield* turn;
      const atDeadline = request.pollUnsafe();
      const closing = yield* Fiber.interrupt(owner).pipe(Effect.forkChild);
      yield* turn;
      const closedBeforeCleanup = closing.pollUnsafe() !== undefined;
      const dependencyClosedEarly = dependencyClosed;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      yield* Fiber.join(request);
      expect(atDeadline?._tag).toBe("Success");
      expect(closedBeforeCleanup).toBe(false);
      expect(dependencyClosedEarly).toBe(false);
      expect(dependencyClosed).toBe(true);
    }),
);

it.live("normal HTTP response completion is not mistaken for a disconnect", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const db = Effect.void.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          cancelled = true;
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeHealthApp;
        yield* ready;
        yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
        const address = app.server.address();
        if (!address || typeof address === "string")
          return yield* Effect.die("krun test listener missing");
        const code = yield* Effect.promise(
          () =>
            new Promise<number | undefined>((resolve, reject) => {
              get(`http://127.0.0.1:${address.port}/readyz`, (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode));
              }).once("error", reject);
            }),
        );
        yield* turn;
        expect(code).toBe(200);
        expect(cancelled).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(ReadinessLive(db), metrics)));
  }),
);
