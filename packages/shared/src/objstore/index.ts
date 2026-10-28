import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { z } from "zod";

export class ObjectStoreError extends Data.TaggedError("ObjectStoreError")<{
  readonly operation: "configure" | "close" | "presignPut" | "presignGet" | "exists";
}> {}

export class ObjectStore extends Context.Service<
  ObjectStore,
  {
    readonly presignPut: (
      runId: string,
      ttlSeconds: number,
    ) => Effect.Effect<string, ObjectStoreError>;
    readonly presignGet: (ref: string) => Effect.Effect<string, ObjectStoreError>;
    readonly exists: (runId: string) => Effect.Effect<boolean, ObjectStoreError>;
    /** Stored Run IDs are canonical UUIDv7s; I/O methods also enforce this boundary. */
    readonly ref: (runId: string) => string;
  }
>()("krun/ObjectStore") {}

const configSchema = z.strictObject({
  endpoint: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  bucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});
const runIdSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const ttlSchema = z.number().int().min(1).max(604800);
const key = (runId: string) => `runs/${runId}/result.json`;
const bounded = <A>(
  operation: ObjectStoreError["operation"],
  effect: Effect.Effect<A, ObjectStoreError>,
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new ObjectStoreError({ operation })),
    }),
  );

// Explicit parsed settings, not ambient AWS credentials or process.env. Callers
// omit this layer when object storage is disabled; process wiring is P6.2.
export const ObjectStoreS3 = (options: z.infer<typeof configSchema>) =>
  Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      const parsed = configSchema.safeParse(options);
      if (!parsed.success)
        return yield* Effect.fail(new ObjectStoreError({ operation: "configure" }));
      const config = parsed.data;
      const client = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new S3Client({
              endpoint: config.endpoint,
              region: config.region,
              credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              },
              forcePathStyle: true,
              requestChecksumCalculation: "WHEN_REQUIRED",
              maxAttempts: 1,
            }),
          catch: () => new ObjectStoreError({ operation: "configure" }),
        }),
        (value) =>
          Effect.try({
            try: () => value.destroy(),
            catch: () => new ObjectStoreError({ operation: "close" }),
          }).pipe(Effect.orDie),
      );
      const presign = (operation: "presignPut" | "presignGet", runId: string, ttlSeconds: number) =>
        bounded(
          operation,
          Effect.gen(function* () {
            if (!runIdSchema.safeParse(runId).success || !ttlSchema.safeParse(ttlSeconds).success)
              return yield* Effect.fail(new ObjectStoreError({ operation }));
            const signingDate = DateTime.toDateUtc(yield* DateTime.now);
            return yield* Effect.tryPromise({
              try: () =>
                getSignedUrl(
                  client,
                  operation === "presignPut"
                    ? new PutObjectCommand({ Bucket: config.bucket, Key: key(runId) })
                    : new GetObjectCommand({ Bucket: config.bucket, Key: key(runId) }),
                  { expiresIn: ttlSeconds, signingDate },
                ),
              catch: () => new ObjectStoreError({ operation }),
            });
          }),
        );
      return ObjectStore.of({
        ref: (runId) => `s3://${config.bucket}/${key(runId)}`,
        presignPut: (runId, ttlSeconds) => presign("presignPut", runId, ttlSeconds),
        presignGet: (ref) =>
          Effect.suspend(() => {
            const prefix = `s3://${config.bucket}/runs/`;
            const suffix = "/result.json";
            if (!ref.startsWith(prefix) || !ref.endsWith(suffix))
              return Effect.fail(new ObjectStoreError({ operation: "presignGet" }));
            return presign("presignGet", ref.slice(prefix.length, -suffix.length), 300);
          }),
        exists: (runId) =>
          bounded(
            "exists",
            Effect.suspend(() => {
              if (!runIdSchema.safeParse(runId).success)
                return Effect.fail(new ObjectStoreError({ operation: "exists" }));
              return Effect.tryPromise({
                try: async (signal) => {
                  try {
                    await client.send(
                      new HeadObjectCommand({ Bucket: config.bucket, Key: key(runId) }),
                      { abortSignal: signal },
                    );
                    return true;
                  } catch (cause) {
                    if (!(cause instanceof NotFound) || cause.$metadata.httpStatusCode !== 404)
                      throw cause;
                    // HeadObject has no response body: a missing bucket can also be
                    // NotFound/404. Only an accessible bucket makes absence certain.
                    await client.send(new HeadBucketCommand({ Bucket: config.bucket }), {
                      abortSignal: signal,
                    });
                    return false;
                  }
                },
                catch: () => new ObjectStoreError({ operation: "exists" }),
              });
            }),
          ),
      });
    }),
  );
