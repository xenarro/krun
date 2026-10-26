import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeCreationPolicy } from "./create-policy.js";
import { Kube, KubeLive, makeKube } from "./kube.js";
import { makeLeaseApi } from "./lease-api.js";

const target = {
  namespace: "krun-test-api",
  name: "krun-test-job",
  function: "worker",
  runId: "01900000-0000-7000-8000-000000000001",
};
const receiver = (handle: (req: IncomingMessage, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer(handle);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Owned receiver failed");
      return { server, url: `http://127.0.0.1:${address.port}` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );
const connect = (url: string, concurrency = 8) =>
  makeKubeConnection({
    concurrency,
    load: (config) =>
      config.loadFromOptions({
        clusters: [{ name: "krun-test-api", server: url, skipTLSVerify: true }],
        users: [{ name: "krun-test-api" }],
        contexts: [{ name: "krun-test-api", cluster: "krun-test-api", user: "krun-test-api" }],
        currentContext: "krun-test-api",
      }),
  });

it.effect("one configured connection limits native Kube and Lease requests together to eight", () =>
  Effect.gen(function* () {
    let active = 0;
    let maximum = 0;
    const entered = yield* Deferred.make<void>();
    let eighth!: () => void;
    const ready = new Promise<void>((resolve) => {
      eighth = resolve;
    });
    const pending: (() => void)[] = [];
    const owned = yield* receiver((_req, res) => {
      maximum = Math.max(maximum, ++active);
      pending.push(() => {
        active--;
        res.setHeader("content-type", "application/json");
        res.end('{"metadata":{"resourceVersion":"1"}}');
      });
      if (active === 8) eighth();
    });
    const connection = yield* connect(owned.url);
    const services = yield* Effect.gen(function* () {
      return { kube: yield* makeKube(), lease: yield* makeLeaseApi() };
    }).pipe(Effect.provideService(KubeConnection, connection));
    const fibers = yield* Effect.forEach(Array.from({ length: 12 }), (_, i) =>
      Effect.forkScoped(
        i % 2 ? services.lease.read(target.namespace) : services.kube.readSecret(target),
      ),
    );
    yield* Effect.promise(() => ready);
    yield* Deferred.succeed(entered, undefined);
    expect(maximum).toBe(8);
    while (pending.length) pending.shift()?.();
    // The remaining four requests are admitted only after first responses settle.
    yield* Effect.gen(function* () {
      while (pending.length < 4) yield* Effect.yieldNow;
    });
    while (pending.length) pending.shift()?.();
    yield* Effect.forEach(fibers, Fiber.join);
    expect(maximum).toBe(8);
    expect(active).toBe(0);
  }),
);

it.effect("native API Status 503/422/quota403/429 become real creation policy decisions", () =>
  Effect.gen(function* () {
    let code = 503;
    let reason = "ServiceUnavailable";
    let message = "API unavailable";
    const owned = yield* receiver((_req, res) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.setHeader("Retry-After", "7");
      res.end(JSON.stringify({ apiVersion: "v1", kind: "Status", reason, message, code }));
    });
    const connection = yield* connect(owned.url);
    const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
    const policy = yield* makeCreationPolicy;
    expect(
      yield* policy.failed("worker", yield* Effect.flip(kube.createJob(target, {}))),
    ).toMatchObject({ kind: "transient" });
    code = 422;
    reason = "Invalid";
    message = "Rejected by policy";
    expect(
      yield* policy.failed("worker", yield* Effect.flip(kube.createSecret(target, {}))),
    ).toMatchObject({
      kind: "permanent",
      error: { source: "krun", message, details: { code: 422, reason: "Invalid" } },
    });
    code = 403;
    reason = "Forbidden";
    message = "exceeded quota: pods";
    expect(
      yield* policy.failed("worker", yield* Effect.flip(kube.createJob(target, {}))),
    ).toMatchObject({ kind: "transient", quota: true });
    code = 429;
    reason = "TooManyRequests";
    message = "rate limited";
    expect(
      yield* policy.failed("worker", yield* Effect.flip(kube.createJob(target, {}))),
    ).toMatchObject({ kind: "transient", pauseSeconds: 7 });
  }),
);

it.effect(
  "native create timeout aborts the socket at ten seconds and frees the configured permit",
  () =>
    Effect.gen(function* () {
      let received!: () => void;
      let closed!: () => void;
      const ready = new Promise<void>((resolve) => {
        received = resolve;
      });
      const stopped = new Promise<void>((resolve) => {
        closed = resolve;
      });
      let stall = true;
      const owned = yield* receiver((_req, res) => {
        if (stall) {
          received();
          res.once("close", closed);
        } else {
          res.setHeader("content-type", "application/json");
          res.end("{}");
        }
      });
      const connection = yield* connect(owned.url, 1);
      const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
      const fiber = yield* Effect.forkScoped(Effect.flip(kube.createJob(target, {})));
      yield* Effect.promise(() => ready);
      yield* TestClock.adjust("9999 millis");
      stall = false;
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "timeout" });
      yield* Effect.promise(() => stopped);
      expect(yield* kube.readSecret(target)).toMatchObject({});
    }),
);

it.effect(
  "native deletion treats404 as success; exact propagation and pod-log bounds reach the server",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const owned = yield* receiver((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.method === "DELETE") {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end("{}");
        } else {
          res.setHeader("content-type", "text/plain");
          res.end("owned log tail");
        }
      });
      const connection = yield* connect(owned.url);
      const kube = yield* Kube.pipe(
        Effect.provide(KubeLive),
        Effect.provideService(KubeConnection, connection),
      );
      yield* kube.deleteJob(target, "Foreground");
      yield* kube.deleteSecret(target);
      expect(yield* kube.readPodLog(target)).toBe("owned log tail");
      expect(requests[0]).toContain("propagationPolicy=Foreground");
      expect(requests[1]).toContain("/secrets/krun-test-job");
      expect(requests[2]).toContain("container=function");
      expect(requests[2]).toContain("tailLines=100");
      expect(requests[2]).toContain("limitBytes=16384");
    }),
);

for (const second of ["Kube", "Lease"] as const) {
  it.effect(`queued ${second} call has total ten-second deadline`, () =>
    Effect.gen(function* () {
      let entered = () => {};
      const firstReady = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const requests: string[] = [];
      const owned = yield* receiver((req, _res) => {
        requests.push(req.method ?? "");
        entered();
      });
      const connection = yield* connect(owned.url, 1);
      const { kube, lease } = yield* Effect.gen(function* () {
        return { kube: yield* makeKube(), lease: yield* makeLeaseApi() };
      }).pipe(Effect.provideService(KubeConnection, connection));
      const first = yield* Effect.forkScoped(Effect.flip(kube.createJob(target, {})));
      yield* Effect.promise(() => firstReady);
      const queued = yield* Effect.forkScoped(
        Effect.flip(second === "Kube" ? kube.readSecret(target) : lease.read(target.namespace)),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(first)).toMatchObject({ reason: "timeout" });
      expect(queued.pollUnsafe(), "permit wait must not reset the deadline").toBeDefined();
      expect(yield* Fiber.join(queued)).toMatchObject({
        operation: "request",
        reason: "timeout",
      });
      expect(requests).toEqual(["POST"]);
    }),
  );
}
it.effect("cancelling a queued call never issues its native request", () =>
  Effect.gen(function* () {
    let entered = () => {};
    const firstReady = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requests = 0;
    const owned = yield* receiver((_req, res) => {
      requests++;
      if (requests === 1) entered();
      else {
        res.setHeader("content-type", "application/json");
        res.end("{}");
      }
    });
    const connection = yield* connect(owned.url, 1);
    const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
    const first = yield* Effect.forkScoped(kube.createJob(target, {}).pipe(Effect.flip));
    yield* Effect.promise(() => firstReady);
    const queued = yield* Effect.forkScoped(kube.readSecret(target));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(queued);
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(first);
    expect(yield* kube.readSecret(target)).toEqual({});
    expect(requests).toBe(2);
  }),
);
