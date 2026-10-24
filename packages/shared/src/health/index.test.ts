import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { FastifyInstance } from "fastify";
import { ConfigLive } from "../config/index.js";
import { AdminServer, AdminServerError, AdminServerLive, makeHealthApp } from "./index.js";
import { MetricsReader } from "./metrics.js";
import { Readiness, ReadinessLive } from "./readiness.js";

const metrics = Layer.succeed(MetricsReader, {
  scrape: Effect.succeed({
    contentType: "text/plain; version=0.0.4",
    body: "krun_test_metric 1\n",
  }),
});
const services = (databaseCheck: Effect.Effect<void, unknown> = Effect.void) =>
  Layer.merge(ReadinessLive(databaseCheck), metrics);
const ready = Readiness.use((readiness) =>
  Ref.update(readiness.state, (state) => ({ ...state, ready: true, functionsSynced: true })),
);
const inject = (app: FastifyInstance, url: string) =>
  Effect.promise(() => app.inject({ method: "GET", url }));

it.effect("liveness stays 200 while readiness requires ready and a successful initial LIST", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* makeHealthApp;
      const readiness = yield* Readiness;
      expect((yield* inject(app, "/healthz")).statusCode).toBe(200);
      expect((yield* inject(app, "/readyz")).statusCode).toBe(503);
      yield* Ref.update(readiness.state, (state) => ({ ...state, ready: true }));
      expect((yield* inject(app, "/readyz")).statusCode).toBe(503);
      yield* ready;
      const response = yield* inject(app, "/readyz");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", leader: false });
    }),
  ).pipe(Effect.provide(services())),
);

it.effect(
  "a stalled database check returns 503 at two seconds using TestClock through inject",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const databaseCheck = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* makeHealthApp;
          yield* ready;
          const request = yield* inject(app, "/readyz").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("1999 millis");
          expect(request.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 millis");
          const response = yield* Fiber.join(request);
          expect(response.statusCode).toBe(503);
          expect(response.json()).toEqual({ status: "unavailable", leader: false });
          expect(interrupted).toBe(true);
        }),
      ).pipe(Effect.provide(services(databaseCheck)));
    }),
);

it.effect("failed or defective DB checks are unavailable without leaking the cause", () =>
  Effect.gen(function* () {
    for (const databaseCheck of [
      Effect.fail("krun-test-sensitive-cause"),
      Effect.die("krun-test-sensitive-cause"),
    ]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* makeHealthApp;
          yield* ready;
          const response = yield* inject(app, "/readyz");
          expect(response.statusCode).toBe(503);
          expect(response.body).not.toContain("krun-test-sensitive-cause");
          expect((yield* inject(app, "/healthz")).statusCode).toBe(200);
        }),
      ).pipe(Effect.provide(services(databaseCheck)));
    }
  }),
);

it.effect("drain wins an in-flight DB success and skips new DB checks", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const databaseCheck = Effect.gen(function* () {
      calls++;
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeHealthApp;
        const readiness = yield* Readiness;
        yield* ready;
        const request = yield* inject(app, "/readyz").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Ref.update(readiness.state, (state) => ({ ...state, draining: true }));
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(request)).statusCode).toBe(503);
        expect((yield* inject(app, "/readyz")).statusCode).toBe(503);
        expect((yield* inject(app, "/healthz")).statusCode).toBe(200);
        expect(calls).toBe(1);
      }),
    ).pipe(Effect.provide(services(databaseCheck)));
  }),
);

it.effect("standby remains ready, leader status is current and sync loss revokes readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* makeHealthApp;
      const readiness = yield* Readiness;
      yield* ready;
      expect((yield* inject(app, "/readyz")).json()).toEqual({ status: "ok", leader: false });
      yield* Ref.update(readiness.state, (state) => ({ ...state, leader: true }));
      expect((yield* inject(app, "/readyz")).json()).toEqual({ status: "ok", leader: true });
      yield* Ref.update(readiness.state, (state) => ({ ...state, functionsSynced: false }));
      expect((yield* inject(app, "/readyz")).statusCode).toBe(503);
    }),
  ).pipe(Effect.provide(services())),
);

it.effect("metrics use only the injected reader on the separate admin app", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* makeHealthApp;
      const response = yield* inject(app, "/metrics");
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toBe("krun_test_metric 1\n");
      expect((yield* inject(app, "/v1/functions")).statusCode).toBe(404);
      expect((yield* inject(app, "/internal/v1/runs")).statusCode).toBe(404);
    }),
  ).pipe(Effect.provide(services())),
);

it.effect("metrics failures are redacted and liveness remains independent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* makeHealthApp;
      const response = yield* inject(app, "/metrics");
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("krun-test-sensitive-cause");
      expect((yield* inject(app, "/healthz")).statusCode).toBe(200);
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(
        ReadinessLive(Effect.void),
        Layer.succeed(MetricsReader, { scrape: Effect.fail("krun-test-sensitive-cause") }),
      ),
    ),
  ),
);

it.effect("the admin app closes when its scope fails", () =>
  Effect.gen(function* () {
    const acquired: { app?: FastifyInstance } = {};
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          acquired.app = yield* makeHealthApp;
          return yield* Effect.fail("krun-test-failure");
        }),
      ).pipe(Effect.provide(services())),
    );
    expect(exit._tag).toBe("Failure");
    const app = acquired.app;
    if (app === undefined) return yield* Effect.die("admin acquisition did not run");
    expect(app.server.listening).toBe(false);
    const result = yield* Effect.exit(Effect.promise(() => app.inject("/healthz")));
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("the admin app closes on fiber interruption", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<FastifyInstance>();
    const running = yield* Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeHealthApp;
        yield* Deferred.succeed(acquired, app);
        yield* Effect.never;
      }),
    ).pipe(Effect.provide(services()), Effect.forkChild);
    const app = yield* Deferred.await(acquired);
    yield* Fiber.interrupt(running);
    expect(app.server.listening).toBe(false);
    expect((yield* Effect.exit(Effect.promise(() => app.inject("/healthz"))))._tag).toBe("Failure");
  }),
);

for (const address of ["invalid", ":65536"]) {
  it.effect(`rejects invalid listen syntax or port with a redacted tagged error: ${address}`, () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        AdminServer.use((server) => Effect.succeed(server.app)).pipe(
          Effect.provide(
            AdminServerLive.pipe(
              Layer.provide(
                Layer.merge(
                  services(),
                  ConfigLive("gateway", {
                    env: {
                      KRUN_DB_MODE: "embedded",
                      KRUN_NAMESPACE: "krun-test-p0-7",
                      KRUN_ADMIN_LISTEN_ADDR: address,
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      expect(error).toBeInstanceOf(AdminServerError);
      expect(error).toMatchObject({ _tag: "AdminServerError", operation: "listen" });
      expect(Object.keys(error).sort()).toEqual(["_tag", "operation"]);
    }),
  );
}

it.effect("scope release marks readiness draining before the admin app is discarded", () =>
  Effect.gen(function* () {
    const readiness = yield* Readiness;
    yield* Effect.scoped(makeHealthApp);
    expect((yield* Ref.get(readiness.state)).draining).toBe(true);
  }).pipe(Effect.provide(services())),
);

for (const role of ["gateway", "scheduler"] as const) {
  it.live(`binds ${role}'s configured admin address separately and releases the listener`, () =>
    Effect.gen(function* () {
      const app = yield* Effect.scoped(
        Effect.gen(function* () {
          const { app } = yield* AdminServer;
          expect(app.server.listening).toBe(true);
          const address = app.server.address();
          expect(address).not.toBeNull();
          expect(typeof address).toBe("object");
          if (address === null || typeof address === "string")
            return yield* Effect.die("missing test listener");
          expect(address.address).toBe("127.0.0.1");
          expect(address.port).toBeGreaterThan(0);
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${address.port}/healthz`),
          );
          expect(response.status).toBe(200);
          yield* Effect.promise(() => response.text());
          return app;
        }),
      ).pipe(
        Effect.provide(
          AdminServerLive.pipe(
            Layer.provide(
              Layer.merge(
                services(),
                ConfigLive(role, {
                  env: {
                    KRUN_DB_MODE: "embedded",
                    KRUN_NAMESPACE: "krun-test-p0-7",
                    KRUN_ADMIN_LISTEN_ADDR: "127.0.0.1:0",
                  },
                }),
              ),
            ),
          ),
        ),
      );
      expect(app.server.listening).toBe(false);
    }),
  );
}
