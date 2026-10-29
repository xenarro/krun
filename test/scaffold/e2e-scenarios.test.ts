import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { chartValues } from "../e2e/lib/chart.js";
import { webhookResources } from "../e2e/lib/webhook-fixture.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
it("requires every Phase4, Phase5 and Phase6 scenario file and refuses an empty suite", () => {
  expect(
    readdirSync(`${root}test/e2e`)
      .filter((path) => path.endsWith(".e2e.ts"))
      .sort(),
  ).toEqual([
    "chart.e2e.ts",
    "exit_code.e2e.ts",
    "exit_code_status.e2e.ts",
    "heartbeat_timeout.e2e.ts",
    "image_pull_backoff.e2e.ts",
    "large_result.e2e.ts",
    "success.e2e.ts",
    "wait.e2e.ts",
    "webhook.e2e.ts",
  ]);
  expect(read("test/e2e/vitest.config.ts")).toContain("passWithNoTests: false");
});
it("pins curl fixtures and uses strict shell errors plus contract-specific retries", () => {
  const images = parse(read("test/e2e/images.json"));
  expect(images.curl).toMatch(/^curlimages\/curl:[\d.]+@sha256:[a-f0-9]{64}$/);
  const common = read("test/e2e/functions/common.sh");
  expect(common).toContain("set -eu");
  expect(common).toContain("--fail-with-body");
  expect(common).toContain("--retry 3 --retry-connrefused");
  expect(common.split("status()")[1]).not.toContain("--retry");
  expect(read("test/e2e/functions/success.sh")).toContain("--data-binary @/tmp/input.json");
  expect(read("test/e2e/functions/exit_code_status.sh")).toContain("exit 3");
});

it("allows only the disposable receiver host glob and actual kind CIDRs in each chart mode", () => {
  const kind = parse(read("test/e2e/kind.yaml"));
  for (const mode of ["embedded", "postgres"] as const) {
    const values = chartValues(mode, `localhost:5001/krun@sha256:${"a".repeat(64)}`);
    expect(values.webhooks.allowedHosts).toEqual([
      `krun-test-webhook-*.krun-test-${mode}.svc.cluster.local`,
    ]);
    expect(values.webhooks.allowedCIDRs).toEqual([
      kind.networking.podSubnet,
      kind.networking.serviceSubnet,
    ]);
    expect(values.webhooks.existingSecret).toBe("krun-e2e-webhook-keys");
  }
});

it("mounts the real image contract in a restricted, credential-free receiver with scoped ingress and cleanup labels", () => {
  const name = "krun-test-webhook-control";
  const image = `localhost:5001/krun@sha256:${"a".repeat(64)}`;
  const source = read("test/e2e/lib/webhook-receiver.ts");
  const resources = webhookResources(name, image, source);
  expect(resources.items).toHaveLength(4);
  for (const item of resources.items)
    expect(item.metadata).toEqual({
      name,
      namespace: "krun",
      labels: { "krun.io/e2e-receiver": name },
    });
  expect(resources.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "Pod",
        spec: expect.objectContaining({
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            expect.objectContaining({
              image,
              command: ["/nodejs/bin/node", "/app/test/e2e/lib/webhook-receiver.ts"],
              volumeMounts: [
                {
                  name: "source",
                  mountPath: "/app/test/e2e/lib/webhook-receiver.ts",
                  subPath: "webhook-receiver.ts",
                  readOnly: true,
                },
                { name: "keys", mountPath: "/keys", readOnly: true },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            }),
          ],
        }),
      }),
      expect.objectContaining({
        kind: "NetworkPolicy",
        spec: {
          podSelector: { matchLabels: { "krun.io/e2e-receiver": name } },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/name": "krun",
                      "app.kubernetes.io/instance": "e2e",
                    },
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 8080 }],
            },
          ],
        },
      }),
      expect.objectContaining({
        kind: "ConfigMap",
        data: {
          "webhook-receiver.ts": source.replace(
            '"../../../apps/gateway/src/public-contracts.js"',
            '"../../../apps/gateway/dist/public-contracts.js"',
          ),
        },
      }),
    ]),
  );
});
