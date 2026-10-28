import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { afterEach, vi } from "vitest";
import { ConfigInvalid, parseGatewayConfig, parseSchedulerConfig } from "../config/index.js";
import { makeObjectStore } from "./object-store.js";

afterEach(() => vi.restoreAllMocks());
const environment = () => ({
  KRUN_DB_MODE: "embedded",
  KRUN_NAMESPACE: "krun-test-p62",
  KRUN_S3_ENDPOINT: "https://krun-test-p62.invalid",
  KRUN_S3_BUCKET: "krun-test-p62-results",
  KRUN_S3_REGION: "us-east-1",
  KRUN_S3_ACCESS_KEY: randomBytes(16).toString("hex"),
  KRUN_S3_SECRET_KEY: randomBytes(32).toString("hex"),
});
it.effect("disabled object storage is absent and constructs no S3 client", () =>
  Effect.gen(function* () {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const config = yield* parseGatewayConfig({
      KRUN_DB_MODE: "embedded",
      KRUN_NAMESPACE: "krun-test-p62",
    });
    expect(yield* makeObjectStore(config)).toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
  }),
);
for (const field of [
  "KRUN_S3_ENDPOINT",
  "KRUN_S3_BUCKET",
  "KRUN_S3_REGION",
  "KRUN_S3_ACCESS_KEY",
  "KRUN_S3_SECRET_KEY",
] as const) {
  it.effect(`partial object storage rejects missing ${field} without retaining its settings`, () =>
    Effect.gen(function* () {
      const env = { ...environment(), [field]: "" };
      const config = yield* parseSchedulerConfig(env);
      const error = yield* Effect.flip(makeObjectStore(config));
      expect(error).toBeInstanceOf(ConfigInvalid);
      expect(error instanceof ConfigInvalid && error.variable === field).toBe(true);
      for (const value of [env.KRUN_S3_ACCESS_KEY, env.KRUN_S3_SECRET_KEY]) {
        if (value) expect(JSON.stringify(error).includes(value)).toBe(false);
      }
    }),
  );
}
it.effect("configured process adapter signs fixed GET and destroys its client on scope exit", () =>
  Effect.gen(function* () {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const config = yield* parseGatewayConfig({
          ...environment(),
          KRUN_MAX_ACTIVE_DEADLINE: "700000",
        });
        const store = yield* makeObjectStore(config);
        if (!store) return yield* Effect.die("Expected configured process adapter");
        const id = "0192f000-0000-7000-8000-000000000062";
        const get = new URL(yield* store.presignGet(store.ref(id)));
        expect(get.searchParams.get("X-Amz-Expires")).toBe("300");
        expect(get.searchParams.has("X-Amz-Signature")).toBe(true);
        expect(destroy).not.toHaveBeenCalled();
      }),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  }),
);
for (const ttl of [Duration.millis(0), Duration.hours(999)]) {
  it.effect(
    `configured unrepresentable S3 TTL ${Duration.toMillis(ttl)} fails before client acquisition`,
    () =>
      Effect.gen(function* () {
        const destroy = vi.spyOn(S3Client.prototype, "destroy");
        const config = yield* parseSchedulerConfig(environment());
        const error = yield* Effect.flip(makeObjectStore({ ...config, KRUN_S3_PRESIGN_TTL: ttl }));
        expect(error instanceof ConfigInvalid && error.variable === "KRUN_S3_PRESIGN_TTL").toBe(
          true,
        );
        expect(destroy).not.toHaveBeenCalled();
      }),
  );
}

for (const mode of ["boundary", "unsupported", "override", "disabled"] as const) {
  it.effect(`P6.2 repair: scheduler installation TTL policy ${mode}`, () =>
    Effect.gen(function* () {
      const destroy = vi.spyOn(S3Client.prototype, "destroy");
      const config = yield* parseSchedulerConfig({
        ...(mode === "disabled"
          ? { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p62" }
          : environment()),
        KRUN_MAX_ACTIVE_DEADLINE: mode === "boundary" ? "604800" : "700000",
        ...(mode === "override" ? { KRUN_S3_PRESIGN_TTL: "2m" } : {}),
      });
      const exit = yield* Effect.exit(
        Effect.scoped(makeObjectStore(config, config.KRUN_MAX_ACTIVE_DEADLINE)),
      );
      if (mode === "unsupported") {
        expect(exit._tag).toBe("Failure");
        const error = yield* Effect.flip(makeObjectStore(config, config.KRUN_MAX_ACTIVE_DEADLINE));
        expect(error instanceof ConfigInvalid && error.variable === "KRUN_S3_PRESIGN_TTL").toBe(
          true,
        );
        expect(destroy).not.toHaveBeenCalled();
      } else {
        expect(exit._tag).toBe("Success");
        expect(destroy).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
      }
    }),
  );
}
