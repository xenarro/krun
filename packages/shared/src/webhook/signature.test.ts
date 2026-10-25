import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { describe, expect } from "vitest";
import { sign } from "./index.js";

// Independent test receiver; not a shipped receiver SDK. Never decodes or reserializes the body.
const verifies = (header: string, body: Uint8Array, secret: string, now: number): boolean => {
  const fields = header.split(",");
  const time = fields[0]?.match(/^t=(\d+)$/)?.[1];
  if (time === undefined || Math.abs(now - Number(time)) > 300) return false;
  const expected = createHmac("sha256", secret).update(time).update(".").update(body).digest();
  let match = false;
  for (const field of fields.slice(1)) {
    if (!/^v1=[0-9a-f]{64}$/.test(field)) return false;
    const candidate = Buffer.from(field.slice(3), "hex");
    match = timingSafeEqual(expected, candidate) || match;
  }
  return match;
};

describe("raw-byte rotating webhook signatures", () => {
  it.effect("uses send-time Clock seconds, one v1 per secret and exact raw bytes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_999);
      const keys = [randomBytes(32).toString("base64"), randomBytes(32).toString("base64")];
      const body = new TextEncoder().encode('{"result":"é","spacing":  1}\n');
      const header = yield* sign(body, keys);
      expect(header.split(",")[0]).toBe("t=1000");
      expect(header.split(",").length).toBe(3);
      for (const key of keys) expect(verifies(header, body, key, 1000)).toBe(true);
      expect(verifies(header, body, randomBytes(32).toString("base64"), 1000)).toBe(false);
      expect(
        verifies(
          header,
          new TextEncoder().encode('{"result":"é","spacing":1}'),
          keys[0] ?? "",
          1000,
        ),
      ).toBe(false);
      const changed = Buffer.from(body);
      changed[0] = 0;
      expect(verifies(header, changed, keys[0] ?? "", 1000)).toBe(false);
      yield* TestClock.adjust("1 second");
      const later = yield* sign(body, keys);
      expect(later.split(",")[0]).toBe("t=1001");
      expect(later === header).toBe(false);
      const reordered = yield* sign(body, [...keys].reverse());
      expect(
        reordered.split(",").slice(1).reverse().join(",") === later.split(",").slice(1).join(","),
      ).toBe(true);
    }),
  );

  it.effect("receiver accepts inclusive ±300 seconds and rejects outside the replay window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const key = randomBytes(32).toString("base64");
      const body = new Uint8Array([0, 255, 128, 46]);
      const header = yield* sign(body, [key]);
      for (const now of [700, 1000, 1300]) expect(verifies(header, body, key, now)).toBe(true);
      for (const now of [699, 1301]) expect(verifies(header, body, key, now)).toBe(false);
      expect(verifies(header.replace("t=1000", "t=1001"), body, key, 1000)).toBe(false);
    }),
  );

  it.effect(
    "signs the validated key snapshot rather than re-reading caller-owned mutable keys",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000_000);
        const key = randomBytes(32).toString("base64");
        let reads = 0;
        const keys = Object.defineProperty([key], 0, { get: () => (++reads === 1 ? key : "") });
        const body = new Uint8Array([1, 2, 3]);
        const header = yield* sign(body, keys);
        expect(verifies(header, body, key, 1000)).toBe(true);
        expect(reads).toBe(1);
      }),
  );

  it.effect("rejects missing or empty keys without emitting key material or a partial header", () =>
    Effect.gen(function* () {
      for (const keys of [[], [""], [randomBytes(32).toString("base64"), ""]]) {
        const error = yield* Effect.flip(sign(new Uint8Array(), keys));
        expect(error._tag).toBe("WebhookSigningError");
        expect(Object.keys(error).every((key) => ["_tag", "reason"].includes(key))).toBe(true);
      }
    }),
  );

  it("property: every active key verifies arbitrary bytes; any byte change fails", async () => {
    const keys = Array.from({ length: 8 }, () => randomBytes(32).toString("base64"));
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 512 }),
        fc.integer({ min: 1, max: 8 }),
        async (body, count) => {
          const active = keys.slice(0, count);
          const header = await Effect.runPromise(sign(body, active));
          const seconds = Number(header.split(",")[0]?.slice(2));
          expect(Number.isSafeInteger(seconds)).toBe(true);
          for (const key of active) expect(verifies(header, body, key, seconds)).toBe(true);
          const altered = Buffer.concat([Buffer.from(body), Buffer.from([0])]);
          for (const key of active) expect(verifies(header, altered, key, seconds)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
