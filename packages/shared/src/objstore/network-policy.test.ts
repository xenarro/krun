import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseAllDocuments } from "yaml";
import { ObjectStore, ObjectStoreS3 } from "./index.js";

const chart = fileURLToPath(new URL("../../../../deploy/helm/krun", import.meta.url));
const id = "0192f000-0000-7000-8000-000000000001";
const options = (endpoint: string) => ({
  endpoint,
  bucket: "krun-test-results",
  region: "us-east-1",
  accessKeyId: randomBytes(16).toString("hex"),
  secretAccessKey: randomBytes(32).toString("hex"),
});
const policyPort = (mode: string, endpoint: string) => {
  const rendered = spawnSync(
    "helm",
    [
      "template",
      "krun-test-endpoint",
      chart,
      "--namespace",
      "krun-test-platform",
      "--set-json",
      JSON.stringify({
        apiKeys: { existingSecret: "krun-test-unused" },
        db: { mode, postgres: { existingSecret: "krun-test-unused" } },
        gateway: { replicas: 1 },
        jobsNamespace: { name: "krun-test-jobs" },
        objectStorage: {
          enabled: true,
          endpoint,
          bucket: "krun-test-results",
          existingSecret: "krun-test-unused",
          egress: [{ ipBlock: { cidr: "127.0.0.1/32" } }],
        },
      }),
    ],
    { encoding: "utf8" },
  );
  expect(rendered.status, rendered.stderr).toBe(0);
  const policies = parseAllDocuments(rendered.stdout).map((document) => {
    expect(document.errors).toEqual([]);
    return document.toJSON();
  });
  const policy = policies.find(
    (document) =>
      document?.kind === "NetworkPolicy" &&
      document.metadata.name === "krun-jobs-allow-object-storage",
  );
  expect(policy).toBeDefined();
  return policy.spec.egress[0].ports[0].port;
};

for (const mode of ["postgres", "embedded"]) {
  for (const endpoint of [
    "http:krun-test-storage.krun-test-storage.svc:9000",
    "https:/krun-test-storage.krun-test-storage.svc:9443",
    "http://%6brun-test-storage.krun-test-storage.svc:9000",
    "https://%6brun-test-storage.krun-test-storage.svc:9443",
    "https:\\krun-test-storage.krun-test-storage.svc:9443",
    "  h\tttps:krun-test-storage.krun-test-storage.svc:94\r\n43  ",
  ]) {
    it.effect(
      `chart port equals the real adapter signed port in ${mode}: ${JSON.stringify(endpoint)}`,
      () =>
        Effect.gen(function* () {
          const store = yield* ObjectStore;
          // Inspect only the origin port; never retain or print a signed capability.
          const signed = new URL(yield* store.presignPut(id, 60));
          expect(signed.hostname).toBe("krun-test-storage.krun-test-storage.svc");
          const actualPort = Number(signed.port || (signed.protocol === "https:" ? 443 : 80));
          expect(policyPort(mode, endpoint)).toBe(actualPort);
        }).pipe(Effect.provide(ObjectStoreS3(options(endpoint)))),
    );
  }
  for (const representation of ["canonical", "short", "percent-host"]) {
    it.live(
      `chart port equals the adapter actual HEAD destination in ${mode}, representation=${representation}`,
      () =>
        Effect.gen(function* () {
          let headRequests = 0;
          const server = createServer((request, response) => {
            if (request.method === "HEAD") headRequests++;
            response.writeHead(200);
            response.end();
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    server.removeListener("error", reject);
                    resolve();
                  });
                }),
            ),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    server.closeAllConnections();
                    server.close((error) => (error ? reject(error) : resolve()));
                  }),
              ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Missing test server port");
          const host = representation === "percent-host" ? "%31%32%37.0.0.1" : "127.0.0.1";
          const endpoint = `http:${representation === "short" ? "" : "//"}${host}:${address.port}`;
          yield* Effect.gen(function* () {
            const store = yield* ObjectStore;
            const signed = new URL(yield* store.presignPut(id, 60));
            expect(Number(signed.port)).toBe(address.port);
            expect(yield* store.exists(id)).toBe(true);
            expect(headRequests).toBe(1);
            expect(policyPort(mode, endpoint)).toBe(address.port);
          }).pipe(Effect.provide(ObjectStoreS3(options(endpoint))));
        }),
    );
  }
}
