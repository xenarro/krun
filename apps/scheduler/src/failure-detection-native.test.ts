import { expect, it } from "@effect/vitest";
import { ConfigLive } from "@krun/shared/dist/config/index.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { toRun } from "@krun/shared/dist/store/mappers.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { DateTime, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { startFailureKube } from "../../../test/fake-kube/failure-detection.js";
import { makeJobController } from "./job-controller.js";
import { JobPodSource, makeJobPodSource } from "./k8s/informers.js";
import { Kube, makeKube } from "./k8s/kube.js";

const namespace = "krun-test-p48-native";
const id = "0192f000-0000-7000-8000-000000000048";
const fn = "p48-native";
const config = ConfigLive("scheduler", {
  env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: namespace },
});
const fixture = (options: { scheduled?: boolean } = {}) =>
  Effect.gen(function* () {
    const api = yield* Effect.acquireRelease(
      Effect.promise(() => startFailureKube(namespace)),
      (value) => Effect.promise(() => value.close()),
    );
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
    // Cache synchronization precedes replacement/native WATCH dispatch; await both sockets too.
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
      created_by: "krun-test-p48",
      created_at: yield* DateTime.now,
      callback_url: "https://receiver.example.invalid/terminal",
    });
    yield* store.setJobToken(id, `krun-${id}`, "owned-test-hash");
    if (options.scheduled !== false) yield* store.markScheduled(id);
    const controller = yield* makeJobController({
      namespace,
      maxRunning: 8,
      checkResult: () => Effect.succeed(null),
    }).pipe(
      Effect.provideService(Kube, kube),
      Effect.provideService(JobPodSource, source),
      Effect.provideService(Scope.Scope, owner),
    );
    const job = (failed = false): V1Job => ({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: `krun-${id}`,
        namespace,
        uid: "krun-test-p48-job",
        labels: { "krun.io/run-id": id },
      },
      status: {
        conditions: failed
          ? [
              {
                type: "Failed",
                status: "True",
                reason: "BackoffLimitExceeded",
                message: "Owned failure",
              },
            ]
          : [],
      },
    });
    const pod = (
      options: { running?: boolean; exit?: number; deleting?: boolean } = {},
    ): V1Pod => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "krun-test-p48-pod",
        namespace,
        uid: "krun-test-p48-pod",
        ...(options.deleting
          ? { deletionTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)) }
          : {}),
        labels: { "krun.io/run-id": id },
      },
      status: {
        phase: options.running ? "Running" : options.exit === 0 ? "Succeeded" : "Failed",
        containerStatuses: [
          {
            name: "function",
            ready: false,
            restartCount: 0,
            image: "owned",
            imageID: "owned",
            state: options.running
              ? { running: {} }
              : {
                  terminated: {
                    exitCode: options.exit ?? 3,
                    reason: options.exit === 0 ? "Completed" : "Error",
                    startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
                    finishedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
                  },
                },
          },
        ],
      },
    });
    const dispatch = (
      resource: "jobs" | "pods",
      object: V1Job | V1Pod,
      phase: "MODIFIED" | "DELETED" = "MODIFIED",
    ) =>
      Effect.gen(function* () {
        const fiber = yield* Stream.runForEach(
          Stream.take(resource === "jobs" ? source.jobEvents : source.podEvents, 1),
          (event) => controller.handle(event.id, event),
        ).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, owner));
        api.emit(resource, phase, object);
        return fiber;
      });
    return { api, owner, store, controller, dispatch, job, pod };
  });
const test = <R>(
  body: (value: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<void, unknown, R>,
  options: { scheduled?: boolean } = {},
) =>
  fixture(options).pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provide(TelemetryLive().pipe(Layer.provide(config))),
  );

it.effect(
  "native LIST/WATCH and pods/log capture precedes JobFailed; metrics names/units and error/tail privacy stay exact",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* Fiber.join(yield* f.dispatch("jobs", f.job()));
        yield* f.store.setError(id, {
          source: "function",
          message: "Owned report",
          details: { private: "krun-test-p48-error-canary" },
        });
        yield* Fiber.join(yield* f.dispatch("pods", f.pod()));
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        expect(f.api.snapshot().logs).toBe(1);
        yield* TestClock.adjust("2500 millis");
        yield* Fiber.join(yield* f.dispatch("jobs", f.job(true)));
        const row = yield* f.store.getRun(id);
        expect(row).toMatchObject({
          state: "failed",
          failure_reason: "exit_code",
          error: { source: "function" },
          log_tail: "krun-test-p48-private-native-tail",
        });
        const requests = f.api.snapshot().requests;
        const logAt = requests.findIndex((request) => request.includes("/log?"));
        const secretAt = requests.findIndex(
          (request) => request.startsWith("DELETE") && request.includes("/secrets/"),
        );
        const jobAt = requests.findIndex(
          (request) => request.startsWith("DELETE") && request.includes("/jobs/"),
        );
        expect(logAt).toBeGreaterThanOrEqual(0);
        expect(secretAt).toBeGreaterThan(logAt);
        expect(jobAt).toBeGreaterThan(secretAt);
        expect(requests[logAt]).toContain("container=function");
        expect(requests[logAt]).toContain("tailLines=100");
        expect(requests[logAt]).toContain("limitBytes=16384");
        expect(requests[jobAt]).toContain("propagationPolicy=Background");
        const text = (yield* (yield* MetricsReader).scrape).body;
        expect(text).toContain(
          'krun_runs_failed_total{function="p48-native",reason="exit_code"} 1',
        );
        expect(text).toContain('krun_terminal_detect_seconds_sum{function="p48-native"} 2.5');
        expect(text).toContain('krun_terminal_detect_seconds_count{function="p48-native"} 1');
        expect(text).not.toMatch(/_total_total|krun-test-p48-private|krun-test-p48-error|run_id/);
        yield* f.controller.reconcile;
        expect(f.api.snapshot().logs).toBe(1);
        const again = (yield* (yield* MetricsReader).scrape).body;
        expect(again).toContain(
          'krun_runs_failed_total{function="p48-native",reason="exit_code"} 1',
        );
      }),
    ),
);

it.effect(
  "native hanging pods/log socket aborts at ten seconds, then the failed Job commits with null tail",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* Fiber.join(yield* f.dispatch("jobs", f.job()));
        f.api.setLog({ hold: true });
        const fiber = yield* f.dispatch("pods", f.pod());
        yield* Effect.promise(() => f.api.logEntered);
        yield* TestClock.adjust("9999 millis");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        yield* Fiber.join(fiber);
        yield* Effect.promise(() => f.api.logClosed);
        expect(f.api.snapshot().abortedLogs).toBe(1);
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        f.api.setLog({ hold: false });
        yield* Fiber.join(yield* f.dispatch("jobs", f.job(true)));
        expect(yield* f.store.getRun(id)).toMatchObject({
          state: "failed",
          log_tail: null,
          error: { source: "kubernetes" },
        });
        expect(f.api.snapshot().logs).toBe(1);
      }),
    ),
);

it.effect(
  "leader-scope closure aborts held native logs and both WATCH streams without terminal writes or post-close work",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* Fiber.join(yield* f.dispatch("jobs", f.job()));
        f.api.setLog({ hold: true });
        const fiber = yield* f.dispatch("pods", f.pod());
        yield* Effect.promise(() => f.api.logEntered);
        yield* Scope.close(f.owner, Exit.void);
        yield* Effect.promise(() => f.api.logClosed);
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        const before = f.api.snapshot().requests.length;
        yield* f.controller.handle(id);
        expect(f.api.snapshot().requests).toHaveLength(before);
        const text = (yield* (yield* MetricsReader).scrape).body;
        expect(text).not.toContain('krun_runs_failed_total{function="p48-native"');
        expect(f.api.snapshot().abortedLogs).toBe(1);
      }),
    ),
);

for (const queued of [false, true]) {
  it.effect(
    `repair: native early deletion then exit0/Complete excludes stored and FULL tail, queued=${queued}`,
    () =>
      test(
        (f) =>
          Effect.gen(function* () {
            yield* Fiber.join(yield* f.dispatch("jobs", f.job()));
            yield* Fiber.join(yield* f.dispatch("pods", f.pod({ running: true, deleting: true })));
            expect(f.api.snapshot().logs).toBe(1);
            if (queued) {
              expect(yield* f.store.getRun(id)).toMatchObject({
                state: "queued",
                job_status: null,
              });
              expect(yield* f.store.markScheduled(id)).toBe(true);
            }
            yield* Fiber.join(yield* f.dispatch("pods", f.pod({ exit: 0, deleting: true })));
            const completed = f.job();
            completed.status = { conditions: [{ type: "Complete", status: "True" }] };
            yield* Fiber.join(yield* f.dispatch("jobs", completed));
            const row = yield* f.store.getRun(id);
            expect(row.state).toBe("succeeded");
            expect(row.log_tail).toBeNull();
            expect(toRun(row)).not.toHaveProperty("logTail");
            expect(f.api.snapshot().logs).toBe(1);
          }),
        { scheduled: !queued },
      ),
  );
}

it.effect(
  "repair: native queued failure captures before Pod eviction and defers all lifecycle writes",
  () =>
    test(
      (f) =>
        Effect.gen(function* () {
          yield* Fiber.join(yield* f.dispatch("jobs", f.job()));
          const failedPod = f.pod();
          yield* Fiber.join(yield* f.dispatch("pods", failedPod));
          expect(f.api.snapshot().logs).toBe(1);
          expect(yield* f.store.getRun(id)).toMatchObject({
            state: "queued",
            job_status: null,
            started_at: null,
          });
          yield* Fiber.join(yield* f.dispatch("pods", failedPod, "DELETED"));
          yield* TestClock.adjust("2 seconds");
          expect(yield* f.store.markScheduled(id)).toBe(true);
          yield* Fiber.join(yield* f.dispatch("jobs", f.job(true)));
          expect(yield* f.store.getRun(id)).toMatchObject({
            state: "failed",
            failure_reason: "disrupted",
            log_tail: "krun-test-p48-private-native-tail",
          });
          const text = (yield* (yield* MetricsReader).scrape).body;
          expect(text).toContain('krun_terminal_detect_seconds_sum{function="p48-native"} 2');
          expect(text).toContain('krun_terminal_detect_seconds_count{function="p48-native"} 1');
          expect(f.api.snapshot().logs).toBe(1);
        }),
      { scheduled: false },
    ),
);
