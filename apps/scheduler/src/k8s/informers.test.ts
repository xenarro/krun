import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { it as effectIt } from "@effect/vitest";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { Clock, Deferred, Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it, vi } from "vitest";
import { makeJobPodSource } from "./informers.js";

const namespace = "krun-test-p44-jobs";
const id = "0192f000-0000-7000-8000-000000000001";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const app = createServer(handler);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        app.close((error) => (error ? reject(error) : resolve()));
        app.closeAllConnections();
      }),
  );
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("Expected owned test listener");
  return `http://127.0.0.1:${address.port}`;
};
const native = (server: string) =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({
      load: (config) =>
        config.loadFromClusterAndUser(
          { name: namespace, server, skipTLSVerify: true },
          { name: namespace },
        ),
    });
    return yield* makeJobPodSource(namespace).pipe(
      Effect.provideService(KubeConnection, connection),
    );
  });
const object = (resourceVersion = "43") => ({
  metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id }, resourceVersion },
});

it("native LIST/cache and ADDED/MODIFIED/DELETED watch events retain selector, namespace and resourceVersion", async () => {
  const requests: URL[] = [];
  let closed = 0;
  const url = await server((request, response) => {
    const location = new URL(request.url ?? "/", "http://krun-test.invalid");
    requests.push(location);
    response.setHeader("content-type", "application/json");
    if (!location.searchParams.has("watch")) {
      response.end(JSON.stringify({ metadata: { resourceVersion: "42" }, items: [] }));
      return;
    }
    request.on("close", () => closed++);
    response.flushHeaders();
    for (const [i, type] of ["ADDED", "MODIFIED", "DELETED"].entries())
      response.write(`${JSON.stringify({ type, object: object(String(43 + i)) })}\n`);
  });
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* source.ready;
        const batches = yield* Effect.all(
          [
            Stream.runCollect(source.jobEvents.pipe(Stream.take(3))),
            Stream.runCollect(source.podEvents.pipe(Stream.take(3))),
          ],
          { concurrency: "unbounded" },
        );
        const first = batches[0]?.[0];
        const last = batches[0]?.[2];
        const pod = batches[1]?.[2];
        if (first === undefined || last === undefined || pod === undefined)
          throw new Error("Expected owned event batches");
        expect(source.hasPendingJob(id)).toBe(true);
        source.acknowledgeJob(first);
        source.acknowledgeJob(pod);
        expect(source.hasPendingJob(id)).toBe(true);
        source.acknowledgeJob(last);
        expect(source.hasPendingJob(id)).toBe(false);
        return batches;
      }),
    ),
  );
  expect(events.map((batch) => batch.map((event) => event.id))).toEqual([
    [id, id, id],
    [id, id, id],
  ]);
  expect(events[0]?.slice(0, 2).map((event) => event.jobSeen)).toEqual([true, true]);
  expect(events[0]?.[2]?.jobSeen).toBeUndefined();
  expect(events[1]?.every((event) => event.jobSeen === undefined)).toBe(true);
  expect(events[0]?.[2]?.deletedJob?.metadata?.name).toBe(`krun-${id}`);
  expect(events[1]?.[2]?.deletedPod?.metadata?.name).toBe(`krun-${id}`);
  expect(new Set(requests.map((r) => r.pathname))).toEqual(
    new Set([
      `/apis/batch/v1/namespaces/${namespace}/jobs`,
      `/api/v1/namespaces/${namespace}/pods`,
    ]),
  );
  for (const request of requests)
    expect(request.searchParams.get("labelSelector")).toBe("krun.io/run-id");
  for (const request of requests.filter((r) => r.searchParams.has("watch")))
    expect(request.searchParams.get("resourceVersion")).toBe("42");
  await vi.waitFor(() => expect(closed).toBe(2));
});

it("an empty LIST is processed before ready, and one delayed LIST prevents readiness", async () => {
  let release: (() => void) | undefined;
  let ready = false;
  const url = await server((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("watch=true")) {
      response.flushHeaders();
      return;
    }
    const finish = () =>
      response.end(JSON.stringify({ metadata: { resourceVersion: "1" }, items: [] }));
    if (request.url?.includes("/pods")) release = finish;
    else finish();
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        const fiber = yield* Effect.forkScoped(
          source.ready.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                ready = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(release).toBeTypeOf("function")));
        expect(ready).toBe(false);
        release?.();
        yield* Fiber.join(fiber);
        expect(source.jobs.list(namespace)).toEqual([]);
        expect(source.pods.list(namespace)).toEqual([]);
      }),
    ),
  );
});

it.each(["list", "watch"])(
  "leader-scope close aborts a pending native %s without late reconnect or retained sockets",
  async (stage) => {
    let pending = 0;
    let closed = 0;
    let requests = 0;
    const entered = Deferred.makeUnsafe<void>();
    const url = await server((request, response) => {
      requests++;
      response.setHeader("content-type", "application/json");
      if (stage === "list" || request.url?.includes("watch=true")) {
        pending++;
        request.on("close", () => closed++);
        if (pending === 2) Deferred.doneUnsafe(entered, Effect.void);
      } else response.end(JSON.stringify({ metadata: { resourceVersion: "1" }, items: [] }));
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* native(url);
          yield* Deferred.await(entered);
        }),
      ),
    );
    await vi.waitFor(() => expect(closed).toBe(2));
    expect(requests).toBe(stage === "list" ? 2 : 4);
  },
);

effectIt.effect(
  "native LIST errors restart with Effect Clock exponential backoff capped at thirty seconds",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const url = yield* Effect.promise(() =>
        server((_request, response) => {
          requests++;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "owned-private-diagnostic-never-logged" }));
        }),
      );
      const clock = yield* Clock.Clock;
      const sleeping = new Map<symbol, number>();
      const observed: Clock.Clock = {
        ...clock,
        sleep: (duration) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = Symbol();
              sleeping.set(key, Duration.toMillis(duration));
              return key;
            }),
            () => clock.sleep(duration),
            (key) =>
              Effect.sync(() => {
                sleeping.delete(key);
              }),
          ),
      };
      yield* native(url).pipe(Effect.provideService(Clock.Clock, observed));
      let expected = 2;
      const settled = () =>
        Effect.promise(() =>
          vi.waitFor(async () => {
            expect(requests).toBe(expected);
            expect(sleeping.size).toBe(2);
          }),
        );
      yield* settled();
      for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        yield* TestClock.adjust(delay - 1);
        expect(requests).toBe(expected);
        yield* TestClock.adjust(1);
        expected += 2;
        yield* settled();
      }
    }),
);

effectIt.effect(
  "quiet native watch bodies survive the ten-second handshake budget and abort on leader loss",
  () =>
    Effect.gen(function* () {
      const watches: ServerResponse[] = [];
      let requests = 0;
      const url = yield* Effect.promise(() =>
        server((request, response) => {
          requests++;
          response.setHeader("content-type", "application/json");
          if (!request.url?.includes("watch=true")) {
            response.end(JSON.stringify({ metadata: { resourceVersion: "1" }, items: [] }));
            return;
          }
          watches.push(response);
          response.flushHeaders();
        }),
      );
      const source = yield* native(url);
      yield* source.ready;
      yield* Effect.promise(() => vi.waitFor(() => expect(watches).toHaveLength(2)));
      yield* TestClock.adjust("11 seconds");
      expect(requests).toBe(4);
      const events = yield* Effect.forkScoped(
        Stream.runCollect(source.jobEvents.pipe(Stream.take(1))),
      );
      for (const response of watches)
        response.write(`${JSON.stringify({ type: "ADDED", object: object("2") })}\n`);
      expect((yield* Fiber.join(events)).map((event) => event.id)).toEqual([id]);
    }),
);

it("stream ERROR restarts the stopped native informer without losing its cache resourceVersion", async () => {
  let lists = 0;
  let watches = 0;
  const versions: (string | null)[] = [];
  const url = await server((request, response) => {
    const location = new URL(request.url ?? "/", "http://krun-test.invalid");
    response.setHeader("content-type", "application/json");
    if (!location.searchParams.has("watch")) {
      lists++;
      response.end(JSON.stringify({ metadata: { resourceVersion: "42" }, items: [] }));
      return;
    }
    response.flushHeaders();
    watches++;
    versions.push(location.searchParams.get("resourceVersion"));
    if (watches <= 2)
      response.end(
        `${JSON.stringify({ type: "ERROR", object: { code: 503, message: "owned-private-error-body" } })}\n`,
      );
    else response.write(`${JSON.stringify({ type: "ADDED", object: object("43") })}\n`);
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* source.ready;
        const events = yield* Stream.runCollect(source.jobEvents.pipe(Stream.take(1)));
        expect(events.map((event) => event.id)).toEqual([id]);
      }),
    ),
  );
  expect(lists).toBe(2);
  expect(watches).toBeGreaterThanOrEqual(3);
  expect(versions.every((value) => value === "42")).toBe(true);
});

it("watch ERROR 410 relists and reconciles native cache from the new resourceVersion", async () => {
  let lists = 0;
  let watches = 0;
  const requests: URL[] = [];
  const resumed = new Set<string>();
  let resolveResumed = () => {};
  const replacementWatches = new Promise<void>((resolve) => {
    resolveResumed = resolve;
  });
  const url = await server((request, response) => {
    const location = new URL(request.url ?? "/", "http://krun-test.invalid");
    requests.push(location);
    response.setHeader("content-type", "application/json");
    if (!location.searchParams.has("watch")) {
      lists++;
      response.end(
        JSON.stringify({
          metadata: { resourceVersion: lists > 2 ? "99" : "1" },
          items: lists > 2 ? [object("99")] : [],
        }),
      );
      return;
    }
    response.flushHeaders();
    watches++;
    if (watches <= 2) response.end(`${JSON.stringify({ type: "ERROR", object: { code: 410 } })}\n`);
    if (location.searchParams.get("resourceVersion") === "99") {
      resumed.add(location.pathname);
      if (resumed.size === 2) resolveResumed();
    }
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* source.ready;
        // Relisting/caching precedes network dispatch. Keep the source alive
        // until both replacement WATCH requests reach the owned server.
        yield* Effect.promise(() => replacementWatches);
        expect(lists).toBe(4);
        expect(source.jobs.list(namespace)).toHaveLength(1);
        expect(source.pods.list(namespace)).toHaveLength(1);
      }),
    ),
  );
  expect(requests.some((r) => r.searchParams.get("resourceVersion") === "99")).toBe(true);
});

it("P45-C1: leader scope clears pending ingress without acknowledgement or replay", async () => {
  const url = await server((request, response) => {
    response.setHeader("content-type", "application/json");
    if (!request.url?.includes("watch=true")) {
      response.end(JSON.stringify({ metadata: { resourceVersion: "42" }, items: [] }));
      return;
    }
    response.flushHeaders();
    if (request.url.includes("/jobs"))
      response.write(`${JSON.stringify({ type: "ADDED", object: object() })}\n`);
  });
  const retained = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* source.ready;
        const [event] = yield* Stream.runCollect(source.jobEvents.pipe(Stream.take(1)));
        if (event === undefined) throw new Error("Expected owned ingress");
        expect(source.hasPendingJob(id)).toBe(true);
        return { source, event };
      }),
    ),
  );
  expect(retained.source.hasPendingJob(id)).toBe(false);
  retained.source.acknowledgeJob(retained.event);
  expect(retained.source.hasPendingJob(id)).toBe(false);
});
