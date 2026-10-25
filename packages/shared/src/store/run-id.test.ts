import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { newRunId } from "./run-id.js";

it.effect("Run UUIDv7 time comes from the caller's owning Clock, including epoch zero", () =>
  Effect.gen(function* () {
    for (const millis of [0, 1792886400000]) {
      yield* TestClock.setTime(millis);
      const at = yield* DateTime.now;
      const ids = yield* Effect.all(Array.from({ length: 64 }, () => newRunId(at)));
      expect(new Set(ids).size).toBe(64);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(millis);
      }
    }
  }),
);

it.effect("Run UUIDv7 does not replace an explicitly supplied instant with the current clock", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const supplied = DateTime.makeUnsafe(1792886400000);
    const id = yield* newRunId(supplied);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(
      DateTime.toEpochMillis(supplied),
    );
    expect(DateTime.toEpochMillis(yield* DateTime.now)).toBe(0);
  }),
);
