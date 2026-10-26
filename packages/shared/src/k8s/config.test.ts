import { expect, it } from "@effect/vitest";
import type { KubeConfig } from "@kubernetes/client-node";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeKubeConnection } from "./config.js";

const load = (config: KubeConfig) =>
  config.loadFromClusterAndUser(
    { name: "krun-test-p2-3", server: "https://krun-test.invalid", skipTLSVerify: false },
    { name: "krun-test-p2-3" },
  );
const waitFor = (test: () => boolean) =>
  Effect.gen(function* () {
    while (!test()) yield* Effect.yieldNow;
  });

it.effect("default semaphore bounds acquisition to eight and releases every permit", () =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({ load });
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = () =>
      connection.call(async () => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          await gate;
          return 1;
        } finally {
          active--;
        }
      });
    const fibers = yield* Effect.forEach(Array.from({ length: 12 }), () =>
      Effect.forkChild(request()),
    );
    yield* waitFor(() => active === 8);
    expect(maximum).toBe(8);
    release();
    expect((yield* Effect.forEach(fibers, Fiber.join)).length).toBe(12);
    expect(maximum).toBe(8);
    expect(active).toBe(0);
  }),
);

it.effect("ten-second deadline aborts the real request signal and restores the semaphore", () =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({ load, concurrency: 1 });
    let started = false;
    let aborted = false;
    const fiber = yield* Effect.forkChild(
      Effect.exit(
        connection.call(
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              started = true;
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("krun-test-only-abort"));
                },
                { once: true },
              );
            }),
        ),
      ),
    );
    yield* waitFor(() => started);
    yield* TestClock.adjust("9999 millis");
    expect(aborted).toBe(false);
    yield* TestClock.adjust("1 millis");
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain('"reason":"timeout"');
    expect(aborted).toBe(true);
    expect(yield* connection.call(async () => "recovered")).toBe("recovered");
  }),
);

it.effect("interruption aborts the signal; request errors retain only allowed status data", () =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({ load, concurrency: 1 });
    let started = false;
    let aborted = false;
    const fiber = yield* Effect.forkChild(
      connection.call(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            started = true;
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("krun-test-only-abort"));
              },
              { once: true },
            );
          }),
      ),
    );
    yield* waitFor(() => started);
    yield* Fiber.interrupt(fiber);
    expect(aborted).toBe(true);
    const result = yield* Effect.exit(
      connection.call(async () => {
        throw {
          code: 403,
          body: "krun-test-private",
          headers: { diagnostic: "krun-test-private" },
        };
      }),
    );
    expect(JSON.stringify(result)).toContain('"status":403');
    expect(JSON.stringify(result)).not.toContain("krun-test-private");
    expect(yield* connection.call(async () => "recovered")).toBe("recovered");
  }),
);

it.effect("invalid concurrency and loader failures are typed, bounded configuration errors", () =>
  Effect.gen(function* () {
    for (const concurrency of [0, -1, Number.NaN, 1.5]) {
      const result = yield* Effect.exit(makeKubeConnection({ load, concurrency }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).toContain("KubeConfigError");
    }
    const result = yield* Effect.exit(
      makeKubeConnection({
        load: () => {
          throw new Error("krun-test-private");
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("krun-test-private");
  }),
);

it.effect("permit wait consumes the same deadline as subsequent execution", () =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({ concurrency: 1, load });
    let starts = 0;
    const request = () => {
      starts++;
      return new Promise<never>(() => {});
    };
    const owner = yield* Effect.forkScoped(Effect.flip(connection.call(request)));
    yield* TestClock.adjust("4 seconds");
    const queued = yield* Effect.forkScoped(Effect.flip(connection.call(request)));
    yield* TestClock.adjust("6 seconds");
    expect(yield* Fiber.join(owner)).toMatchObject({ reason: "timeout" });
    expect(starts).toBe(2);
    yield* TestClock.adjust("3999 millis");
    expect(queued.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 millis");
    expect(queued.pollUnsafe()).toBeDefined();
    expect(yield* Fiber.join(queued)).toMatchObject({ reason: "timeout" });
  }),
);
