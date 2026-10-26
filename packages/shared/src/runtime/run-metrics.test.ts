import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Metric, Scope } from "effect";
import { TestClock } from "effect/testing";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { ConfigLive } from "../config/index.js";
import { MetricsReader } from "../health/metrics.js";
import { type NewRun, Store } from "../store/index.js";
import { StorePostgres, StoreSqlite } from "../store/live.js";
import { leaderRunStore, makeRunGauges } from "./run-metrics.js";
import { TelemetryLive } from "./telemetry.js";

let container: StartedPostgreSqlContainer;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p46-metrics-${process.pid}`)
      .withDatabase("krun_test_p46")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
  } catch {
    throw new Error("Owned metrics Postgres fixture failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const config = ConfigLive("scheduler", {
  env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p46" },
});
const telemetry = () => TelemetryLive().pipe(Layer.provide(config));
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const seed = (n: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const run: NewRun = {
      id: id(n),
      function_name: "echo",
      idempotency_key: null,
      request_hash: "a".repeat(64),
      input: { private: "krun-test-metrics-private" },
      priority: 0,
      callback_url: null,
      created_by: "owned",
      created_at: yield* DateTime.now,
    };
    yield* store.createRun(run);
    return run;
  });
const metric = (name: string, attributes: Record<string, string> = {}) =>
  Metric.withAttributes(Metric.counter(name, { incremental: true }), attributes);
const count = (to: string) =>
  Metric.value(metric("krun_runs_transitions_total", { function: "echo", to })).pipe(
    Effect.map((state) => state.count),
  );
for (const dialect of ["sqlite", "postgres"] as const) {
  it.effect(
    `${dialect}: committed CAS-only metrics, no gateway/stale/rollback/status samples, fallback and expiry durations`,
    () =>
      Effect.gen(function* () {
        const actual = yield* Store;
        const leader = leaderRunStore(actual);
        yield* actual.migrate();
        yield* seed(1);
        // Plain Store (gateway/standby) must not publish scheduler samples.
        yield* actual.markScheduled(id(1));
        yield* actual.transition(id(1), "scheduled", "running", null, {});
        expect(yield* count("scheduled")).toBe(0);
        expect(yield* count("running")).toBe(0);
        yield* seed(2);
        yield* TestClock.adjust("1500 millis");
        expect(yield* leader.markScheduled(id(2))).toBe(true);
        expect(yield* leader.markScheduled(id(2))).toBe(false);
        yield* TestClock.adjust("2500 millis");
        expect(yield* leader.transition(id(2), "scheduled", "running", null, {})).toBe(true);
        yield* leader.setJobStatus(id(2), { phase: "Running", observedAt: yield* DateTime.now });
        yield* leader.transition(id(2), "running", "running", null, {});
        expect(yield* count("running")).toBe(1);
        // Invalid winning failure classification rolls back rather than emitting.
        expect(
          (yield* Effect.exit(leader.transition(id(2), "running", "failed", null, {})))._tag,
        ).toBe("Failure");
        expect(yield* count("failed")).toBe(0);
        yield* TestClock.adjust("4 seconds");
        yield* leader.transition(id(2), "running", "succeeded", null, {});
        expect(yield* leader.transition(id(2), "running", "succeeded", null, {})).toBe(false);
        yield* seed(3);
        yield* leader.markScheduled(id(3));
        yield* TestClock.adjust("3 seconds");
        yield* leader.transition(id(3), "scheduled", "succeeded", null, {
          started_at: DateTime.makeUnsafe(9000),
        });
        yield* seed(4);
        yield* TestClock.adjust("2 seconds");
        expect(
          (yield* leader.expireQueued("echo", yield* DateTime.now)).map((run) => run.id),
        ).toEqual([id(4)]);
        expect(yield* leader.expireQueued("echo", yield* DateTime.now)).toEqual([]);
        expect(yield* count("scheduled")).toBe(2);
        expect(yield* count("running")).toBe(1);
        expect(yield* count("succeeded")).toBe(2);
        expect(yield* count("failed")).toBe(1);
        const text = (yield* (yield* MetricsReader).scrape).body;
        expect(text).toContain('krun_queue_wait_seconds_sum{function="echo"} 1.5');
        expect(text).toContain('krun_cold_start_seconds_sum{function="echo"} 2.5');
        expect(text).toContain('krun_cold_start_seconds_count{function="echo"} 1');
        expect(text).toContain(
          'krun_run_duration_seconds_sum{function="echo",state="succeeded"} 6',
        );
        expect(text).toContain(
          'krun_run_duration_seconds_count{function="echo",state="succeeded"} 2',
        );
        expect(text).not.toMatch(/krun-test-metrics-private|_total_total|run_id/);
      }).pipe(
        Effect.provide(
          dialect === "sqlite"
            ? StoreSqlite(":memory:")
            : StorePostgres(container.getConnectionUri()),
        ),
        Effect.provide(telemetry()),
      ),
  );
}

it.effect(
  "gauge publisher zeros missing states/functions and releases leader gauges without replay",
  () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      const publish = yield* makeRunGauges.pipe(Effect.provideService(Scope.Scope, owner));
      const gauge = (fn: string, state: string) =>
        Metric.value(
          Metric.withAttributes(Metric.gauge("krun_runs_current"), { function: fn, state }),
        ).pipe(Effect.map((s) => s.value));
      yield* publish(
        new Map([
          [
            "gone",
            new Map([
              ["queued", 2],
              ["running", 1],
            ]),
          ],
        ]),
      );
      yield* publish(new Map([["echo", new Map([["scheduled", 3]])]]));
      expect(yield* gauge("gone", "queued")).toBe(0);
      expect(yield* gauge("gone", "running")).toBe(0);
      expect(yield* gauge("echo", "scheduled")).toBe(3);
      yield* Scope.close(owner, Exit.void);
      expect(yield* gauge("echo", "scheduled")).toBe(0);
      yield* publish(new Map([["echo", new Map([["scheduled", 9]])]]));
      expect(yield* gauge("echo", "scheduled")).toBe(0);
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
);

it.effect(
  "settled Store commit is counted before pending interruption; cleanup/retry cannot double count",
  () =>
    Effect.gen(function* () {
      const actual = yield* Store;
      yield* actual.migrate();
      yield* seed(10);
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Pause outside the actual Store but inside the caller's masked write.
      const leader = leaderRunStore({
        ...actual,
        markScheduled: (id) =>
          actual.markScheduled(id).pipe(
            Effect.tap(() => Deferred.succeed(committed, undefined)),
            Effect.tap(() => Deferred.await(release)),
            Effect.uninterruptible,
          ),
      });
      const fiber = yield* Effect.forkScoped(leader.markScheduled(id(10)));
      yield* Deferred.await(committed);
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(fiber));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect((yield* actual.getRun(id(10))).state).toBe("scheduled");
      expect(yield* count("scheduled")).toBe(1);
      expect(yield* leader.markScheduled(id(10))).toBe(false);
      expect(yield* count("scheduled")).toBe(1);
    }).pipe(
      Effect.provide(StoreSqlite(":memory:")),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
);
