import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { parseSchedulerConfig } from "@krun/shared/dist/config/index.js";
import { type FunctionEntry, Functions } from "@krun/shared/dist/functions/cache.js";
import { functionResourceSchema } from "@krun/shared/dist/functions/schema.js";
import { validateFunction } from "@krun/shared/dist/functions/validation.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { DatabaseError, type NewRun, Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { BatchV1Api, CoreV1Api, type V1Job, type V1Secret } from "@kubernetes/client-node";
import { DateTime, Deferred, Duration, Effect, Fiber, Metric, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { Kube, makeKube } from "./k8s/kube.js";
import { makeMainLoop } from "./main-loop.js";

afterEach(() => vi.restoreAllMocks());
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const entry = (name = "echo", spec = {}): FunctionEntry => {
  const resource = functionResourceSchema.parse({
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: { name },
    spec: {
      image: `registry.example.invalid/echo@sha256:${"a".repeat(64)}`,
      inputSchema: {},
      ...spec,
    },
  });
  return {
    name,
    uid: name,
    generation: 1,
    resourceVersion: "1",
    spec: resource.spec,
    status: undefined,
    result: validateFunction(resource.spec, {
      maxActiveDeadline: 86400,
      maxQueued: 1000,
      allowedRegistries: [],
      allowedServiceAccounts: ["krun-job-default"],
      webhookAllowedHosts: [],
    }),
  };
};
const fixture = (
  options: {
    code?: number;
    quota?: boolean;
    markFalse?: boolean;
    complete?: boolean;
    maxRunning?: string;
    entries?: FunctionEntry[];
    stallJob?: boolean;
    beforeCount?: () => Effect.Effect<void>;
    beforeReplay?: () => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.migrate();
    const log: string[] = [];
    const secrets = new Map<string, V1Secret>();
    const jobs = new Map<string, V1Job>();
    let creates = 0;
    const ready = yield* Deferred.make<void>();
    const notices = yield* PubSub.unbounded<{
      id: string;
      kind: "state" | "status" | "job_status";
    }>();
    const functions = new Map((options.entries ?? [entry()]).map((fn) => [fn.name, fn]));
    vi.spyOn(CoreV1Api.prototype, "createNamespacedSecret").mockImplementation(async ({ body }) => {
      const name = body.metadata?.name ?? "";
      log.push("secret:" + name);
      if (secrets.has(name)) throw { code: 409, body: { reason: "AlreadyExists" } };
      secrets.set(name, body);
      return body;
    });
    vi.spyOn(CoreV1Api.prototype, "readNamespacedSecret").mockImplementation(async ({ name }) => {
      log.push("read:" + name);
      return secrets.get(name) ?? {};
    });
    vi.spyOn(CoreV1Api.prototype, "deleteNamespacedSecret").mockImplementation(async ({ name }) => {
      log.push("deleteSecret:" + name);
      secrets.delete(name);
      return {};
    });
    vi.spyOn(BatchV1Api.prototype, "deleteNamespacedJob").mockImplementation(
      async ({ name, propagationPolicy }) => {
        log.push("deleteJob:" + name + ":" + propagationPolicy);
        jobs.delete(name);
        return {};
      },
    );
    vi.spyOn(BatchV1Api.prototype, "createNamespacedJob").mockImplementation(async ({ body }) => {
      const name = body.metadata?.name ?? "";
      log.push("job:" + name);
      creates++;
      if (options.stallJob) return new Promise(() => {});
      if (options.code)
        throw {
          code: options.code,
          body: {
            reason:
              options.code === 409
                ? "AlreadyExists"
                : options.code === 403
                  ? "Forbidden"
                  : "Invalid",
            message: options.quota ? "exceeded quota: pods" : "owned API rejection",
          },
          headers: { "retry-after": "7" },
        };
      jobs.set(
        name,
        options.complete
          ? { ...body, status: { conditions: [{ type: "Complete", status: "True" }] } }
          : body,
      );
      return body;
    });
    const config = yield* parseSchedulerConfig({
      KRUN_DB_MODE: "embedded",
      KRUN_NAMESPACE: "krun-test-p43b",
      KRUN_JOBS_NAMESPACE: "krun-test-p43b-jobs",
      KRUN_MAX_RUNNING: options.maxRunning ?? "100",
    });
    const connection = yield* makeKubeConnection({
      load: (c) =>
        c.loadFromClusterAndUser(
          { name: "krun-test-p43b", server: "http://krun-test.invalid", skipTLSVerify: false },
          { name: "krun-test-p43b" },
        ),
    });
    const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
    const controlled = {
      ...store,
      countByState: () =>
        Effect.gen(function* () {
          log.push("count");
          yield* options.beforeCount?.() ?? Effect.void;
          return yield* store.countByState();
        }),
      expireQueued: (fn: string, before: DateTime.Utc) =>
        store
          .expireQueued(fn, before)
          .pipe(Effect.tap(() => Effect.sync(() => log.push("expire:" + fn)))),
      claimQueued: (...args: Parameters<typeof store.claimQueued>) =>
        store
          .claimQueued(...args)
          .pipe(Effect.tap(() => Effect.sync(() => log.push("claim:" + args[0])))),
      setJobToken: (...args: Parameters<typeof store.setJobToken>) =>
        store
          .setJobToken(...args)
          .pipe(Effect.tap(() => Effect.sync(() => log.push("token:" + args[0])))),
      releaseLease: (runId: string) =>
        store
          .releaseLease(runId)
          .pipe(Effect.tap(() => Effect.sync(() => log.push("release:" + runId)))),
      markScheduled: (runId: string) =>
        (options.markFalse ? Effect.succeed(false) : store.markScheduled(runId)).pipe(
          Effect.tap(() => Effect.sync(() => log.push("scheduled:" + runId))),
        ),
      subscribe: () => Stream.fromPubSub(notices),
    };
    const loop = yield* makeMainLoop({
      owner: "krun-test-scheduler",
      config,
      replayCached: (run) =>
        Effect.gen(function* () {
          log.push("replay:" + run.id);
          yield* options.beforeReplay?.() ?? Effect.void;
          const cached = jobs.get(`krun-${run.id}`);
          if (
            cached?.status?.conditions?.some(
              (condition) => condition.type === "Complete" && condition.status === "True",
            )
          )
            yield* store.transition(run.id, "scheduled", "succeeded", null, {});
          yield* Deferred.succeed(ready, undefined);
        }),
    }).pipe(
      Effect.provideService(Store, controlled),
      Effect.provideService(Functions, {
        get: (name) =>
          Effect.succeed(functions.get(name)?.result.ok ? functions.get(name) : undefined),
        getAny: (name) => Effect.succeed(functions.get(name)),
        list: Effect.sync(() => [...functions.values()].filter((fn) => fn.result.ok)),
        synced: Effect.void,
        isSynced: Effect.succeed(true),
      }),
      Effect.provideService(Kube, kube),
    );
    const seed = (n: number, changes: Partial<NewRun> = {}) =>
      Effect.gen(function* () {
        yield* store.createRun({
          id: id(n),
          idempotency_key: null,
          request_hash: "a".repeat(64),
          function_name: "echo",
          input: {},
          priority: 0,
          callback_url: null,
          created_by: "test-owner",
          created_at: yield* DateTime.now,
          ...changes,
        });
        return yield* store.getRun(id(n));
      });
    return {
      controlled,
      store,
      loop,
      log,
      secrets,
      jobs,
      notices,
      seed,
      ready,
      functions,
      creates: () => creates,
    };
  });
const database = <A, E, R>(program: Effect.Effect<A, E, R | Store>) =>
  program.pipe(Effect.provide(StoreSqlite(":memory:")));

it.effect(
  "counts and expires before capacity-aware claims; token precedes Job and scheduled replay",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ maxRunning: "1" });
        yield* f.seed(1);
        yield* f.seed(2);
        yield* f.loop.iterate;
        expect(f.log.slice(0, 3)).toEqual(["count", "expire:echo", "claim:echo"]);
        expect(f.log.indexOf("token:" + id(1))).toBeLessThan(f.log.indexOf("job:krun-" + id(1)));
        expect((yield* f.store.getRun(id(1))).state).toBe("scheduled");
        expect((yield* f.store.getRun(id(2))).state).toBe("queued");
        expect(f.creates()).toBe(1);
      }),
    ),
);

it.effect("adopts an existing Secret token and AlreadyExists Job before markScheduled", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ code: 409 });
      yield* f.seed(1);
      const token = randomBytes(32).toString("base64url");
      f.secrets.set("krun-" + id(1), { data: { token: Buffer.from(token).toString("base64") } });
      yield* f.loop.iterate;
      const stored = yield* f.store.getRun(id(1));
      expect(stored.state).toBe("scheduled");
      expect(stored.job_token_hash === createHash("sha256").update(token).digest("hex")).toBe(true);
      expect(f.log).toContain("read:krun-" + id(1));
    }),
  ),
);

for (const code of [403, 503])
  it.effect(`transient ${code} releases claims and backs off the function`, () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ code, quota: code === 403 });
        yield* f.seed(1);
        yield* f.seed(2);
        const counter = Metric.withAttributes(
          Metric.counter("krun_job_create_errors_total", { incremental: true }),
          { function: "echo", code: String(code) },
        );
        const before = (yield* Metric.value(counter)).count;
        yield* f.loop.iterate;
        expect((yield* Metric.value(counter)).count).toBe(before + 1);
        const first = yield* f.store.getRun(id(1)),
          second = yield* f.store.getRun(id(2));
        expect(first.state).toBe("queued");
        expect(first.lease_owner).toBeNull();
        expect(second.lease_owner).toBeNull();
        expect(f.creates()).toBe(1);
        yield* f.loop.iterate;
        expect(f.creates()).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* f.loop.iterate;
        expect(f.creates()).toBe(2);
      }),
    ),
  );

it.effect("422 permanently fails the run with exact krun error and deletes its Secret", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ code: 422 });
      yield* f.seed(1);
      yield* f.loop.iterate;
      const stored = yield* f.store.getRun(id(1));
      expect(stored.state).toBe("failed");
      expect(stored.failure_reason).toBe("job_create_failed");
      expect(stored.error).toEqual({
        source: "krun",
        message: "owned API rejection",
        details: { code: 422, reason: "Invalid" },
      });
      expect(f.secrets.size).toBe(0);
    }),
  ),
);

it.effect("false markScheduled deletes Job foreground then Secret", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ markFalse: true });
      yield* f.seed(1);
      yield* f.loop.iterate;
      expect(f.log.indexOf("deleteJob:krun-" + id(1) + ":Foreground")).toBeLessThan(
        f.log.indexOf("deleteSecret:krun-" + id(1)),
      );
      expect(f.secrets.size).toBe(0);
      expect((yield* f.store.getRun(id(1))).lease_owner).toBeNull();
    }),
  ),
);

it.effect("Complete cached before markScheduled is replayed and transitions to succeeded", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ complete: true });
      yield* f.seed(1);
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(1))).state).toBe("succeeded");
      expect(f.log.indexOf("scheduled:" + id(1))).toBeLessThan(f.log.indexOf("replay:" + id(1)));
    }),
  ),
);

it.effect(
  "deleted Function queued run expires after default hour and cleans persisted-token resources",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        yield* f.seed(1, { function_name: "deleted" });
        yield* f.store.setJobToken(id(1), "krun-" + id(1), "a".repeat(64));
        yield* TestClock.adjust("3600001 millis");
        yield* f.loop.iterate;
        const stored = yield* f.store.getRun(id(1));
        expect(stored.failure_reason).toBe("queue_timeout");
        expect(f.log).toContain("deleteJob:krun-" + id(1) + ":Foreground");
        expect(f.log).toContain("deleteSecret:krun-" + id(1));
        expect(f.log.some((s) => s.startsWith("claim:"))).toBe(false);
      }),
    ),
);

it.effect("iteration deadline interrupts create and releases every unfinished claim", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ stallJob: true });
      yield* f.seed(1);
      yield* f.seed(2);
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (f.creates() === 0) yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      for (const n of [1, 2]) expect((yield* f.store.getRun(id(n))).lease_owner).toBeNull();
      expect(f.creates()).toBe(1);
    }),
  ),
);

it.effect("429 releases all leases before Retry-After pause outside iteration deadline", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ code: 429 });
      yield* f.seed(1);
      yield* f.seed(2);
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      yield* TestClock.adjust("1 millis");
      while (!f.log.includes("release:" + id(2))) yield* Effect.yieldNow;
      for (const n of [1, 2]) expect((yield* f.store.getRun(id(n))).lease_owner).toBeNull();
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("7 seconds");
      yield* Fiber.join(fiber);
      expect(f.creates()).toBe(1);
    }),
  ),
);

it.effect(
  "two state notifies during a running iteration coalesce; other notifies ignored; ticker and scope owned",
  () =>
    database(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        let active = 0,
          maximum = 0,
          calls = 0;
        const f = yield* fixture({
          entries: [],
          beforeCount: () =>
            Effect.gen(function* () {
              active++;
              maximum = Math.max(maximum, active);
              calls++;
              if (calls === 1) yield* Deferred.await(gate);
              active--;
            }),
        });
        const fiber = yield* Effect.forkScoped(f.loop.run);
        while (calls === 0) yield* Effect.yieldNow;
        yield* PubSub.publish(f.notices, { id: id(1), kind: "state" as const });
        yield* PubSub.publish(f.notices, { id: id(2), kind: "state" as const });
        yield* PubSub.publish(f.notices, { id: id(3), kind: "status" as const });
        yield* PubSub.publish(f.notices, { id: id(4), kind: "job_status" as const });
        for (let n = 0; n < 10; n++) yield* Effect.yieldNow;
        expect(calls).toBe(1);
        yield* Deferred.succeed(gate, undefined);
        while (calls < 2) yield* Effect.yieldNow;
        for (let n = 0; n < 10; n++) yield* Effect.yieldNow;
        expect(calls).toBe(2);
        expect(maximum).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(calls).toBe(3);
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("2 seconds");
        expect(calls).toBe(3);
      }),
    ),
);

it.effect(
  "expiry cleanup survives a transient delete error and retries without another queued row",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        yield* f.seed(1, { function_name: "deleted" });
        yield* f.store.setJobToken(id(1), `krun-${id(1)}`, "a".repeat(64));
        f.secrets.set(`krun-${id(1)}`, {});
        vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockRejectedValueOnce({ code: 503 });
        yield* TestClock.adjust("3600001 millis");
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(1))).state).toBe("failed");
        expect(f.secrets.size).toBe(1);
        yield* f.loop.iterate;
        expect(f.secrets.size).toBe(0);
        expect(f.log).toContain(`deleteJob:krun-${id(1)}:Foreground`);
      }),
    ),
);

it.effect("429 on expiry cleanup pauses without counting a create failure", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [] });
      yield* f.seed(1, { function_name: "deleted" });
      yield* f.store.setJobToken(id(1), `krun-${id(1)}`, "a".repeat(64));
      vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockRejectedValueOnce({
        code: 429,
        headers: { "retry-after": "7" },
      });
      yield* TestClock.adjust("3600001 millis");
      const metric = Metric.withAttributes(
        Metric.counter("krun_job_create_errors_total", { incremental: true }),
        { function: "deleted", code: "429" },
      );
      const before = (yield* Metric.value(metric)).count;
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length === 0)
        yield* Effect.yieldNow;
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("6 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect((yield* Metric.value(metric)).count).toBe(before);
    }),
  ),
);

it.effect("completed claim result is registered before pending deadline interruption", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      yield* f.seed(2);
      // A Store write may settle after cancellation was requested; never lose its returned claims.
      const claim = f.controlled.claimQueued;
      f.controlled.claimQueued = (...args) =>
        claim(...args).pipe(Effect.tap(() => Effect.sleep("11 seconds")));
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (!f.log.includes("claim:echo")) yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(f.creates()).toBe(0);
      for (const n of [1, 2]) expect((yield* f.store.getRun(id(n))).lease_owner).toBeNull();
    }),
  ),
);

it.effect("invalid cached Function retains its parsed queue timeout but never claims", () =>
  database(
    Effect.gen(function* () {
      const fn = {
        ...entry(),
        result: {
          ok: false as const,
          reason: "SchemaInvalid" as const,
          message: "invalid",
          queueTimeout: Duration.minutes(1),
        },
      };
      const f = yield* fixture({ entries: [fn] });
      yield* f.seed(1);
      yield* TestClock.adjust("60001 millis");
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(1))).failure_reason).toBe("queue_timeout");
      expect(f.log.some((value) => value.startsWith("claim:"))).toBe(false);
    }),
  ),
);

it.effect("Secret create 422 fails without storing a token or attempting a Job", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      vi.mocked(CoreV1Api.prototype.createNamespacedSecret).mockRejectedValueOnce({
        code: 422,
        body: { message: "owned secret rejected", reason: "Invalid" },
      });
      yield* f.loop.iterate;
      const run = yield* f.store.getRun(id(1));
      expect(run.failure_reason).toBe("job_create_failed");
      expect(run.job_token_hash).toBeNull();
      expect(f.creates()).toBe(0);
    }),
  ),
);

it.effect(
  "corrupt existing Secret fails closed without hashing a replacement or creating a Job",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        f.secrets.set(`krun-${id(1)}`, { data: { token: "not-base64!" } });
        yield* f.loop.iterate;
        const run = yield* f.store.getRun(id(1));
        expect(run.state).toBe("queued");
        expect(run.job_token_hash).toBeNull();
        expect(run.lease_owner).toBeNull();
        expect(f.creates()).toBe(0);
      }),
    ),
);

it.effect(
  "per-function and global scheduled/running capacity reserve claims across all Ready functions",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({
          maxRunning: "3",
          entries: [entry("echo", { maxConcurrency: 1 }), entry("other", { maxConcurrency: 2 })],
        });
        yield* f.seed(1);
        yield* f.store.markScheduled(id(1));
        yield* f.seed(2, { function_name: "other" });
        yield* f.store.markScheduled(id(2));
        yield* f.store.transition(id(2), "scheduled", "running", null, {});
        yield* f.seed(3);
        yield* f.seed(4, { function_name: "other" });
        yield* f.seed(5, { function_name: "other" });
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(3))).state).toBe("queued");
        expect((yield* f.store.getRun(id(4))).state).toBe("scheduled");
        expect((yield* f.store.getRun(id(5))).state).toBe("queued");
        expect(f.creates()).toBe(1);
      }),
    ),
);

it.effect("leader-scope interruption aborts current create and releases all claimed runs", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ stallJob: true });
      yield* f.seed(1);
      yield* f.seed(2);
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (f.creates() === 0) yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      for (const n of [1, 2]) expect((yield* f.store.getRun(id(n))).lease_owner).toBeNull();
    }),
  ),
);

it.effect(
  "AlreadyExists on Secret read is not successful adoption and cannot skip hash/Job creation",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        f.secrets.set(`krun-${id(1)}`, {});
        vi.mocked(CoreV1Api.prototype.readNamespacedSecret).mockRejectedValueOnce({
          code: 409,
          body: { reason: "AlreadyExists" },
        });
        yield* f.loop.iterate;
        const run = yield* f.store.getRun(id(1));
        expect(run.state).toBe("queued");
        expect(run.job_token_hash).toBeNull();
        expect(run.lease_owner).toBeNull();
        expect(f.creates()).toBe(0);
      }),
    ),
);

it.effect(
  "late successful scheduling settlement retains cached replay for the next iteration",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ complete: true });
        yield* f.seed(71);
        const mark = f.controlled.markScheduled;
        f.controlled.markScheduled = (runId) =>
          mark(runId).pipe(Effect.tap(() => Effect.sleep("11 seconds")));
        const fiber = yield* Effect.forkScoped(f.loop.iterate);
        while (!f.log.includes("scheduled:" + id(71))) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect((yield* f.store.getRun(id(71))).state).toBe("scheduled");
        yield* f.loop.iterate;
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(71))).state).toBe("succeeded");
        expect(f.log.filter((value) => value === "replay:" + id(71))).toHaveLength(1);
        expect(f.creates()).toBe(1);
        expect(f.log.some((value) => value.startsWith("deleteJob:"))).toBe(false);
      }),
    ),
);

it.effect("interrupted cached replay remains owned until a later replay completes", () =>
  database(
    Effect.gen(function* () {
      let attempts = 0;
      const f = yield* fixture({
        complete: true,
        beforeReplay: () => (++attempts === 1 ? Effect.never : Effect.void),
      });
      yield* f.seed(72);
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (attempts === 0) yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      expect((yield* f.store.getRun(id(72))).state).toBe("scheduled");
      yield* f.loop.iterate;
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(72))).state).toBe("succeeded");
      expect(attempts).toBe(2);
    }),
  ),
);

it.effect(
  "leader interruption during late successful scheduling never starts replay in teardown",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ complete: true });
        yield* f.seed(73);
        const mark = f.controlled.markScheduled;
        f.controlled.markScheduled = (runId) =>
          mark(runId).pipe(Effect.tap(() => Effect.sleep("11 seconds")));
        const fiber = yield* Effect.forkScoped(f.loop.run);
        while (!f.log.includes("scheduled:" + id(73))) yield* Effect.yieldNow;
        const stop = yield* Effect.forkScoped(Fiber.interrupt(fiber));
        yield* TestClock.adjust("11 seconds");
        yield* Fiber.join(stop);
        expect((yield* f.store.getRun(id(73))).state).toBe("scheduled");
        expect(f.log.includes("replay:" + id(73))).toBe(false);
        expect(f.log.some((value) => value.startsWith("deleteJob:"))).toBe(false);
      }),
    ),
);

it.effect("adoption GET429 releases every claim and pauses without a create-error count", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(74);
      yield* f.seed(75);
      const token = randomBytes(32).toString("base64url");
      f.secrets.set(`krun-${id(74)}`, { data: { token: Buffer.from(token).toString("base64") } });
      vi.mocked(CoreV1Api.prototype.readNamespacedSecret).mockRejectedValueOnce({
        code: 429,
        headers: { "retry-after": "7" },
      });
      const counter = Metric.withAttributes(
        Metric.counter("krun_job_create_errors_total", { incremental: true }),
        { function: "echo", code: "429" },
      );
      const before = (yield* Metric.value(counter)).count;
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (!f.log.includes("release:" + id(75))) yield* Effect.yieldNow;
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow;
      for (const n of [74, 75]) expect((yield* f.store.getRun(id(n))).lease_owner).toBeNull();
      expect(f.creates()).toBe(0);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("7 seconds");
      yield* Fiber.join(fiber);
      expect((yield* Metric.value(counter)).count).toBe(before);
    }),
  ),
);

it.effect(
  "adoption GET503 does not count or back off creation and a following attempt can adopt",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(76);
        const token = randomBytes(32).toString("base64url");
        f.secrets.set(`krun-${id(76)}`, { data: { token: Buffer.from(token).toString("base64") } });
        vi.mocked(CoreV1Api.prototype.readNamespacedSecret).mockRejectedValueOnce({ code: 503 });
        const counter = Metric.withAttributes(
          Metric.counter("krun_job_create_errors_total", { incremental: true }),
          { function: "echo", code: "503" },
        );
        const before = (yield* Metric.value(counter)).count;
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(76))).lease_owner).toBeNull();
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(76))).state).toBe("scheduled");
        expect((yield* Metric.value(counter)).count).toBe(before);
        expect(f.creates()).toBe(1);
      }),
    ),
);

for (const present of [false, true])
  it.effect(
    `cancelling with ${present ? "a present" : "an absent"} Job deletes before the terminal CAS`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* fixture(present ? {} : { entries: [] });
          yield* f.seed(81);
          if (present) {
            yield* f.loop.iterate;
            expect(f.jobs.size).toBe(1);
          }
          yield* f.store.transition(
            id(81),
            present ? "scheduled" : "queued",
            "cancelling",
            null,
            {},
          );
          const transition = f.controlled.transition;
          f.controlled.transition = (...args) =>
            transition(...args).pipe(
              Effect.tap(() => Effect.sync(() => f.log.push("cancelled:" + args[0]))),
            );
          if (!present) {
            vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockImplementationOnce(
              async ({ name, propagationPolicy }) => {
                f.log.push(`deleteJob:${name}:${propagationPolicy}`);
                throw { code: 404 };
              },
            );
            vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mockImplementationOnce(
              async ({ name }) => {
                f.log.push(`deleteSecret:${name}`);
                throw { code: 404 };
              },
            );
          }
          yield* f.loop.iterate;
          const run = yield* f.store.getRun(id(81));
          expect(run.state).toBe("cancelled");
          expect(run.finished_at).not.toBeNull();
          const job = f.log.indexOf(`deleteJob:krun-${id(81)}:Foreground`),
            secret = f.log.indexOf(`deleteSecret:krun-${id(81)}`),
            terminal = f.log.indexOf("cancelled:" + id(81));
          expect(job).toBeGreaterThan(-1);
          expect(job).toBeLessThan(secret);
          expect(secret).toBeLessThan(terminal);
          expect(f.jobs.size).toBe(0);
          expect(f.secrets.size).toBe(0);
          const deletes = vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length;
          yield* f.loop.iterate;
          expect(vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length).toBe(
            deletes,
          );
        }),
      ),
  );

it.effect(
  "cancelling a running run preserves reported data and inserts one terminal delivery",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(82, { callback_url: "https://callback.example.invalid/done" });
        yield* f.loop.iterate;
        yield* f.store.transition(id(82), "scheduled", "running", null, {});
        yield* f.store.setResult(id(82), { owned: "kept" });
        yield* f.store.setError(id(82), { source: "function", message: "owned report" });
        yield* f.store.transition(id(82), "running", "cancelling", null, {});
        yield* f.loop.iterate;
        yield* f.loop.iterate;
        const run = yield* f.store.getRun(id(82));
        expect(run.state).toBe("cancelled");
        expect(run.result).toEqual({ owned: "kept" });
        expect(run.error?.source).toBe("function");
        const deliveries = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.payload).toMatchObject({ state: "CANCELLED" });
      }),
    ),
);

it.effect(
  "cancelling Job-delete503 leaves state unchanged and retries before deleting Secret",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(83);
        yield* f.loop.iterate;
        yield* f.store.transition(id(83), "scheduled", "cancelling", null, {});
        vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockRejectedValueOnce({ code: 503 });
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(83))).state).toBe("cancelling");
        expect(f.secrets.size).toBe(1);
        expect(vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mock.calls).toHaveLength(0);
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(83))).state).toBe("cancelled");
      }),
    ),
);

it.effect(
  "cancelling Secret-delete503 retries idempotent Job deletion without premature transition",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(84);
        yield* f.loop.iterate;
        yield* f.store.transition(id(84), "scheduled", "cancelling", null, {});
        vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mockRejectedValueOnce({ code: 503 });
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(84))).state).toBe("cancelling");
        expect(f.jobs.size).toBe(0);
        expect(f.secrets.size).toBe(1);
        vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockRejectedValueOnce({ code: 404 });
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(84))).state).toBe("cancelled");
        expect(f.secrets.size).toBe(0);
      }),
    ),
);

it.effect("cancelling delete429 pauses without counting a failed creation", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [] });
      yield* f.seed(85);
      yield* f.store.transition(id(85), "queued", "cancelling", null, {});
      vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockRejectedValueOnce({
        code: 429,
        headers: { "retry-after": "7" },
      });
      const counter = Metric.withAttributes(
        Metric.counter("krun_job_create_errors_total", { incremental: true }),
        { function: "echo", code: "429" },
      );
      const before = (yield* Metric.value(counter)).count;
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length === 0)
        yield* Effect.yieldNow;
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow;
      expect((yield* f.store.getRun(id(85))).state).toBe("cancelling");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("7 seconds");
      yield* Fiber.join(fiber);
      expect((yield* Metric.value(counter)).count).toBe(before);
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(85))).state).toBe("cancelled");
    }),
  ),
);

it.effect(
  "cancelling delete deadline leaves unfinished rows retryable without starting later resources",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        for (const n of [86, 87]) {
          yield* f.seed(n);
          yield* f.store.transition(id(n), "queued", "cancelling", null, {});
        }
        vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockImplementationOnce(
          () => new Promise(() => {}),
        );
        const fiber = yield* Effect.forkScoped(f.loop.iterate);
        while (vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length === 0)
          yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        for (const n of [86, 87]) expect((yield* f.store.getRun(id(n))).state).toBe("cancelling");
        expect(vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mock.calls).toHaveLength(0);
        yield* f.loop.iterate;
        for (const n of [86, 87]) expect((yield* f.store.getRun(id(n))).state).toBe("cancelled");
      }),
    ),
);

it.effect("cancelling terminal CAS does not duplicate a competing terminal delivery", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [] });
      yield* f.seed(88, { callback_url: "https://callback.example.invalid/done" });
      yield* f.store.transition(id(88), "queued", "cancelling", null, {});
      const transition = f.controlled.transition;
      f.controlled.transition = (...args) =>
        Effect.gen(function* () {
          if (args[1] === "cancelling" && args[2] === "cancelled")
            yield* f.store.transition(args[0], "cancelling", "cancelled", null, {});
          return yield* transition(...args);
        });
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(88))).state).toBe("cancelled");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect(
  "cancelling drains more rows than the global running cap using bounded Store batches",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [], maxRunning: "1" });
        for (const n of [89, 90]) {
          yield* f.seed(n);
          yield* f.store.transition(id(n), "queued", "cancelling", null, {});
        }
        const list = f.controlled.listByState,
          limits: number[] = [];
        f.controlled.listByState = (states, limit) => {
          limits.push(limit);
          return list(states, limit);
        };
        yield* f.loop.iterate;
        for (const n of [89, 90]) expect((yield* f.store.getRun(id(n))).state).toBe("cancelled");
        expect(limits).toEqual([1, 1, 1]);
      }),
    ),
);

for (const resource of ["job", "secret"] as const)
  it.effect(
    `cancelling repair: blocked ${resource} cancellation does not starve unrelated cancelling runs`,
    () =>
      database(
        Effect.gen(function* () {
          const f = yield* fixture({ entries: [], maxRunning: "1" });
          for (const n of [301, 302]) {
            yield* f.seed(n);
            yield* f.store.setJobToken(id(n), "krun-" + id(n), "a".repeat(64));
            yield* f.store.transition(id(n), "queued", "cancelling", null, {});
            f.jobs.set("krun-" + id(n), {});
            f.secrets.set("krun-" + id(n), {});
          }
          const attempts: string[] = [];
          if (resource === "job")
            vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockImplementation(
              async ({ name }) => {
                attempts.push(name);
                if (name === "krun-" + id(301))
                  throw {
                    code: 403,
                    body: { reason: "Forbidden", message: "owned resource-specific delete denial" },
                  };
                f.jobs.delete(name);
                return {};
              },
            );
          else
            vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mockImplementation(
              async ({ name }) => {
                attempts.push(name);
                if (name === "krun-" + id(301))
                  throw {
                    code: 403,
                    body: { reason: "Forbidden", message: "owned resource-specific delete denial" },
                  };
                f.secrets.delete(name);
                return {};
              },
            );
          for (let n = 0; n < 3; n++) yield* f.loop.iterate;
          const blocked = (yield* f.store.getRun(id(301))).state,
            healthy = (yield* f.store.getRun(id(302))).state;
          expect(attempts.filter((name) => name === `krun-${id(301)}`)).toHaveLength(3);
          expect(attempts.filter((name) => name === `krun-${id(302)}`)).toHaveLength(1);
          expect(f.jobs.has(`krun-${id(302)}`)).toBe(false);
          expect(f.secrets.has(`krun-${id(302)}`)).toBe(false);
          expect(blocked).toBe("cancelling");
          expect(healthy).toBe("cancelled");
        }),
      ),
  );
it.effect(
  "cancelling repair: interrupted Secret delete leaves cancellation retryable without terminal CAS",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        yield* f.seed(311);
        yield* f.store.transition(id(311), "queued", "cancelling", null, {});
        vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mockImplementationOnce(
          () => new Promise(() => {}),
        );
        const fiber = yield* Effect.forkScoped(f.loop.iterate);
        while (vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mock.calls.length === 0)
          yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        expect((yield* f.store.getRun(id(311))).state).toBe("cancelling");
        yield* f.loop.iterate;
        expect((yield* f.store.getRun(id(311))).state).toBe("cancelled");
      }),
    ),
);
it.effect(
  "cancelling repair: late successful cancellation CAS settles once and never repeats deletes",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        yield* f.seed(312, { callback_url: "https://callback.example.invalid/review" });
        yield* f.store.transition(id(312), "queued", "cancelling", null, {});
        const transition = f.controlled.transition;
        let committed = false;
        f.controlled.transition = (...args) =>
          transition(...args).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed = true;
              }),
            ),
            Effect.tap(() => Effect.sleep("11 seconds")),
            Effect.uninterruptible,
          );
        const fiber = yield* Effect.forkScoped(f.loop.iterate);
        while (!committed) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect((yield* f.store.getRun(id(312))).state).toBe("cancelled");
        const count = vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length;
        yield* f.loop.iterate;
        expect(vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length).toBe(count);
        expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
      }),
    ),
);
it.effect(
  "cancelling repair: cancellation CAS preserves a competing failed terminal state and delivery",
  () =>
    database(
      Effect.gen(function* () {
        const f = yield* fixture({ entries: [] });
        yield* f.seed(313, { callback_url: "https://callback.example.invalid/review" });
        yield* f.store.transition(id(313), "queued", "cancelling", null, {});
        const transition = f.controlled.transition;
        f.controlled.transition = (...args) =>
          Effect.gen(function* () {
            if (args[1] === "cancelling" && args[2] === "cancelled")
              yield* f.store.transition(args[0], "cancelling", "failed", "heartbeat_timeout", {
                error: { source: "krun", message: "owned competing terminal" },
              });
            return yield* transition(...args);
          });
        yield* f.loop.iterate;
        const row = yield* f.store.getRun(id(313));
        expect(row.state).toBe("failed");
        expect(row.failure_reason).toBe("heartbeat_timeout");
        expect(row.error?.message).toBe("owned competing terminal");
        const deliveries = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.payload).toMatchObject({ state: "FAILED" });
      }),
    ),
);

it.effect("cancelling repair: terminal Store failure cannot starve a healthy row", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [], maxRunning: "1" });
      for (const n of [321, 322]) {
        yield* f.seed(n, { callback_url: "https://callback.example.invalid/repair" });
        yield* f.store.transition(id(n), "queued", "cancelling", null, {});
      }
      const transition = f.controlled.transition;
      let blocked = true;
      let attempts = 0;
      f.controlled.transition = (...args) =>
        args[0] === id(321) && blocked
          ? Effect.sync(() => {
              attempts++;
            }).pipe(Effect.andThen(Effect.fail(new DatabaseError({ operation: "transition" }))))
          : transition(...args);
      yield* f.loop.iterate;
      expect(attempts).toBe(1);
      expect((yield* f.store.getRun(id(321))).state).toBe("cancelling");
      expect((yield* f.store.getRun(id(322))).state).toBe("cancelled");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
      blocked = false;
      yield* f.loop.iterate;
      expect((yield* f.store.getRun(id(321))).state).toBe("cancelled");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect("cancelling repair: bounded cursor pages survive repeated iteration deadlines", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [], maxRunning: "1" });
      for (const n of [331, 332, 333, 334]) {
        yield* f.seed(n, { callback_url: "https://callback.example.invalid/repair" });
        yield* f.store.transition(id(n), "queued", "cancelling", null, {});
      }
      vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockImplementation(async ({ name }) => {
        if (name === `krun-${id(331)}`) throw { code: 503 };
        return {};
      });
      const listRuns = f.controlled.listRuns;
      const cursors: (string | null)[] = [];
      f.controlled.listRuns = (...args) =>
        listRuns(...args).pipe(
          Effect.tap((page) =>
            Effect.sync(() => {
              expect(args[2]).toBe(1);
              expect(page.runs.length).toBeLessThanOrEqual(1);
              cursors.push(args[1]);
            }),
          ),
          Effect.tap(() => Effect.sleep("11 seconds")),
          Effect.uninterruptible,
        );
      for (let n = 0; n < 5; n++) {
        const before = cursors.length;
        const fiber = yield* Effect.forkScoped(f.loop.iterate);
        while (cursors.length === before && fiber.pollUnsafe() === undefined)
          yield* Effect.yieldNow;
        if (cursors.length > before) yield* TestClock.adjust("11 seconds");
        yield* Fiber.join(fiber);
      }
      expect(cursors).toHaveLength(4);
      expect(cursors[0]).toBeNull();
      expect(cursors.slice(1).every((cursor) => cursor !== null)).toBe(true);
      expect(new Set(cursors).size).toBe(4);
      expect((yield* f.store.getRun(id(331))).state).toBe("cancelling");
      for (const n of [332, 333, 334])
        expect((yield* f.store.getRun(id(n))).state).toBe("cancelled");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(3);
    }),
  ),
);

it.effect("cancelling repair: fallback429 stops traversal for the global pause", () =>
  database(
    Effect.gen(function* () {
      const f = yield* fixture({ entries: [], maxRunning: "1" });
      for (const n of [341, 342, 343]) {
        yield* f.seed(n);
        yield* f.store.transition(id(n), "queued", "cancelling", null, {});
      }
      let limited = true;
      vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mockImplementation(async ({ name }) => {
        if (name === `krun-${id(341)}`) throw { code: 503 };
        if (limited) throw { code: 429, headers: { "retry-after": "7" } };
        return {};
      });
      const fiber = yield* Effect.forkScoped(f.loop.iterate);
      while (vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls.length < 2)
        yield* Effect.yieldNow;
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(vi.mocked(BatchV1Api.prototype.deleteNamespacedJob).mock.calls).toHaveLength(2);
      expect(vi.mocked(CoreV1Api.prototype.deleteNamespacedSecret).mock.calls).toHaveLength(0);
      yield* TestClock.adjust("7 seconds");
      yield* Fiber.join(fiber);
      limited = false;
      yield* f.loop.iterate;
      yield* f.loop.iterate;
      for (const n of [342, 343]) expect((yield* f.store.getRun(id(n))).state).toBe("cancelled");
      expect((yield* f.store.getRun(id(341))).state).toBe("cancelling");
    }),
  ),
);
