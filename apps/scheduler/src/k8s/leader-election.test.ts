import { expect, it } from "@effect/vitest";
import { Readiness, ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import type { V1Lease } from "@kubernetes/client-node";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Metric, Ref } from "effect";
import { TestClock } from "effect/testing";
import { LeaderConfigInvalid, LeaderLost, runLeaderElection } from "./leader-election.js";
import { LeaseApi, type LeaseRecord } from "./lease-api.js";

const options = { namespace: "krun-test-election", podName: "krun-scheduler-test" };
const error = (status: number) =>
  new KubeApiError({ operation: "request", reason: "request_failed", status });
const stamp = (iso = "2099-01-01T00:00:00.000Z") => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const fixture = Effect.gen(function* () {
  let current: LeaseRecord | undefined;
  let failWrites = false;
  let readFailure: number | undefined;
  let conflictOnce = false;
  let version = 0;
  const writes: V1Lease[] = [];
  const events: string[] = [];
  const started = yield* Deferred.make<void>();
  const api: LeaseApi["Service"] = {
    read: () =>
      Effect.suspend(() =>
        readFailure
          ? Effect.fail(error(readFailure))
          : current
            ? Effect.succeed(structuredClone(current))
            : Effect.fail(error(404)),
      ),
    create: (_ns, body) =>
      Effect.sync(() => {
        events.push("create");
        current = {
          ...structuredClone(body),
          metadata: { ...body.metadata, resourceVersion: String(++version) },
        };
        writes.push(structuredClone(body));
        return current;
      }),
    replace: (_ns, body) =>
      Effect.suspend(() => {
        if (failWrites) return Effect.fail(error(503));
        if (conflictOnce) {
          conflictOnce = false;
          return Effect.fail(error(409));
        }
        if (body.metadata?.resourceVersion !== current?.metadata?.resourceVersion)
          return Effect.fail(error(409));
        events.push(body.spec?.holderIdentity === "" ? "release" : "replace");
        writes.push(structuredClone(body));
        current = {
          ...structuredClone(body),
          metadata: { ...body.metadata, resourceVersion: String(++version) },
        };
        return Effect.succeed(current);
      }),
  };
  const work = Effect.gen(function* () {
    for (const name of ["job-informer", "pod-informer", "loop", "status-writer"])
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`start:${name}`);
        }),
        () =>
          Effect.sync(() => {
            events.push(`stop:${name}`);
          }),
      );
    yield* Effect.forkScoped(
      Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("api-aborted");
                reject(error(503));
              },
              { once: true },
            );
          }),
        catch: () => error(503),
      }),
    );
    yield* Deferred.succeed(started, undefined);
  });
  return {
    api,
    work,
    started,
    writes,
    events,
    get current() {
      return current;
    },
    set current(value: LeaseRecord | undefined) {
      current = value;
    },
    set failWrites(value: boolean) {
      failWrites = value;
    },
    set readFailure(value: number | undefined) {
      readFailure = value;
    },
    set conflictOnce(value: boolean) {
      conflictOnce = value;
    },
  };
});
const service = (api: LeaseApi["Service"]) =>
  Layer.merge(Layer.succeed(LeaseApi, api), ReadinessLive(Effect.void));
const leading = Readiness.use((r) => Ref.get(r.state).pipe(Effect.map((s) => s.leader)));
const gauge = () => Metric.value(Metric.gauge("krun_scheduler_leader"));

it.effect(
  "creates the absent Lease with pod identity and starts/stops all leader resources before release",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
        yield* Deferred.await(f.started);
        expect(yield* leading).toBe(true);
        expect((yield* gauge()).value).toBe(1);
        expect(f.current?.metadata?.name).toBe("krun-scheduler");
        expect(f.current?.spec?.holderIdentity).toBe(options.podName);
        expect(f.current?.spec?.leaseDurationSeconds).toBe(15);
        expect(f.events.filter((e) => e.startsWith("start:")).length).toBe(4);
        yield* Fiber.interrupt(fiber);
        const stopped = yield* Fiber.await(fiber);
        expect(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause)).toBe(true);
        expect(yield* leading).toBe(false);
        expect((yield* gauge()).value).toBe(0);
        expect(f.current?.spec?.holderIdentity).toBe("");
        for (const name of ["job-informer", "pod-informer", "loop", "status-writer"])
          expect(f.events.indexOf(`stop:${name}`)).toBeLessThan(f.events.indexOf("release"));
        expect(f.events.indexOf("api-aborted")).toBeLessThan(f.events.indexOf("release"));
      }).pipe(Effect.provide(service(f.api)));
    }),
);

it.effect("renews by read then replace with the current resourceVersion every two seconds", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* Deferred.await(f.started);
      yield* TestClock.adjust("2 seconds");
      expect(f.writes.at(-1)?.metadata?.resourceVersion).toBe("1");
      expect(f.current?.metadata?.resourceVersion).toBe("2");
      expect(f.current?.spec?.renewTime).toEqual(stamp("1970-01-01T00:00:02Z"));
      expect(f.events.filter((e) => e === "create")).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(f.api)));
  }),
);

for (const identity of ["other-pod", options.podName])
  it.effect(`waits for locally observed expiry even with skew and prior identity ${identity}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.current = {
        metadata: { resourceVersion: "old" },
        spec: { holderIdentity: identity, renewTime: stamp() },
      };
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
        yield* TestClock.adjust("14 seconds");
        expect(f.writes).toHaveLength(0);
        expect(yield* leading).toBe(false);
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(f.started);
        expect(f.writes[0]?.metadata?.resourceVersion).toBe("old");
        expect(yield* leading).toBe(true);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(service(f.api)));
    }),
  );

it.effect("renews observation only on holder or renewTime change, not resourceVersion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.current = {
      metadata: { resourceVersion: "old" },
      spec: { holderIdentity: "other", renewTime: stamp() },
    };
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* TestClock.adjust("10 seconds");
      f.current = {
        metadata: { resourceVersion: "new" },
        spec: { holderIdentity: "other", renewTime: stamp("2099-01-01T00:00:01Z") },
      };
      yield* TestClock.adjust("14 seconds");
      expect(f.writes).toHaveLength(0);
      f.current = { ...f.current, metadata: { resourceVersion: "metadata-only" } };
      yield* TestClock.adjust("4 seconds");
      yield* Deferred.await(f.started);
      expect(f.writes[0]?.metadata?.resourceVersion).toBe("metadata-only");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(f.api)));
  }),
);

it.effect("409 retries in two seconds without restarting leader work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* Deferred.await(f.started);
      f.conflictOnce = true;
      yield* TestClock.adjust("2 seconds");
      expect(f.writes).toHaveLength(1);
      expect(yield* leading).toBe(true);
      yield* TestClock.adjust("2 seconds");
      expect(f.writes).toHaveLength(2);
      expect(f.events.filter((e) => e === "start:loop")).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(f.api)));
  }),
);

it.effect("known holder loss stops the leader and never clears another pod's Lease", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work).pipe(Effect.flip));
      yield* Deferred.await(f.started);
      f.current = {
        metadata: { resourceVersion: "other" },
        spec: { holderIdentity: "other", renewTime: stamp() },
      };
      yield* TestClock.adjust("2 seconds");
      const lost = yield* Fiber.join(fiber);
      expect(lost).toBeInstanceOf(LeaderLost);
      expect(lost).toMatchObject({ reason: "holder_changed" });
      expect(yield* leading).toBe(false);
      expect((yield* gauge()).value).toBe(0);
      expect(f.events).toContain("stop:job-informer");
      expect(f.events).toContain("api-aborted");
      expect(f.events).not.toContain("release");
    }).pipe(Effect.provide(service(f.api)));
  }),
);

it.effect("fails at ten seconds without renewal while cancelling resources and pending calls", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work).pipe(Effect.flip));
      yield* Deferred.await(f.started);
      f.failWrites = true;
      yield* TestClock.adjust("9999 millis");
      expect(yield* leading).toBe(true);
      yield* TestClock.adjust("1 millis");
      const lost = yield* Fiber.join(fiber);
      expect(lost).toBeInstanceOf(LeaderLost);
      expect(lost).toMatchObject({ reason: "renew_deadline" });
      expect(f.events).toContain("api-aborted");
      expect(f.events).toContain("stop:status-writer");
      expect(yield* leading).toBe(false);
    }).pipe(Effect.provide(service(f.api)));
  }),
);

it.effect("the renew deadline interrupts a stalled Lease read, not only completed retries", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let stalled = false;
    let aborted = false;
    const api = {
      ...f.api,
      read: (ns: string) =>
        stalled
          ? Effect.tryPromise({
              try: (signal: AbortSignal) =>
                new Promise<V1Lease>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      aborted = true;
                      reject(error(503));
                    },
                    { once: true },
                  );
                }),
              catch: () => error(503),
            })
          : f.api.read(ns),
    };
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work).pipe(Effect.flip));
      yield* Deferred.await(f.started);
      stalled = true;
      yield* TestClock.adjust("10 seconds");
      expect(yield* leading).toBe(false);
      expect(aborted).toBe(true);
      // Release is independently bounded even if its read is also stalled.
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(fiber))._tag).toBe("LeaderLost");
    }).pipe(Effect.provide(service(api)));
  }),
);

it.effect("an explicitly unheld Lease is acquired immediately with its resourceVersion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.current = {
      metadata: { resourceVersion: "released" },
      spec: { holderIdentity: "", renewTime: stamp() },
    };
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* Deferred.await(f.started);
      expect(f.writes[0]?.metadata?.resourceVersion).toBe("released");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(f.api)));
  }),
);
it.effect("403 is permanent and never opens a leader scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.readFailure = 403;
    const result = yield* runLeaderElection(options, f.work).pipe(
      Effect.flip,
      Effect.provide(service(f.api)),
    );
    expect(result).toMatchObject({ _tag: "KubeApiError", status: 403 });
    expect(f.events).toHaveLength(0);
  }),
);
it.effect("a create conflict retries at two seconds without claiming leadership early", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let first = true;
    const api = {
      ...f.api,
      create: (ns: string, body: V1Lease) => {
        if (first) {
          first = false;
          return Effect.fail(error(409));
        }
        return f.api.create(ns, body);
      },
    };
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* TestClock.adjust("1999 millis");
      expect(yield* leading).toBe(false);
      expect(f.writes).toHaveLength(0);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(f.started);
      expect(yield* leading).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(api)));
  }),
);
it.effect("renewal runs while leader-only resource initialization is stalled", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const work = Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          f.events.push("init-closed");
        }),
      );
      yield* Deferred.succeed(entered, undefined);
      yield* Effect.never;
    });
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, work));
      yield* Deferred.await(entered);
      yield* TestClock.adjust("8 seconds");
      expect(f.writes).toHaveLength(5);
      expect(yield* leading).toBe(true);
      yield* Fiber.interrupt(fiber);
      expect(f.events.indexOf("init-closed")).toBeLessThan(f.events.indexOf("release"));
    }).pipe(Effect.provide(service(f.api)));
  }),
);
it.effect("invalid identity fails before API or leadership work and never retains the value", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* runLeaderElection({ ...options, podName: "not/a/pod" }, f.work).pipe(
      Effect.flip,
      Effect.provide(service(f.api)),
    );
    expect(result).toBeInstanceOf(LeaderConfigInvalid);
    expect(result).toMatchObject({ _tag: "LeaderConfigInvalid", field: "podName" });
    expect(JSON.stringify(result).includes("not/a/pod")).toBe(false);
    expect(f.events).toHaveLength(0);
  }),
);

it.effect("compares native wire MicroTime changes at full microsecond precision", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.current = JSON.parse(
      '{"metadata":{"resourceVersion":"wire"},"spec":{"holderIdentity":"other","renewTime":"2099-01-01T00:00:00.000001Z"}}',
    );
    yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* TestClock.adjust("14 seconds");
      expect(f.writes).toHaveLength(0);
      f.current = JSON.parse(
        '{"metadata":{"resourceVersion":"wire2"},"spec":{"holderIdentity":"other","renewTime":"2099-01-01T00:00:00.000002Z"}}',
      );
      yield* TestClock.adjust("14 seconds");
      expect(f.writes).toHaveLength(0);
      yield* TestClock.adjust("4 seconds");
      yield* Deferred.await(f.started);
      expect(f.writes[0]?.metadata?.resourceVersion).toBe("wire2");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(service(f.api)));
  }),
);

it.effect("standby leadership is non-gating for an otherwise ready replica", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.current = {
      metadata: { resourceVersion: "held" },
      spec: { holderIdentity: "other", renewTime: stamp() },
    };
    yield* Effect.gen(function* () {
      const readiness = yield* Readiness;
      yield* Ref.update(readiness.state, (s) => ({ ...s, ready: true, functionsSynced: true }));
      const fiber = yield* Effect.forkScoped(runLeaderElection(options, f.work));
      yield* TestClock.adjust("2 seconds");
      expect(yield* readiness.check).toEqual({ status: "ok", leader: false });
      expect((yield* gauge()).value).toBe(0);
      yield* Fiber.interrupt(fiber);
      expect(f.events).not.toContain("release");
    }).pipe(Effect.provide(service(f.api)));
  }),
);
