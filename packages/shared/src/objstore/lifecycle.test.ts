import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ObjectStore, ObjectStoreError, ObjectStoreS3 } from "./index.js";

const id = "0192f000-0000-7000-8000-000000000001";
const fixture = (handle: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const server = createServer(handle);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No listener");
        return {
          server,
          options: {
            endpoint: `http://127.0.0.1:${address.port}`,
            bucket: "krun-test-results",
            region: "us-east-1",
            accessKeyId: randomBytes(16).toString("hex"),
            secretAccessKey: randomBytes(32).toString("hex"),
          },
        };
      },
      catch: () => new Error("Owned object-store fault fixture failed"),
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

it.live("scope release destroys the real S3 client's keepalive socket", () =>
  Effect.gen(function* () {
    let notifyClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    const owned = yield* fixture((request, response) => {
      request.socket.once("close", notifyClosed);
      response.writeHead(200, { "content-length": "0" }).end();
    });
    yield* Effect.gen(function* () {
      const store = yield* ObjectStore;
      expect(yield* store.exists(id)).toBe(true);
    }).pipe(Effect.provide(ObjectStoreS3(owned.options)));
    yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));
  }),
);

for (const phase of ["object", "bucket"] as const) {
  it.live(`interruption aborts the active ${phase} HEAD request without detaching work`, () =>
    Effect.gen(function* () {
      let notifyStarted = () => {};
      let notifyClosed = () => {};
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        notifyClosed = resolve;
      });
      const owned = yield* fixture((request, response) => {
        if (phase === "bucket" && request.url?.includes("/runs/")) {
          response.writeHead(404, { "content-length": "0" }).end();
          return;
        }
        request.socket.once("close", notifyClosed);
        notifyStarted();
      });
      yield* Effect.gen(function* () {
        const store = yield* ObjectStore;
        const worker = yield* Effect.forkChild(store.exists(id));
        yield* Effect.promise(() => started);
        yield* Fiber.interrupt(worker);
        yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.provide(ObjectStoreS3(owned.options)));
    }),
  );
}

it.effect(
  "the ten-second Effect deadline aborts native HEAD and returns only a tagged operation",
  () =>
    Effect.gen(function* () {
      let notifyStarted = () => {};
      let notifyClosed = () => {};
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        notifyClosed = resolve;
      });
      const owned = yield* fixture((request) => {
        request.socket.once("close", notifyClosed);
        notifyStarted();
      });
      yield* Effect.gen(function* () {
        const store = yield* ObjectStore;
        const worker = yield* Effect.forkChild(Effect.flip(store.exists(id)));
        yield* Effect.promise(() => started);
        yield* TestClock.adjust("10 seconds");
        const error = yield* Fiber.join(worker);
        expect(error).toBeInstanceOf(ObjectStoreError);
        expect(error.operation).toBe("exists");
        yield* Effect.promise(() => closed);
      }).pipe(Effect.provide(ObjectStoreS3(owned.options)));
    }),
);

it.live(
  "transient service failures are not missing objects and receive no hidden SDK retries",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const owned = yield* fixture((_request, response) => {
        calls++;
        response.writeHead(503, { "content-length": "0" }).end();
      });
      yield* Effect.gen(function* () {
        const store = yield* ObjectStore;
        const error = yield* Effect.flip(store.exists(id));
        expect(error).toBeInstanceOf(ObjectStoreError);
        expect(error.operation).toBe("exists");
        expect(calls).toBe(1);
        expect("cause" in error).toBe(false);
      }).pipe(Effect.provide(ObjectStoreS3(owned.options)));
    }),
);
