import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { ObjectStore, ObjectStoreError, ObjectStoreS3 } from "./index.js";

const options = () => ({
  endpoint: "http://127.0.0.1:1",
  bucket: "krun-test-results",
  region: "us-east-1",
  accessKeyId: randomBytes(16).toString("hex"),
  secretAccessKey: randomBytes(32).toString("hex"),
});
const id = "0192f000-0000-7000-8000-000000000001";
it.effect("signing date comes from Effect Clock and each execution uses fresh time", () =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T00:00:00Z")));
    const sign = store.presignPut(id, 60);
    const first = new URL(yield* sign).searchParams;
    yield* TestClock.adjust("1 second");
    const second = new URL(yield* sign).searchParams;
    expect(first.get("X-Amz-Date")).toBe("20261028T000000Z");
    expect(second.get("X-Amz-Date")).toBe("20261028T000001Z");
    expect(first.get("X-Amz-SignedHeaders")).toBe("host");
    expect(second.get("X-Amz-Expires")).toBe("60");
  }).pipe(Effect.provide(ObjectStoreS3(options()))),
);

for (const ttl of [0, -1, 0.5, 604801, Number.NaN, Number.POSITIVE_INFINITY]) {
  it.effect(`rejects invalid PUT TTL ${ttl} before signing or network access`, () =>
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const error = yield* Effect.flip(store.presignPut(id, ttl));
      expect(error).toBeInstanceOf(ObjectStoreError);
      expect(error.operation).toBe("presignPut");
    }).pipe(Effect.provide(ObjectStoreS3(options()))),
  );
}

for (const ref of [
  `s3://other-bucket/runs/${id}/result.json`,
  `https://krun-test-results/runs/${id}/result.json`,
  `s3://krun-test-results/runs/${id}/../foreign.json`,
  `s3://krun-test-results/runs/${id}/result.json?query=private`,
  `s3://krun-test-results/runs/${id}/result.json#fragment`,
  `s3://user:private@krun-test-results/runs/${id}/result.json`,
]) {
  it.effect("rejects a noncanonical or foreign result reference without retaining it", () =>
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const error = yield* Effect.flip(store.presignGet(ref));
      expect(error.operation).toBe("presignGet");
      expect(JSON.stringify(error).includes(ref)).toBe(false);
    }).pipe(Effect.provide(ObjectStoreS3(options()))),
  );
}

it.effect("invalid run IDs cannot escape the fixed result-key namespace", () =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    for (const run of ["../other", "", id.toUpperCase(), id.replace("-7000-", "-4000-")]) {
      expect((yield* Effect.flip(store.presignPut(run, 60))).operation).toBe("presignPut");
      expect((yield* Effect.flip(store.exists(run))).operation).toBe("exists");
    }
  }).pipe(Effect.provide(ObjectStoreS3(options()))),
);

it.effect(
  "invalid configuration is a bounded tagged failure without credentials or native causes",
  () =>
    Effect.gen(function* () {
      const config = { ...options(), endpoint: "not-an-endpoint" };
      const error = yield* Effect.flip(Effect.provide(ObjectStore, ObjectStoreS3(config)));
      expect(error.operation).toBe("configure");
      for (const value of [config.endpoint, config.accessKeyId, config.secretAccessKey])
        expect(JSON.stringify(error).includes(value)).toBe(false);
      expect("cause" in error).toBe(false);
    }),
);
