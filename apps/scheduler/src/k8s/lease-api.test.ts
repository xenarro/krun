import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { kubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { type CoordinationV1Api, KubeConfig, type V1Lease } from "@kubernetes/client-node";
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect";
import { LeaseApi, LeaseApiLive, makeLeaseApi } from "./lease-api.js";

const returned: V1Lease = {
  metadata: { name: "krun-scheduler", resourceVersion: "42" },
  spec: { holderIdentity: "test-pod" },
};
it.effect(
  "wraps a stubbed CoordinationV1Api using exact object-parameter get/create/replace calls",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client: Pick<
        CoordinationV1Api,
        "readNamespacedLease" | "createNamespacedLease" | "replaceNamespacedLease"
      > = {
        readNamespacedLease: async ({ namespace, name }) => {
          calls.push("get");
          expect(namespace).toBe("krun-test-lease");
          expect(name).toBe("krun-scheduler");
          return returned;
        },
        createNamespacedLease: async ({ namespace, body }) => {
          calls.push("create");
          expect(namespace).toBe("krun-test-lease");
          expect(body).toBe(returned);
          return returned;
        },
        replaceNamespacedLease: async ({ namespace, name, body }) => {
          calls.push("replace");
          expect(namespace).toBe("krun-test-lease");
          expect(name).toBe("krun-scheduler");
          expect(body.metadata?.resourceVersion).toBe("42");
          return returned;
        },
      };
      const connection = Layer.succeed(KubeConnection, {
        config: new KubeConfig(),
        call: <A>(f: (signal: AbortSignal) => Promise<A>) =>
          Effect.tryPromise({ try: f, catch: kubeApiError }),
      });
      const api = yield* makeLeaseApi(client).pipe(Effect.provide(connection));
      yield* api.read("krun-test-lease");
      yield* api.create("krun-test-lease", returned);
      yield* api.replace("krun-test-lease", returned);
      expect(calls).toEqual(["get", "create", "replace"]);
    }),
);

const serverFixture = (handle: (req: IncomingMessage, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer(handle);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Owned test receiver failed");
      return { server, url: `http://127.0.0.1:${address.port}` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
  );
const liveApi = (url: string) =>
  LeaseApi.pipe(
    Effect.provide(LeaseApiLive),
    Effect.provide(
      Layer.effect(
        KubeConnection,
        makeKubeConnection({
          load: (config) =>
            config.loadFromOptions({
              clusters: [{ name: "krun-test-owned", server: url, skipTLSVerify: true }],
              users: [{ name: "krun-test-owned" }],
              contexts: [
                { name: "krun-test-owned", cluster: "krun-test-owned", user: "krun-test-owned" },
              ],
              currentContext: "krun-test-owned",
            }),
        }),
      ),
    ),
  );

it.effect("the actual client reaches the exact Lease REST routes and round-trips MicroTime", () =>
  Effect.gen(function* () {
    const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
    const fixture = yield* serverFixture((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body: unknown = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined;
        requests.push({ method: req.method, url: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ...returned,
            spec: { holderIdentity: "test-pod", renewTime: "2026-01-01T00:00:00.123456Z" },
          }),
        );
      })().catch(() => {
        res.statusCode = 500;
        res.end("{}");
      });
    });
    const api = yield* liveApi(fixture.url);
    const value = yield* api.read("krun-test-lease");
    expect(value.spec?.renewTime).toBe("2026-01-01T00:00:00.123456Z");
    const body = {
      ...value,
      spec: {
        ...value.spec,
        renewTime: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
      },
    };
    yield* api.create("krun-test-lease", body);
    yield* api.replace("krun-test-lease", body);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/apis/coordination.k8s.io/v1/namespaces/krun-test-lease/leases/krun-scheduler"],
      ["POST", "/apis/coordination.k8s.io/v1/namespaces/krun-test-lease/leases"],
      ["PUT", "/apis/coordination.k8s.io/v1/namespaces/krun-test-lease/leases/krun-scheduler"],
    ]);
    expect(requests[2]?.body).toMatchObject({
      metadata: { resourceVersion: "42" },
      spec: { renewTime: "2026-01-01T00:00:00.000000Z" },
    });
  }),
);

it.effect(
  "interrupting an actual pending request aborts its transport rather than abandoning a socket",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let requestStarted = () => {};
      const entered = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      let responseClosed = () => {};
      const closed = new Promise<void>((resolve) => {
        responseClosed = resolve;
      });
      const fixture = yield* serverFixture((_req, res) => {
        requestStarted();
        res.once("close", responseClosed);
      });
      const api = yield* liveApi(fixture.url);
      const fiber = yield* Effect.forkScoped(api.read("krun-test-lease"));
      yield* Effect.promise(() => entered);
      yield* Deferred.succeed(started, undefined);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => closed);
      expect(fixture.server.listening).toBe(true);
    }),
);

for (const operation of ["create", "replace"] as const)
  it.effect(
    `serializes native Lease ${operation} timestamps as six-digit MicroTime without mutating its caller`,
    () =>
      Effect.gen(function* () {
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.123Z"));
        const body: V1Lease = {
          ...returned,
          spec: { holderIdentity: "test-pod", acquireTime: timestamp, renewTime: timestamp },
        };
        const received: unknown[] = [];
        const fixture = yield* serverFixture((req, res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const wire = JSON.parse(Buffer.concat(chunks).toString());
            received.push(wire);
            const valid = [wire.spec.acquireTime, wire.spec.renewTime].every(
              (time) => typeof time === "string" && /\.\d{6}Z$/.test(time),
            );
            res.setHeader("content-type", "application/json");
            res.statusCode = valid ? 200 : 400;
            res.end(
              JSON.stringify(
                valid
                  ? { ...wire, metadata: { ...wire.metadata, resourceVersion: "43" } }
                  : { reason: "BadRequest" },
              ),
            );
          })().catch(() => {
            res.statusCode = 500;
            res.end("{}");
          });
        });
        const api = yield* liveApi(fixture.url);
        const value = yield* api[operation]("krun-test-lease", body);
        expect(value.spec?.renewTime).toBe("2026-01-01T00:00:00.123000Z");
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          spec: {
            acquireTime: "2026-01-01T00:00:00.123000Z",
            renewTime: "2026-01-01T00:00:00.123000Z",
          },
        });
        expect(body.spec?.renewTime).toBe(timestamp);
        expect(timestamp.toISOString()).toBe("2026-01-01T00:00:00.123Z");
      }),
  );

for (const kind of ["403", "missing-version", "invalid-microtime"])
  it.effect(`sanitizes ${kind} without retaining response data`, () =>
    Effect.gen(function* () {
      const canary = "private-test-diagnostic-not-a-credential";
      const fixture = yield* serverFixture((_req, res) => {
        res.setHeader("content-type", "application/json");
        if (kind === "403") {
          res.statusCode = 403;
          res.end(JSON.stringify({ message: canary }));
        } else
          res.end(
            JSON.stringify(
              kind === "missing-version"
                ? { metadata: {}, spec: { holderIdentity: "test-pod" }, private: canary }
                : { ...returned, spec: { renewTime: "invalid-date" }, private: canary },
            ),
          );
      });
      const api = yield* liveApi(fixture.url);
      const error = yield* Effect.flip(api.read("krun-test-lease"));
      expect(error._tag).toBe("KubeApiError");
      expect(JSON.stringify(error).includes(canary)).toBe(false);
      if (kind === "403") expect(error.status).toBe(403);
      else expect(error.reason).toBe("invalid_response");
    }),
  );
