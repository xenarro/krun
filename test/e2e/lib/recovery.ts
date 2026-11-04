import { z } from "zod";
import { eventually } from "./wait.js";

export const litestreamImage =
  "litestream/litestream@sha256:027eda2a89a86015b9797d2129d4dd447e8953097b4190e1d5a30b73e76d8d58";
// v0.3.13's documented localhost URL selects HTTP/path-style S3. The native
// test transport forwards only this loopback port to the actual owned MinIO.
export const replicaUrl = "s3://krun-test-results.localhost:9000/krun-test-recovery";
const imageSchema = z.string().regex(/^localhost:5001\/krun@sha256:[a-f0-9]{64}$/);
const securityContext = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};
const templateSchema = z
  .object({
    metadata: z.unknown(),
    spec: z
      .object({
        initContainers: z.array(z.object({ name: z.string() }).passthrough()),
        containers: z.array(z.object({ name: z.string() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();
export const replicationTemplate = (value: unknown, image: string) => {
  const parsed = templateSchema.parse(value);
  const pinned = imageSchema.parse(image);
  if (
    JSON.stringify(parsed.spec.initContainers.map((c) => c.name)) !==
    JSON.stringify(["litestream-restore", "litestream", "migrate"])
  )
    throw new Error("Unexpected chart restore init order");
  const transport = {
    name: "krun-test-replica-transport",
    image: pinned,
    restartPolicy: "Always",
    securityContext,
    resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { memory: "64Mi" } },
    command: [
      "/nodejs/bin/node",
      "--input-type=module",
      "-e",
      "import net from 'node:net';const server=net.createServer(client=>{const remote=net.connect({host:'krun-test-minio.krun-test-minio.svc.cluster.local',port:9000});client.pipe(remote).pipe(client);remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy())});server.listen(9000,'127.0.0.1');",
    ],
    startupProbe: {
      exec: {
        command: [
          "/nodejs/bin/node",
          "-e",
          "const s=require('node:net').connect(9000,'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{s.destroy()});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))",
        ],
      },
      periodSeconds: 1,
      failureThreshold: 30,
    },
  };
  return {
    ...parsed,
    spec: { ...parsed.spec, initContainers: [transport, ...parsed.spec.initContainers] },
  };
};
export const recoveryHelper = (image: string, namespace: string, name: string) => {
  imageSchema.parse(image);
  z.literal("krun-test-embedded").parse(namespace);
  z.string()
    .regex(/^krun-test-restore-[a-z0-9-]+$/)
    .parse(name);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { "krun.io/e2e-recovery": "true" } },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      securityContext: {
        runAsUser: 65532,
        runAsGroup: 65532,
        runAsNonRoot: true,
        fsGroup: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "remove-owned-database",
          image,
          securityContext,
          resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { memory: "64Mi" } },
          command: [
            "/nodejs/bin/node",
            "-e",
            "const fs=require('node:fs');const paths=['/data/krun.db','/data/krun.db-wal','/data/krun.db-shm'];if(!fs.lstatSync(paths[0]).isFile())throw Error('Missing regular owned database');for(const p of paths){if(fs.existsSync(p)&&!fs.lstatSync(p).isFile())throw Error('Nonregular owned database file')}for(const p of paths)fs.rmSync(p,{force:true});for(const p of paths.slice(1))fs.writeFileSync(p,'krun-test-orphan');if(fs.existsSync(paths[0])||!paths.slice(1).every(p=>fs.existsSync(p)))throw Error('Removal witness failed');console.log('krun-test-database-removed-orphans-present');",
          ],
          volumeMounts: [{ name: "data", mountPath: "/data" }],
        },
      ],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-e2e-0" } }],
    },
  };
};

type RecoveryObject = {
  kind: string;
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  [key: string]: unknown;
};
export const ownedRecoveryResource = (
  identity: {
    kind: "Pod" | "Secret";
    name: string;
    namespace: string;
    owner: string;
    invocation: string;
  },
  io: { create(value: RecoveryObject): void; read(): unknown; delete(uid: string): void },
) => {
  z.literal("krun-test-embedded").parse(identity.namespace);
  z.string()
    .regex(/^krun-test-[a-z0-9-]+$/)
    .parse(identity.name);
  z.string()
    .regex(/^[a-f0-9]{16}$/)
    .parse(identity.owner);
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(identity.invocation);
  const labels = {
    "krun.io/e2e-owner": identity.owner,
    "krun.io/e2e-recovery-invocation": identity.invocation,
  };
  let attempted = false;
  let acknowledged = false;
  let uid: string | undefined;
  const read = () => {
    const value = io.read();
    if (value === undefined || value === null) return undefined;
    const parsed = z
      .object({
        kind: z.string(),
        metadata: z.object({
          name: z.string(),
          namespace: z.string(),
          uid: z.string().min(1),
          labels: z.record(z.string(), z.string()),
        }),
      })
      .safeParse(value);
    if (
      !parsed.success ||
      parsed.data.kind !== identity.kind ||
      parsed.data.metadata.name !== identity.name ||
      parsed.data.metadata.namespace !== identity.namespace ||
      Object.entries(labels).some(([key, value]) => parsed.data.metadata.labels[key] !== value) ||
      (uid !== undefined && parsed.data.metadata.uid !== uid)
    )
      throw new Error("Refusing unproven or replaced recovery resource");
    uid = parsed.data.metadata.uid;
    return parsed.data.metadata;
  };
  return {
    create(value: RecoveryObject) {
      if (
        attempted ||
        value.kind !== identity.kind ||
        value.metadata.name !== identity.name ||
        value.metadata.namespace !== identity.namespace
      )
        throw new Error("Invalid recovery create identity");
      // Intent precedes the RPC: a failed client result does not mean no commit.
      attempted = true;
      io.create({
        ...value,
        metadata: { ...value.metadata, labels: { ...value.metadata.labels, ...labels } },
      });
      acknowledged = true;
      if (!read()) throw new Error("Acknowledged recovery resource not observed");
    },
    async remove() {
      if (!attempted) return;
      const live = read();
      if (!live) {
        // Without an ack or an observed committed UID, a not-found read cannot
        // fence a delayed create. The caller must not restart the PVC workload.
        if (!acknowledged && uid === undefined)
          throw new Error("Unresolved recovery create outcome");
        return;
      }
      let deleteFailed = false;
      try {
        io.delete(live.uid);
      } catch {
        deleteFailed = true;
      }
      const remaining = read();
      if (!remaining) return;
      if (deleteFailed) throw new Error("Recovery resource deletion unresolved");
      await eventually(
        async () => read(),
        (value) => (value === undefined ? "done" : "wait"),
        "Positive owned recovery resource absence",
        60_000,
      );
    },
  };
};
