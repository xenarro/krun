import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseAllDocuments } from "yaml";
import { ConfigInvalid, parseGatewayConfig, parseSchedulerConfig } from "../config/index.js";
import { makeObjectStore } from "./object-store.js";

const chart = fileURLToPath(new URL("../../../../deploy/helm/krun", import.meta.url));
const render = (
  mode: string,
  enabled: boolean,
  region = "us-east-1",
  hosts = ["callback.example.test"],
) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-integration",
      chart,
      "--namespace",
      "krun-test-platform",
      "--set-json",
      JSON.stringify({
        apiKeys: { existingSecret: "krun-test-api" },
        db: {
          mode,
          postgres: { existingSecret: "krun-test-db" },
          embedded: {
            litestream: {
              enabled: true,
              image: `litestream/litestream@sha256:${"a".repeat(64)}`,
              existingSecret: "krun-test-replica",
            },
          },
        },
        gateway: { replicas: 1 },
        objectStorage: {
          enabled,
          endpoint: "https://store.example.test:9000",
          bucket: "krun-test-results",
          region,
          existingSecret: "krun-test-s3",
        },
        webhooks: {
          allowedHosts: enabled ? hosts : [],
          allowedCIDRs: ["192.0.2.0/24", "2001:db8::/32"],
          existingSecret: "krun-test-callback",
        },
      }),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout)
    .map((d) => d.toJSON())
    .filter(Boolean);
};

for (const mode of ["postgres", "embedded"]) {
  it.effect(`connects actual ${mode} chart env through real config and S3 acquisition`, () =>
    Effect.gen(function* () {
      const secrets = {
        "krun-test-db": {
          dsn: `postgresql://krun:${randomBytes(24).toString("hex")}@krun-test-db/krun`,
        },
        "krun-test-s3": {
          accessKey: randomBytes(16).toString("hex"),
          secretKey: randomBytes(32).toString("hex"),
        },
        "krun-test-callback": {
          secret: `${randomBytes(32).toString("hex")},${randomBytes(32).toString("hex")}`,
        },
      };
      const documents = render(mode, true);
      const serving = documents
        .filter((d) => ["Deployment", "StatefulSet"].includes(d.kind))
        .flatMap((d) => d.spec.template.spec.containers);
      expect(serving).toHaveLength(2);
      for (const container of serving) {
        const env: Record<string, string> = {};
        for (const entry of container.env) {
          expect(env[entry.name]).toBeUndefined();
          if (entry.value !== undefined) env[entry.name] = entry.value;
          else if (entry.valueFrom.secretKeyRef) {
            const { name, key } = entry.valueFrom.secretKeyRef;
            const secret = secrets[name as keyof typeof secrets] as Record<string, string>;
            const value = secret?.[key];
            if (value === undefined) throw new Error("Missing named test Secret reference");
            env[entry.name] = value;
          } else env[entry.name] = "krun-test-scheduler";
        }
        for (const [name, key] of [
          ["KRUN_S3_ACCESS_KEY", "accessKey"],
          ["KRUN_S3_SECRET_KEY", "secretKey"],
        ]) {
          expect(container.env.find((v: { name: string }) => v.name === name)).toEqual({
            name,
            valueFrom: { secretKeyRef: { name: "krun-test-s3", key } },
          });
        }
        expect(env.KRUN_S3_ENDPOINT).toBe("https://store.example.test:9000");
        expect(env.KRUN_S3_BUCKET).toBe("krun-test-results");
        expect(env.KRUN_S3_REGION).toBe("us-east-1");
        expect(env.KRUN_WEBHOOK_ALLOWED_HOSTS).toBe("callback.example.test");
        expect(env.KRUN_WEBHOOK_ALLOWED_CIDRS).toBe("192.0.2.0/24,2001:db8::/32");
        expect(
          container.env.find((v: { name: string }) => v.name === "KRUN_WEBHOOK_SECRET"),
        ).toEqual(
          container.name === "scheduler"
            ? {
                name: "KRUN_WEBHOOK_SECRET",
                valueFrom: { secretKeyRef: { name: "krun-test-callback", key: "secret" } },
              }
            : undefined,
        );
        const config =
          container.name === "scheduler"
            ? yield* parseSchedulerConfig(env)
            : yield* parseGatewayConfig(env);
        expect(config.KRUN_WEBHOOK_ALLOWED_HOSTS).toEqual(["callback.example.test"]);
        expect(config.KRUN_WEBHOOK_ALLOWED_CIDRS).toHaveLength(2);
        const store = yield* makeObjectStore(config);
        expect(store).toBeDefined();
      }
      for (const document of documents.filter((d) => ["Job", "StatefulSet"].includes(d.kind))) {
        for (const container of [
          ...(document.spec.template.spec.initContainers ?? []),
          ...(document.kind === "Job" ? document.spec.template.spec.containers : []),
        ]) {
          expect(
            container.env.filter(
              (v: { name: string }) =>
                (v.name.startsWith("KRUN_S3_") && v.name !== "KRUN_S3_PRESIGN_TTL") ||
                v.name.startsWith("KRUN_WEBHOOK_"),
            ),
          ).toEqual([]);
        }
      }
      expect(documents.some((d) => ["Secret", "ConfigMap", "Function"].includes(d.kind))).toBe(
        false,
      );
    }),
  );

  it.effect(`disabled ${mode} chart integration cannot accidentally enable an adapter`, () =>
    Effect.gen(function* () {
      for (const container of render(mode, false)
        .filter((d) => ["Deployment", "StatefulSet"].includes(d.kind))
        .flatMap((d) => d.spec.template.spec.containers)) {
        expect(
          container.env.filter(
            (v: { name: string }) =>
              (v.name.startsWith("KRUN_S3_") && v.name !== "KRUN_S3_PRESIGN_TTL") ||
              v.name.startsWith("KRUN_WEBHOOK_"),
          ),
        ).toEqual([]);
      }
    }),
  );

  it.effect(`enabled ${mode} storage with omitted region fails sanitized real acquisition`, () =>
    Effect.gen(function* () {
      const container = render(mode, true, "")
        .filter((d) => ["Deployment", "StatefulSet"].includes(d.kind))
        .flatMap((d) => d.spec.template.spec.containers)
        .find((c) => c.name === "gateway");
      const env = Object.fromEntries(
        container.env
          .filter((v: { value?: string }) => v.value !== undefined)
          .map((v: { name: string; value: string }) => [v.name, v.value]),
      );
      const config = yield* parseGatewayConfig({
        ...env,
        ...(mode === "postgres" ? { KRUN_DB_DSN: "postgresql://krun-test-db/krun" } : {}),
        KRUN_S3_ACCESS_KEY: randomBytes(16).toString("hex"),
        KRUN_S3_SECRET_KEY: randomBytes(32).toString("hex"),
      });
      const error = yield* Effect.flip(makeObjectStore(config));
      expect(error).toBeInstanceOf(ConfigInvalid);
      if (!(error instanceof ConfigInvalid))
        throw new Error("Missing expected sanitized configuration failure");
      expect(error.variable).toBe("KRUN_S3_REGION");
      expect(error.message).toBe("Invalid configuration: KRUN_S3_REGION");
      if (!config.KRUN_S3_ACCESS_KEY || !config.KRUN_S3_SECRET_KEY)
        throw new Error("Missing private generated config fixture");
      expect(JSON.stringify(error).includes(config.KRUN_S3_ACCESS_KEY)).toBe(false);
      expect(JSON.stringify(error).includes(config.KRUN_S3_SECRET_KEY)).toBe(false);
    }),
  );

  it(`joins multiple ${mode} callback hosts without spaces and keeps secrets scheduler-only`, () => {
    const containers = render(mode, true, "us-east-1", [
      "first.example.test",
      "*.second.example.test",
    ])
      .filter((d) => ["Deployment", "StatefulSet"].includes(d.kind))
      .flatMap((d) => d.spec.template.spec.containers);
    for (const container of containers)
      expect(
        container.env.find((v: { name: string }) => v.name === "KRUN_WEBHOOK_ALLOWED_HOSTS")?.value,
      ).toBe("first.example.test,*.second.example.test");
  });
}
