import { expect, it } from "@effect/vitest";
import { ConfigLive } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { functionSpecSchema } from "@krun/shared/dist/functions/schema.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { type FunctionEvent, FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { toRun } from "@krun/shared/dist/store/mappers.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { startFailureKube } from "../../../test/fake-kube/failure-detection.js";
import { makeHeartbeatLoop } from "./heartbeat-loop.js";
import { makeJobController } from "./job-controller.js";
import { JobPodSource, makeJobPodSource } from "./k8s/informers.js";
import { Kube, makeKube } from "./k8s/kube.js";

const namespace = "krun-test-p49-native";
const id = "0192f000-0000-7000-8000-000000000049";
const fn = "p49-native";
const config = ConfigLive("scheduler", {
  env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: namespace },
});
const fixture = Effect.gen(function* () {
  const api = yield* Effect.acquireRelease(
    Effect.promise(() => startFailureKube(namespace)),
    (value) => Effect.promise(() => value.close()),
  );
  api.setLog({ text: "krun-test-p49-private-native-tail" });
  const owner = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const connection = yield* makeKubeConnection({
    load: (value) =>
      value.loadFromOptions({
        clusters: [{ name: namespace, server: api.address, skipTLSVerify: true }],
        users: [{ name: namespace }],
        contexts: [{ name: namespace, cluster: namespace, user: namespace }],
        currentContext: namespace,
      }),
  });
  const source = yield* makeJobPodSource(namespace).pipe(
    Effect.provideService(KubeConnection, connection),
    Effect.provideService(Scope.Scope, owner),
  );
  yield* source.ready;
  yield* Effect.promise(() => api.ready);
  const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
  const store = yield* Store;
  yield* store.migrate();
  yield* store.createRun({
    id,
    function_name: fn,
    input: {},
    idempotency_key: null,
    request_hash: "a".repeat(64),
    priority: 0,
    created_by: "krun-test-p49",
    created_at: yield* DateTime.now,
    callback_url: "https://receiver.example.invalid/heartbeat",
  });
  yield* store.setJobToken(id, `krun-${id}`, "owned-test-hash");
  yield* store.markScheduled(id);
  let generation = 1;
  let uid = "krun-test-p49-function";
  const resource = (timeout: string | undefined, invalid = false) => ({
    metadata: { name: fn, namespace, uid, generation, resourceVersion: String(generation) },
    spec: functionSpecSchema.parse({
      image: `ghcr.io/krun-test/function@sha256:${"a".repeat(64)}`,
      inputSchema: { type: invalid ? "not-a-type" : "object" },
      ...(timeout === undefined ? {} : { heartbeatTimeout: timeout }),
    }),
  });
  const feed = yield* Queue.unbounded<FunctionEvent>();
  const functions = yield* makeFunctions({
    namespace,
    ceilings: {
      maxActiveDeadline: 86400,
      maxQueued: 1000,
      allowedRegistries: ["ghcr.io"],
      allowedServiceAccounts: ["krun-job-default"],
      webhookAllowedHosts: [],
    },
  }).pipe(
    Effect.provideService(FunctionSource, { watch: () => Stream.fromQueue(feed) }),
    Effect.provideService(Scope.Scope, owner),
  );
  yield* Queue.offer(feed, { type: "sync", items: [resource("30s")] });
  yield* functions.synced;
  const changePolicy = (options: {
    timeout?: string;
    replace?: boolean;
    invalid?: boolean;
    remove?: boolean;
  }) =>
    Effect.gen(function* () {
      generation++;
      if (options.replace) uid = "krun-test-p49-replaced-function";
      const observed = yield* functions.status.changes.pipe(
        Stream.mapEffect(() => functions.getAny(fn)),
        Stream.filter((entry) =>
          options.remove ? entry === undefined : entry?.generation === generation,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const document = resource(options.timeout, options.invalid);
      yield* Queue.offer(feed, { type: options.remove ? "delete" : "update", object: document });
      yield* Fiber.join(observed);
    });
  const ordered: Store["Service"] = {
    ...store,
    listStale: (...args) =>
      store
        .listStale(...args)
        .pipe(Effect.map((rows) => rows.sort((a, b) => a.id.localeCompare(b.id)))),
  };
  const controller = yield* makeJobController({
    namespace,
    maxRunning: 8,
    checkResult: () => Effect.succeed(null),
  }).pipe(
    Effect.provideService(Kube, kube),
    Effect.provideService(JobPodSource, source),
    Effect.provideService(Scope.Scope, owner),
  );
  const heartbeat = yield* makeHeartbeatLoop({ controller }).pipe(
    Effect.provideService(Store, ordered),
    Effect.provideService(Functions, functions),
    Effect.provideService(JobPodSource, source),
    Effect.provideService(Scope.Scope, owner),
  );
  const job = (failed = false): V1Job => ({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `krun-${id}`,
      namespace,
      uid: "krun-test-p49-job",
      labels: { "krun.io/run-id": id },
    },
    status: {
      conditions: failed
        ? [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }]
        : [],
    },
  });
  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "krun-test-p49-pod",
      namespace,
      uid: "krun-test-p49-pod",
      labels: { "krun.io/run-id": id },
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "function",
          ready: true,
          restartCount: 0,
          image: "owned",
          imageID: "owned",
          state: { running: {} },
        },
      ],
    },
  };
  const dispatch = (
    resource: "jobs" | "pods",
    object: V1Job | V1Pod,
    seen?: Deferred.Deferred<void>,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* Stream.runForEach(
        Stream.take(resource === "jobs" ? source.jobEvents : source.podEvents, 1),
        (event) =>
          (seen === undefined ? Effect.void : Deferred.succeed(seen, undefined)).pipe(
            Effect.andThen(controller.handle(event.id, event)),
          ),
      ).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, owner));
      api.emit(resource, "MODIFIED", object);
      return fiber;
    });
  yield* Fiber.join(yield* dispatch("jobs", job()));
  yield* Fiber.join(yield* dispatch("pods", pod));
  return { api, owner, source, store, controller, heartbeat, dispatch, job, pod, changePolicy };
});
const test = <R>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, unknown, R>) =>
  fixture.pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provide(TelemetryLive().pipe(Layer.provide(config))),
    Effect.provide(ReadinessLive(Effect.void)),
  );

it.effect(
  "native heartbeat uses bounded function logs then foreground DELETE, committed failed/Basic delivery,Secret and exact private-safe metric",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.store.setRuntimeStatus(id, { message: "initial", at: yield* DateTime.now });
        yield* f.store.setError(id, {
          source: "function",
          message: "owned report",
          details: { private: "krun-test-p49-error-canary" },
        });
        yield* TestClock.adjust("31 seconds");
        yield* f.heartbeat.iterate;
        const row = yield* f.store.getRun(id);
        expect(row).toMatchObject({
          state: "failed",
          failure_reason: "heartbeat_timeout",
          error: { source: "function" },
          log_tail: "krun-test-p49-private-native-tail",
        });
        expect(toRun(row)).toHaveProperty("logTail", row.log_tail);
        const requests = f.api.snapshot().requests;
        const operations = requests.filter((r) => r.includes("/log?") || r.startsWith("DELETE"));
        expect(operations).toHaveLength(3);
        expect(operations[0]).toMatch(/container=function/);
        expect(operations[0]).toContain("tailLines=100");
        expect(operations[0]).toContain("limitBytes=16384");
        expect(operations[1]).toContain("propagationPolicy=Foreground");
        expect(operations[2]).toContain("/secrets/");
        const deliveries = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
        expect(deliveries).toHaveLength(1);
        expect(JSON.stringify(deliveries[0]?.payload)).not.toMatch(
          /logTail|private-native-tail|error-canary/,
        );
        const metrics = (yield* (yield* MetricsReader).scrape).body;
        expect(metrics).toContain(
          'krun_runs_failed_total{function="p49-native",reason="heartbeat_timeout"} 1',
        );
        expect(metrics).not.toMatch(
          /_total_total|private-native-tail|error-canary|krun_terminal_detect_seconds_count\{function="p49-native"/,
        );
      }),
    ),
);
it.effect("native failed log request still permits foreground timeout with null tail", () =>
  test((f) =>
    Effect.gen(function* () {
      f.api.setLog({ status: 403 });
      yield* TestClock.adjust("31 seconds");
      yield* f.heartbeat.iterate;
      expect(yield* f.store.getRun(id)).toMatchObject({
        state: "failed",
        failure_reason: "heartbeat_timeout",
        log_tail: null,
      });
      expect(f.api.snapshot().logs).toBe(1);
    }),
  ),
);
it.effect(
  "native leader-scope close aborts held heartbeat logs and WATCH without deletion or publication",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.api.setLog({ hold: true });
        yield* TestClock.adjust("31 seconds");
        const fiber = yield* Effect.forkScoped(f.heartbeat.iterate).pipe(
          Effect.provideService(Scope.Scope, f.owner),
        );
        yield* Effect.promise(() => f.api.logEntered);
        yield* Scope.close(f.owner, Exit.void);
        yield* Effect.promise(() => f.api.logClosed);
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
        expect((yield* f.store.getRun(id)).state).toBe("running");
        const before = f.api.snapshot().requests.length;
        yield* f.heartbeat.iterate;
        yield* TestClock.adjust("20 seconds");
        expect(f.api.snapshot().requests).toHaveLength(before);
        expect(f.api.snapshot().requests.some((r) => r.startsWith("DELETE"))).toBe(false);
        expect(f.api.snapshot().abortedLogs).toBe(1);
      }),
    ),
);
it.effect("native terminal Job ingress during held heartbeat logs retains informer ownership", () =>
  test((f) =>
    Effect.gen(function* () {
      f.api.setLog({ hold: true });
      yield* TestClock.adjust("31 seconds");
      const heartbeat = yield* Effect.forkScoped(f.heartbeat.iterate);
      yield* Effect.promise(() => f.api.logEntered);
      const seen = yield* Deferred.make<void>();
      const observed = yield* f.dispatch("jobs", f.job(true), seen);
      yield* Deferred.await(seen);
      f.api.setLog({ hold: false });
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(heartbeat);
      yield* Fiber.join(observed);
      yield* Effect.promise(() => f.api.logClosed);
      expect((yield* f.store.getRun(id)).failure_reason).not.toBe("heartbeat_timeout");
      expect((yield* f.store.getRun(id)).state).toBe("failed");
      expect(
        f.api.snapshot().requests.some((r) => r.includes("propagationPolicy=Foreground")),
      ).toBe(false);
      expect((yield* (yield* MetricsReader).scrape).body).not.toContain(
        'reason="heartbeat_timeout"',
      );
    }),
  ),
);

for (const change of [
  { label: "disabled", options: {} },
  { label: "extended", options: { timeout: "120s" } },
  { label: "deleted", options: { remove: true } },
  { label: "invalid", options: { timeout: "30s", invalid: true } },
  { label: "replaced", options: { timeout: "30s", replace: true } },
])
  it.effect(
    `repair: current Function ${change.label} during native logs prevents the first DELETE`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("31 seconds");
          f.api.setLog({ hold: true });
          const fiber = yield* Effect.forkScoped(f.heartbeat.iterate);
          yield* Effect.promise(() => f.api.logEntered);
          yield* f.changePolicy(change.options);
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(fiber);
          yield* Effect.promise(() => f.api.logClosed);
          expect((yield* f.store.getRun(id)).state).toBe("running");
          expect(f.api.snapshot().requests.some((r) => r.startsWith("DELETE"))).toBe(false);
          expect((yield* (yield* MetricsReader).scrape).body).not.toContain(
            'reason="heartbeat_timeout"',
          );
        }),
      ),
  );
it.effect(
  "repair: changed but still-expired Function policy supplies the current timeout message",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("31 seconds");
        f.api.setLog({ hold: true });
        const fiber = yield* Effect.forkScoped(f.heartbeat.iterate);
        yield* Effect.promise(() => f.api.logEntered);
        yield* f.changePolicy({ timeout: "40s" });
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        yield* Effect.promise(() => f.api.logClosed);
        expect(yield* f.store.getRun(id)).toMatchObject({
          state: "failed",
          failure_reason: "heartbeat_timeout",
          error: { source: "krun", message: "no status for 40s, last at 1970-01-01T00:00:00.000Z" },
        });
      }),
    ),
);
for (const disabled of [true, false])
  it.effect(
    `repair: policy is refreshed before a later stale row starts,disabled=${disabled}`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          const later = "0192f000-0000-7000-8000-000000000050";
          yield* f.store.createRun({
            id: later,
            function_name: fn,
            input: {},
            idempotency_key: null,
            request_hash: "a".repeat(64),
            priority: 0,
            created_by: "krun-test-p49",
            created_at: yield* DateTime.now,
            callback_url: null,
          });
          yield* f.store.setJobToken(later, `krun-${later}`, "owned-test-hash");
          yield* f.store.markScheduled(later);
          const job = f.job();
          job.metadata = {
            ...job.metadata,
            name: `krun-${later}`,
            labels: { "krun.io/run-id": later },
          };
          const pod = {
            ...f.pod,
            metadata: {
              ...f.pod.metadata,
              name: "krun-test-p49-later-pod",
              labels: { "krun.io/run-id": later },
            },
          };
          yield* Fiber.join(yield* f.dispatch("jobs", job));
          yield* Fiber.join(yield* f.dispatch("pods", pod));
          yield* TestClock.adjust("31 seconds");
          f.api.setLog({ hold: true });
          const fiber = yield* Effect.forkScoped(f.heartbeat.iterate);
          yield* Effect.promise(() => f.api.logEntered);
          if (disabled) yield* f.changePolicy({});
          f.api.setLog({ hold: false });
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(fiber);
          yield* Effect.promise(() => f.api.logClosed);
          expect((yield* f.store.getRun(later)).state).toBe(disabled ? "running" : "failed");
          expect(f.api.snapshot().logs).toBe(disabled ? 1 : 2);
          expect(
            f.api.snapshot().requests.filter((r) => r.includes("propagationPolicy=Foreground")),
          ).toHaveLength(disabled ? 0 : 2);
        }),
      ),
  );
