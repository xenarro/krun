import { expect, it } from "@effect/vitest";
import { kubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { Cause, DateTime, Effect, Fiber, Metric } from "effect";
import { TestClock } from "effect/testing";
import { makeCreationPolicy } from "./create-policy.js";

const apiError = (
  code: number,
  reason: string,
  message = "Rejected by admission",
  retryAfter?: string,
) =>
  kubeApiError({
    code,
    body: { reason, message },
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });

it.effect(
  "503 is transient with per-function exponential backoff capped at 60 and reset on success",
  () =>
    Effect.gen(function* () {
      const policy = yield* makeCreationPolicy;
      for (const seconds of [1, 2, 4, 8, 16, 32, 60, 60]) {
        const decision = yield* policy.failed("worker", apiError(503, "ServiceUnavailable"));
        expect(decision).toMatchObject({ kind: "transient", backoffSeconds: seconds });
        expect(yield* policy.isBackingOff("worker")).toBe(true);
        expect(yield* policy.isBackingOff("other")).toBe(false);
        yield* TestClock.adjust(seconds * 1000);
        expect(yield* policy.isBackingOff("worker")).toBe(false);
      }
      yield* policy.succeeded("worker");
      expect(yield* policy.failed("worker", apiError(503, "ServiceUnavailable"))).toMatchObject({
        backoffSeconds: 1,
      });
    }),
);

it.effect(
  "422 is permanent with exact krun job_create_failed Status projection, not library diagnostics",
  () =>
    Effect.gen(function* () {
      const policy = yield* makeCreationPolicy;
      const error = apiError(422, "Invalid", "Job violates admission");
      expect(JSON.stringify(error)).not.toContain("Job violates admission");
      expect(yield* policy.failed("worker", error)).toEqual({
        kind: "permanent",
        failureReason: "job_create_failed",
        error: {
          source: "krun",
          message: "Job violates admission",
          details: { code: 422, reason: "Invalid" },
        },
      });
      expect(yield* policy.isBackingOff("worker")).toBe(false);
    }),
);

it.effect(
  "quota 403 is transient while RBAC 403 is permanent and counters carry only function/code",
  () =>
    Effect.gen(function* () {
      const policy = yield* makeCreationPolicy;
      expect(
        yield* policy.failed("quota-worker", apiError(403, "Forbidden", "exceeded quota: jobs")),
      ).toMatchObject({ kind: "transient", quota: true });
      expect(
        yield* policy.failed("rbac-worker", apiError(403, "Forbidden", "cannot create jobs")),
      ).toMatchObject({ kind: "permanent" });
      expect(
        (yield* Metric.value(
          Metric.withAttributes(
            Metric.counter("krun_quota_rejections_total", { incremental: true }),
            { function: "quota-worker" },
          ),
        )).count,
      ).toBe(1);
      expect(
        (yield* Metric.value(
          Metric.withAttributes(
            Metric.counter("krun_job_create_errors_total", { incremental: true }),
            { function: "rbac-worker", code: "403" },
          ),
        )).count,
      ).toBe(1);
    }),
);

for (const [header, seconds] of [
  [undefined, 1],
  ["7", 7],
  ["999", 60],
  ["0", 0],
  ["invalid", 1],
  ["-3", 1],
  ["Thu, 01 Jan 1970 00:00:09 GMT", 9],
] as const)
  it.effect(`429 honors Retry-After ${String(header)} without retaining a request permit`, () =>
    Effect.gen(function* () {
      const policy = yield* makeCreationPolicy;
      const decision = yield* policy.failed(
        "worker",
        apiError(429, "TooManyRequests", "rate limited", header),
      );
      expect(decision).toMatchObject({ kind: "transient", pauseSeconds: seconds });
      let completed = false;
      const fiber = yield* Effect.forkChild(
        policy.pause(decision).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
      );
      if (seconds > 0) {
        yield* TestClock.adjust(seconds * 1000 - 1);
        expect(completed).toBe(false);
        yield* TestClock.adjust(1);
      }
      yield* Fiber.join(fiber);
      expect(completed).toBe(true);
    }),
  );

it.effect("AlreadyExists is adoption, network and timeout failures are transient", () =>
  Effect.gen(function* () {
    const policy = yield* makeCreationPolicy;
    expect(yield* policy.failed("worker", apiError(409, "AlreadyExists"))).toEqual({
      kind: "already_exists",
    });
    expect(
      yield* policy.failed("worker", kubeApiError(new Error("private-network-diagnostic"))),
    ).toMatchObject({ kind: "transient", backoffSeconds: 1 });
  }),
);

for (const header of [
  "Sun, 06 Nov 1994 08:49:37 GMT",
  "Sunday, 06-Nov-94 08:49:37 GMT",
  "Sun Nov  6 08:49:37 1994",
]) {
  it.effect(`all HTTP-date forms honor Retry-After: ${header}`, () =>
    Effect.gen(function* () {
      const policy = yield* makeCreationPolicy;
      const decision = yield* policy.failed(
        "worker",
        apiError(429, "TooManyRequests", "rate limited", header),
      );
      expect(decision).toMatchObject({ kind: "transient", pauseSeconds: 60 });
      let done = false;
      const fiber = yield* Effect.forkScoped(
        policy.pause(decision).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              done = true;
            }),
          ),
        ),
      );
      yield* TestClock.adjust("59999 millis");
      expect(done).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      expect(done).toBe(true);
    }),
  );
}

for (const [now, header, expected] of [
  ["2026-10-26T12:00:00.000Z", "Sunday, 06-Nov-94 08:49:37 GMT", 0],
  ["2026-10-26T12:00:00.000Z", "Sun Nov  6 08:49:37 1994", 0],
  ["2026-10-26T12:00:00.000Z", "Wednesday, 01-Jan-70 00:00:00 GMT", 60],
  ["2026-10-26T12:00:00.000Z", "Monday, 26-Oct-76 12:00:00 GMT", 60],
  ["2026-10-26T12:00:00.000Z", "Monday, 26-Oct-76 12:00:01 GMT", 0],
  ["2090-01-01T00:00:00.000Z", "Wednesday, 01-Jan-10 00:00:00 GMT", 60],
  ["2026-10-26T12:00:00.250Z", "Mon Oct 26 12:00:09 2026", 9],
  ["2026-10-26T12:00:00.250Z", "Monday, 26-Oct-26 12:00:09 GMT", 9],
  ["2026-01-01T00:00:00.000Z", "Tue, 31 Feb 2026 12:00:00 GMT", 1],
  ["2026-01-01T00:00:00.000Z", "Tuesday, 31-Feb-26 12:00:00 GMT", 1],
  ["2026-01-01T00:00:00.000Z", "Tue Feb 31 12:00:00 2026", 1],
  ["2026-01-01T00:00:00.000Z", "Thu, 01 Jan 2026 25:00:00 GMT", 1],
] as const) {
  it.effect(`UTC HTTP-date and RFC850 year rule: ${now} / ${header}`, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
      const policy = yield* makeCreationPolicy;
      expect(
        yield* policy.failed("worker", apiError(429, "TooManyRequests", "rate limited", header)),
      ).toMatchObject({ kind: "transient", pauseSeconds: expected });
    }),
  );
}
