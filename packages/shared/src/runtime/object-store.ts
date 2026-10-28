import { Context, Duration, Effect, Layer } from "effect";
import { ConfigInvalid, type SchedulerConfig } from "../config/index.js";
import { ObjectStore, ObjectStoreS3 } from "../objstore/index.js";

type Settings = Pick<
  SchedulerConfig,
  | "KRUN_S3_ENDPOINT"
  | "KRUN_S3_BUCKET"
  | "KRUN_S3_REGION"
  | "KRUN_S3_ACCESS_KEY"
  | "KRUN_S3_SECRET_KEY"
  | "KRUN_S3_PRESIGN_TTL"
>;

/** Acquire once in the process scope. Disabled storage is absence, not a fake. */
export const makeObjectStore = (config: Settings, maxPutTtlSeconds?: number) =>
  Effect.gen(function* () {
    const endpoint = config.KRUN_S3_ENDPOINT,
      bucket = config.KRUN_S3_BUCKET,
      region = config.KRUN_S3_REGION,
      accessKeyId = config.KRUN_S3_ACCESS_KEY,
      secretAccessKey = config.KRUN_S3_SECRET_KEY;
    if (
      [endpoint, bucket, region, accessKeyId, secretAccessKey].every((value) => value === undefined)
    )
      return undefined;
    if (endpoint === undefined) return yield* new ConfigInvalid({ variable: "KRUN_S3_ENDPOINT" });
    if (bucket === undefined) return yield* new ConfigInvalid({ variable: "KRUN_S3_BUCKET" });
    if (region === undefined) return yield* new ConfigInvalid({ variable: "KRUN_S3_REGION" });
    if (accessKeyId === undefined)
      return yield* new ConfigInvalid({ variable: "KRUN_S3_ACCESS_KEY" });
    if (secretAccessKey === undefined)
      return yield* new ConfigInvalid({ variable: "KRUN_S3_SECRET_KEY" });
    // Only the scheduler supplies its Function deadline ceiling. GET-only
    // gateway acquisition must not inherit a PUT configuration restriction.
    if (config.KRUN_S3_PRESIGN_TTL === undefined && (maxPutTtlSeconds ?? 0) > 604800)
      return yield* new ConfigInvalid({ variable: "KRUN_S3_PRESIGN_TTL" });
    if (config.KRUN_S3_PRESIGN_TTL !== undefined) {
      const ttl = Math.ceil(Duration.toSeconds(config.KRUN_S3_PRESIGN_TTL));
      if (ttl < 1 || ttl > 604800)
        return yield* new ConfigInvalid({ variable: "KRUN_S3_PRESIGN_TTL" });
    }
    const context = yield* Layer.build(
      ObjectStoreS3({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
    );
    return Context.get(context, ObjectStore);
  });
