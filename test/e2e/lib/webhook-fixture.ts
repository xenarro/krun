import { z } from "zod";

export const receiverSnapshotSchema = z.array(
  z.strictObject({
    deliveryId: z.string(),
    runId: z.string(),
    timestamp: z.number().int(),
    v1Count: z.number().int(),
    valid: z.boolean(),
    sameBody: z.boolean(),
    responseStatus: z.number().int(),
    traceparent: z.string(),
  }),
);

export const webhookResources = (
  name: string,
  image: string,
  source: string,
  namespace = "krun",
) => {
  const labels = { "krun.io/e2e-receiver": name };
  const metadata = { name, namespace, labels };
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      // The host uses source contracts without a build prerequisite; the receiver
      // uses the identical compiled contract shipped in the actual runtime image.
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata,
        data: {
          "webhook-receiver.ts": source.replace(
            '"../../../apps/gateway/src/public-contracts.js"',
            '"../../../apps/gateway/dist/public-contracts.js"',
          ),
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata,
        spec: { selector: labels, ports: [{ port: 8080, targetPort: 8080 }] },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata,
        spec: {
          podSelector: { matchLabels: labels },
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
      },
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata,
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "receiver",
              image,
              command: ["/nodejs/bin/node", "/app/test/e2e/lib/webhook-receiver.ts"],
              env: [{ name: "KRUN_TEST_FUNCTION", value: name }],
              ports: [{ containerPort: 8080 }],
              readinessProbe: {
                httpGet: { path: "/healthz", port: 8080 },
                periodSeconds: 1,
                timeoutSeconds: 2,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "50m", memory: "32Mi" },
                limits: { cpu: "1", memory: "128Mi" },
              },
              volumeMounts: [
                // A directory ConfigMap mount exposes versioned symlinks. Pin the
                // file so Node resolves its entrypoint and relative image contract.
                {
                  name: "source",
                  mountPath: "/app/test/e2e/lib/webhook-receiver.ts",
                  subPath: "webhook-receiver.ts",
                  readOnly: true,
                },
                { name: "keys", mountPath: "/keys", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "source", configMap: { name } },
            {
              name: "keys",
              secret: {
                secretName: "krun-e2e-webhook-keys",
                defaultMode: 288,
                items: [
                  { key: "current", path: "current" },
                  { key: "previous", path: "previous" },
                ],
              },
            },
          ],
        },
      },
    ],
  };
};
