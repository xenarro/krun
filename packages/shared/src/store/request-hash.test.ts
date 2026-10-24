import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "./errors.js";
import { requestHash } from "./request-hash.js";

it.effect("hashes only the received request projection using lowercase SHA256 over JCS", () =>
  Effect.gen(function* () {
    const input = { z: -0, a: [1e30, "é", true, null] };
    const expected = createHash("sha256")
      .update('{"callback":null,"input":{"a":[1e+30,"é",true,null],"z":0},"priority":2}')
      .digest("hex");
    expect(yield* requestHash({ input, priority: 2 })).toBe(expected);
    expect(yield* requestHash({ priority: 2, input: { a: [1e30, "é", true, null], z: 0 } })).toBe(
      expected,
    );
  }),
);
it.effect(
  "normalizes fixed API defaults but excludes query fields and Function callback fallback",
  () =>
    Effect.gen(function* () {
      const absent = yield* requestHash({ input: {} });
      expect(yield* requestHash({ input: {}, priority: 0 })).toBe(absent);
      const withQueryFields = { input: {}, requestId: "test-request", wait: "1s" };
      expect(yield* requestHash(withQueryFields)).toBe(absent);
      expect(yield* requestHash({ input: {}, priority: 1 })).not.toBe(absent);
      expect(
        yield* requestHash({ input: {}, callback: { url: "https://callback.example.test/done" } }),
      ).not.toBe(absent);
    }),
);
it.effect("API3.3 default fingerprint equals the independent normalized JCS golden vector", () =>
  Effect.gen(function* () {
    const expected = createHash("sha256")
      .update('{"callback":null,"input":{},"priority":0}')
      .digest("hex");
    expect(yield* requestHash({ input: {} })).toBe(expected);
    expect(yield* requestHash({ input: {}, priority: 0 })).toBe(expected);
  }),
);

for (const value of [NaN, Infinity, -Infinity, "\ud800"])
  it.effect(
    `rejects invalid RFC8785 input without retaining it: ${typeof value}${String(value).length}`,
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requestHash({ input: { bad: value } }));
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error.message).toBe("Database operation failed");
      }),
  );
