import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "@effect/vitest";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { Effect } from "effect";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { ObjectStore, ObjectStoreError, ObjectStoreS3 } from "./index.js";

let container: StartedMinioContainer | undefined;
let options: Parameters<typeof ObjectStoreS3>[0];
const image = "krun-test-minio:p61-20250907";
const bucket = "krun-test-results";
const id = "0192f000-0000-7000-8000-000000000001";
const missing = "0192f000-0000-7000-8000-000000000002";
beforeAll(async () => {
  try {
    // Public vendor registries reject this release anonymously. The fixture
    // builds the genuine upstream binaries with enforced release SHA256s.
    await GenericContainer.fromDockerfile(
      fileURLToPath(new URL("../../../../test/minio", import.meta.url)),
    )
      .withBuildkit()
      .build(image, { deleteOnExit: false });
    container = await new MinioContainer(image)
      .withName(`krun-test-p61-minio-${process.pid}`)
      .withUsername(randomBytes(16).toString("hex"))
      .withPassword(randomBytes(32).toString("hex"))
      .withUser("65532:65532")
      .withTmpFs({ "/data": "rw,nosuid,nodev,size=64m,uid=65532,gid=65532" })
      .withDroppedCapabilities("ALL")
      .withSecurityOpt("no-new-privileges")
      .start();
    options = {
      endpoint: container.getConnectionUrl(),
      bucket,
      region: "us-east-1",
      accessKeyId: container.getUsername(),
      secretAccessKey: container.getPassword(),
    };
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } finally {
      client.destroy();
    }
  } catch {
    throw new Error("Owned MinIO fixture startup failed; private diagnostics withheld");
  }
}, 180_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal });
      return { status: response.status, bytes: await response.text() };
    },
    catch: () => new Error("Owned MinIO HTTP request failed; private diagnostics withheld"),
  });

it.live(
  "presigns host-only PUT with explicit TTL, uploads JSON, observes existence and serves identical GET bytes",
  () =>
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      expect(yield* store.exists(id)).toBe(false);
      const put = yield* store.presignPut(id, 123);
      const query = new URL(put).searchParams;
      expect(query.get("X-Amz-Expires")).toBe("123");
      expect(query.get("X-Amz-SignedHeaders")).toBe("host");
      expect(
        [...query.keys()].some((key) => /checksum|content-type|content-length/i.test(key)),
      ).toBe(false);
      const bytes = '{"opaque":"café ✓","nested":[false,0,null]}';
      const upload = yield* request(put, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "application/json" },
      });
      expect(upload.status).toBe(200);
      expect(yield* store.exists(id)).toBe(true);
      expect(yield* store.exists(missing)).toBe(false);
      const ref = store.ref(id);
      expect(ref).toBe(`s3://${bucket}/runs/${id}/result.json`);
      const get = yield* store.presignGet(ref);
      expect(new URL(get).searchParams.get("X-Amz-Expires")).toBe("300");
      const result = yield* request(get);
      expect(result.status).toBe(200);
      expect(result.bytes === bytes).toBe(true);
    }).pipe(Effect.provide(ObjectStoreS3(options))),
);

it.live("missing bucket is an infrastructure failure, not a missing object", () =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    const error = yield* Effect.flip(store.exists(missing));
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect(error.operation).toBe("exists");
  }).pipe(Effect.provide(ObjectStoreS3({ ...options, bucket: "krun-test-absent-bucket" }))),
);

it.live("permission failures stay typed and never retain credentials or native diagnostics", () =>
  Effect.gen(function* () {
    const store = yield* ObjectStore;
    const error = yield* Effect.flip(store.exists(id));
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect(error.operation).toBe("exists");
    for (const value of [options.endpoint, options.accessKeyId, options.secretAccessKey])
      expect(JSON.stringify(error).includes(value)).toBe(false);
    expect("cause" in error).toBe(false);
  }).pipe(
    Effect.provide(ObjectStoreS3({ ...options, secretAccessKey: randomBytes(32).toString("hex") })),
  ),
);
