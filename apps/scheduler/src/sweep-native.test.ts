import { expect, it } from "@effect/vitest";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { DateTime, Duration, Effect, Exit, Fiber, Metric, Scope } from "effect";
import { TestClock } from "effect/testing";
import { startSweepKube } from "../../../test/fake-kube/sweep.js";
import { JobPodSource, makeJobPodSource } from "./k8s/informers.js";
import { makeSweepLoop } from "./sweep-loop.js";

const namespace = "krun-test-p410-native";
const id = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const wireSecret = (n: number, at = "1970-01-01T00:00:00.000Z") => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: {
    name: `krun-${id(n)}`,
    namespace,
    uid: `uid-${n}`,
    resourceVersion: "1",
    labels: { "krun.io/run-id": id(n) },
    creationTimestamp: at,
  },
  data: { token: "krun-test-p410-private-token" },
});
const count = Metric.value(Metric.counter("krun_sweep_deleted_total", { incremental: true })).pipe(
  Effect.map((value) => value.count),
);
const fixture = Effect.gen(function* () {
  const api = yield* Effect.acquireRelease(
    Effect.promise(() => startSweepKube(namespace)),
    (value) => Effect.promise(() => value.close()),
  );
  const connection = yield* makeKubeConnection({
    load: (config) =>
      config.loadFromClusterAndUser(
        { name: namespace, server: api.address, skipTLSVerify: true },
        { name: namespace },
      ),
  });
  api.jobs.set("noncanonical-job", {
    metadata: {
      name: "noncanonical-job",
      namespace,
      uid: "job-3",
      labels: { "krun.io/run-id": id(3) },
    },
  });
  const owner = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const source = yield* makeJobPodSource(namespace).pipe(
    Effect.provideService(KubeConnection, connection),
    Effect.provideService(Scope.Scope, owner),
  );
  yield* source.ready;
  yield* Effect.promise(() => api.ready);
  const store = yield* Store;
  yield* store.migrate();
  const create = (n: number, callback = false) =>
    store.createRun({
      id: id(n),
      function_name: "p410-native",
      input: { private: "krun-test-p410-input" },
      idempotency_key: null,
      request_hash: "a".repeat(64),
      priority: 0,
      created_by: namespace,
      created_at: DateTime.makeUnsafe(0),
      callback_url: callback ? "https://receiver.example.invalid/sweep" : null,
    });
  yield* create(1, true);
  yield* store.transition(id(1), "queued", "failed", "queue_timeout", {});
  yield* TestClock.adjust("1 hour");
  yield* create(2);
  yield* store.transition(id(2), "queued", "failed", "queue_timeout", {});
  yield* create(3);
  yield* TestClock.adjust("1 hour");
  for (const item of [wireSecret(1), wireSecret(2, "1970-01-01T01:00:00.000Z"), wireSecret(3)])
    api.secrets.set(item.metadata.name, item);
  const calls: number[] = [];
  const loop = yield* makeSweepLoop({ namespace, retention: Duration.hours(1) }).pipe(
    Effect.provideService(Store, {
      ...store,
      sweep: (...args) =>
        store.sweep(...args).pipe(
          Effect.tap((n) =>
            Effect.sync(() => {
              calls.push(n);
            }),
          ),
        ),
    }),
    Effect.provideService(KubeConnection, connection),
    Effect.provideService(JobPodSource, source),
    Effect.provideService(Scope.Scope, owner),
  );
  return { api, source, owner, store, loop, calls };
});
const run = <R>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, unknown, R>) =>
  fixture.pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );

it.effect(
  "native Secret list/DELETE and real SQLite retain boundary/active runs and live-Job Secrets,delete old runs and cascade their pending deliveries",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(1)).pipe(Effect.flip))._tag).toBe("NotFoundError");
        expect((yield* f.store.getRun(id(2))).state).toBe("failed");
        expect((yield* f.store.getRun(id(3))).state).toBe("queued");
        expect(yield* f.store.claimDeliveries(yield* DateTime.now, 40)).toHaveLength(0);
        expect(f.api.secrets.has(`krun-${id(1)}`)).toBe(false);
        expect(f.api.secrets.has(`krun-${id(2)}`)).toBe(true);
        expect(f.api.secrets.has(`krun-${id(3)}`)).toBe(true);
        expect(f.calls).toEqual([1]);
        expect(yield* count).toBe(1);
        const lists = f.api.requests.filter(
          (r) => r.method === "GET" && r.path.endsWith("/secrets"),
        );
        expect(lists[0]?.query).toEqual({ labelSelector: "krun.io/run-id", limit: "1000" });
        const deletes = f.api.requests.filter((r) => r.method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.body).toEqual({ preconditions: { uid: "uid-1", resourceVersion: "1" } });
        expect(
          f.api.requests.filter(
            (r) =>
              r.path.includes("/jobs/") || (r.method === "DELETE" && !r.path.includes("/secrets/")),
          ),
        ).toHaveLength(0);
      }),
    ),
);
it.effect(
  "native continuation decoding drains pages and a transient DELETE does not suppress later cleanup",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.api.setPageSize(1);
        f.api.failNextDelete(503);
        for (const n of [4, 5]) {
          const value = wireSecret(n);
          f.api.secrets.set(value.metadata.name, value);
        }
        yield* f.loop.iterate;
        expect(f.api.secrets.has(`krun-${id(1)}`)).toBe(true);
        expect(f.api.secrets.has(`krun-${id(4)}`)).toBe(false);
        expect(f.api.secrets.has(`krun-${id(5)}`)).toBe(false);
        expect(f.api.requests.filter((r) => r.query.continue !== undefined).length).toBeGreaterThan(
          1,
        );
        yield* f.loop.iterate;
        expect(f.api.secrets.has(`krun-${id(1)}`)).toBe(false);
        expect(yield* count).toBe(1);
      }),
    ),
);
it.effect(
  "native hanging Secret DELETE aborts at ten seconds,keeps the orphan retryable and does not recount SQL",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.api.hang("delete");
        const fiber = yield* f.loop.iterate.pipe(Effect.forkScoped);
        while (!f.api.requests.some((r) => r.method === "DELETE")) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        while (!f.api.aborted.includes("delete")) yield* Effect.yieldNow;
        expect(f.api.secrets.has(`krun-${id(1)}`)).toBe(true);
        expect(yield* count).toBe(1);
        f.api.hang(undefined);
        yield* f.loop.iterate;
        expect(f.api.secrets.has(`krun-${id(1)}`)).toBe(false);
        // Ten seconds moved the formerly exact-boundary row into retention.
        expect(f.calls).toEqual([1, 1]);
        expect(yield* count).toBe(2);
      }),
    ),
);
it.effect(
  "closing the elected leader scope aborts the native list socket and retained sweep cannot resume work",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.api.hang("list");
        yield* f.loop.iterate.pipe(Effect.forkIn(f.owner));
        while (!f.api.requests.some((r) => r.path.endsWith("/secrets"))) yield* Effect.yieldNow;
        yield* Scope.close(f.owner, Exit.void);
        while (!f.api.aborted.includes("list")) yield* Effect.yieldNow;
        const requests = f.api.requests.length;
        yield* f.loop.iterate;
        yield* f.loop.run;
        expect(f.api.requests).toHaveLength(requests);
        expect(yield* count).toBe(1);
      }),
    ),
);
