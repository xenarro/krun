import { expect, it } from "@effect/vitest";
import { Clock, Context, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

class SmokeValue extends Context.Service<SmokeValue, { readonly name: string }>()(
  "krun/test/SmokeValue",
) {}

it.effect("provides an Effect 4 service and test clock", () =>
  Effect.gen(function* () {
    const service = yield* SmokeValue;
    expect(service.name).toBe("shared");
    expect(yield* Clock.currentTimeMillis).toBe(0);
    yield* TestClock.adjust("1 second");
    expect(yield* Clock.currentTimeMillis).toBe(1000);
  }).pipe(Effect.provide(Layer.succeed(SmokeValue, { name: "shared" }))),
);
