import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { chartLayout, databaseMode, release } from "./chart.js";
import { chartAcceptance } from "./chart-harness.js";
import { contextArgs, parsePushDigest } from "./contracts.js";
import {
  litestreamImage,
  ownedRecoveryResource,
  recoveryHelper,
  replicationTemplate,
  replicaUrl,
} from "./recovery.js";
import { eventually } from "./wait.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const directory = join(tmpdir(), `krun-test-e2e-${owner}`);
const requireValue = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
export const recoveryAcceptance = () => {
  const state = z
    .object({
      owner: z.literal(owner),
      mode: databaseMode,
      image: z.string().regex(/^localhost:5001\/krun@sha256:[a-f0-9]{64}$/),
      minioSecrets: z.tuple([z.string(), z.string()]),
    })
    .parse(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")));
  const config = join(directory, "kubeconfig");
  const kubeConfig = z
    .object({
      "current-context": z.literal("kind-krun-test-e2e"),
      clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
    })
    .parse(parse(readFileSync(config, "utf8")));
  requireValue(
    ["127.0.0.1", "localhost"].includes(
      new URL(kubeConfig.clusters[0]?.cluster.server ?? "").hostname,
    ),
    "Foreign recovery cluster",
  );
  const layout = chartLayout(state.mode);
  const run = (exe: string, args: string[], operation: string, input?: string) => {
    const result = spawnSync(exe, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (result.error || result.status !== 0)
      throw new Error(`${operation} failed; private output withheld`);
    return result.stdout;
  };
  const kube = (args: string[], label: string, input?: string) =>
    run("kubectl", [...contextArgs(config), ...args], label, input);
  const patchTemplate = (template: unknown, label: string) => {
    const file = join(directory, `krun-test-recovery-patch-${randomBytes(6).toString("hex")}.json`);
    writeFileSync(file, JSON.stringify({ spec: { template } }), { flag: "wx", mode: 0o600 });
    try {
      return kube(
        [
          "patch",
          "statefulset",
          release,
          "-n",
          layout.namespace,
          "--type=merge",
          "--patch-file",
          file,
        ],
        label,
      );
    } finally {
      rmSync(file);
    }
  };
  const helm = (args: string[], label: string) =>
    run(
      "helm",
      [
        ...args,
        "--kubeconfig",
        config,
        "--kube-context",
        "kind-krun-test-e2e",
        "--namespace",
        layout.namespace,
      ],
      label,
    );
  const create = (value: unknown) =>
    kube(["create", "-f", "-"], "Create fresh owned recovery fixture", JSON.stringify(value));
  const podName = `${release}-0`;
  const readSet = () =>
    z
      .object({
        metadata: z.object({ name: z.literal(release), labels: z.record(z.string(), z.string()) }),
        spec: z.object({
          replicas: z.number(),
          template: z.unknown(),
          volumeClaimTemplates: z.array(z.object({ metadata: z.object({ name: z.string() }) })),
        }),
      })
      .parse(
        JSON.parse(
          kube(
            ["get", "statefulset", release, "-n", layout.namespace, "-o", "json"],
            "Read exact owned recovery StatefulSet",
          ),
        ),
      );
  const assertNamespace = () => {
    const namespace = z
      .object({ metadata: z.object({ labels: z.record(z.string(), z.string()) }) })
      .parse(
        JSON.parse(
          kube(
            ["get", "namespace", layout.namespace, "-o", "json"],
            "Read owned recovery namespace",
          ),
        ),
      );
    requireValue(
      namespace.metadata.labels["krun.io/e2e-owner"] === owner,
      "Foreign recovery namespace owner",
    );
  };
  const getPods = () =>
    z
      .object({
        items: z.array(
          z.object({
            metadata: z.object({ name: z.string(), uid: z.string() }),
            status: z
              .object({
                phase: z.string(),
                conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
              })
              .optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          kube(
            [
              "get",
              "pods",
              "-n",
              layout.namespace,
              "-l",
              `app.kubernetes.io/instance=${release},app.kubernetes.io/component=embedded`,
              "-o",
              "json",
            ],
            "Observe owned serving Pod presence",
          ),
        ),
      ).items;
  return {
    assertPostgresIsolation() {
      requireValue(state.mode === "postgres", "Postgres-only isolation check");
      assertNamespace();
      const objects = kube(
        ["get", "statefulset", release, "-n", layout.namespace, "--ignore-not-found", "-o", "name"],
        "Verify no embedded StatefulSet in Postgres",
      );
      requireValue(
        !objects.trim(),
        "Embedded recovery storage unexpectedly exists in Postgres mode",
      );
      console.log(
        JSON.stringify({
          scenario: "operations_restore",
          mode: "postgres",
          embeddedStatefulSetAbsent: true,
          destructiveDrillNotApplicable: true,
        }),
      );
    },
    async restore(id: string) {
      requireValue(state.mode === "embedded", "Restore drill requires embedded mode");
      z.uuid().parse(id);
      assertNamespace();
      const initial = readSet();
      requireValue(
        initial.metadata.labels["app.kubernetes.io/instance"] === release &&
          initial.spec.replicas === 1 &&
          initial.spec.volumeClaimTemplates.map((v) => v.metadata.name).join() === "data",
        "Unexpected recovery StatefulSet/PVC identity",
      );
      const initialPods = getPods();
      requireValue(
        initialPods.length === 1 && initialPods[0]?.metadata.name === podName,
        "Missing positive serving Pod witness",
      );
      const history = z
        .array(z.object({ revision: z.number() }))
        .min(1)
        .parse(JSON.parse(helm(["history", release, "-o", "json"], "Read original Helm revision")));
      const revision = history.at(-1)?.revision;
      requireValue(revision, "Missing original Helm revision");
      const invocation = randomBytes(16).toString("hex");
      const helperName = `krun-test-restore-${invocation.slice(0, 10)}`;
      const secretName = `krun-test-litestream-${invocation.slice(0, 10)}`;
      const resource = (kind: "Pod" | "Secret", name: string) =>
        ownedRecoveryResource(
          { kind, name, namespace: layout.namespace, owner, invocation },
          {
            create,
            read: () => {
              const text = kube(
                [
                  "get",
                  kind.toLowerCase(),
                  name,
                  "-n",
                  layout.namespace,
                  "--ignore-not-found",
                  "-o",
                  "json",
                ],
                "Reconcile exact recovery resource identity",
              );
              return text.trim() ? (JSON.parse(text) as unknown) : undefined;
            },
            delete: (uid) => {
              const file = join(
                directory,
                `krun-test-recovery-delete-${randomBytes(6).toString("hex")}.json`,
              );
              writeFileSync(
                file,
                JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } }),
                { flag: "wx", mode: 0o600 },
              );
              try {
                kube(
                  [
                    "delete",
                    "--raw",
                    `/api/v1/namespaces/${layout.namespace}/${kind === "Pod" ? "pods" : "secrets"}/${name}`,
                    "--filename",
                    file,
                  ],
                  "Delete only UID-fenced recovery resource",
                );
              } finally {
                rmSync(file);
              }
            },
          },
        );
      const helperResource = resource("Pod", helperName);
      const secretResource = resource("Secret", secretName);
      let modified = false;
      let scaledDown = false;
      const started = performance.now();
      let backupSeconds = 0;
      let downtimeSeconds = 0;
      let failure: unknown;
      const failures: string[] = [];
      try {
        // Mirror only the generated disposable fixture credentials through a
        // dedicated Litestream Secret reference; never put values in argv/logs.
        secretResource.create({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: secretName, namespace: layout.namespace },
          stringData: {
            LITESTREAM_ACCESS_KEY_ID: state.minioSecrets[0],
            LITESTREAM_SECRET_ACCESS_KEY: state.minioSecrets[1],
          },
        });
        run("docker", ["pull", litestreamImage], "Pull digest-pinned actual Litestream");
        run(
          "docker",
          ["tag", litestreamImage, "localhost:5001/krun-test-litestream:e2e"],
          "Tag test-only Litestream mirror",
        );
        const pushed = run(
          "docker",
          ["push", "localhost:5001/krun-test-litestream:e2e"],
          "Push test-only Litestream mirror",
        );
        const pinned = `localhost:5001/krun-test-litestream@${parsePushDigest(pushed)}`;
        modified = true;
        helm(
          [
            "upgrade",
            release,
            "deploy/helm/krun",
            "--reuse-values",
            "--set-json",
            JSON.stringify({
              db: {
                embedded: {
                  litestream: {
                    enabled: true,
                    image: pinned,
                    url: replicaUrl,
                    existingSecret: secretName,
                  },
                },
              },
            }),
          ],
          "Enable actual chart restore and native replication",
        );
        const set = readSet();
        const template = replicationTemplate(set.spec.template, state.image);
        patchTemplate(template, "Attach test-only localhost S3 transport before restore");
        kube(
          [
            "delete",
            "pod",
            podName,
            "-n",
            layout.namespace,
            "--ignore-not-found",
            "--wait=true",
            "--timeout=60s",
          ],
          "Replace only owned Pod with complete test transport template",
        );
        await chartAcceptance().waitReady(new Set(initialPods.map((p) => p.metadata.uid)));
        const backupStarted = performance.now();
        await eventually(
          async () => {
            kube(
              [
                "exec",
                "-n",
                layout.namespace,
                podName,
                "-c",
                "litestream",
                "--",
                "/bin/sh",
                "-ec",
                'rm -f /tmp/krun-test-replica-proof.db; litestream restore -if-replica-exists -o /tmp/krun-test-replica-proof.db "$1"',
                "krun-test-backup-witness",
                replicaUrl,
              ],
              "Restore independent S3 replica witness",
            );
            const answer = kube(
              [
                "exec",
                "-i",
                "-n",
                layout.namespace,
                podName,
                "-c",
                "gateway",
                "--",
                "/nodejs/bin/node",
                "--input-type=module",
                "-e",
                "import {readFileSync,existsSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';const p=JSON.parse(readFileSync(0,'utf8'));if(!existsSync('/tmp/krun-test-replica-proof.db'))console.log('wait');else{const db=new DatabaseSync('/tmp/krun-test-replica-proof.db');try{console.log(db.prepare('select count(*) as n from runs where id=?').get(p.id).n===1?'readable':'wait')}finally{db.close()}}",
              ],
              "Read retained Run from independent restored database",
              JSON.stringify({ id }),
            );
            return answer.trim();
          },
          (answer) =>
            answer === "readable"
              ? "done"
              : answer === "wait"
                ? "wait"
                : (() => {
                    throw new Error("Invalid replica readback witness");
                  })(),
          "Pre-drill Run durably present in actual S3 replica",
          120_000,
        );
        backupSeconds = (performance.now() - backupStarted) / 1000;
        const before = getPods();
        requireValue(before.length === 1, "Missing pre-delete Pod witness");
        const downtimeStarted = performance.now();
        scaledDown = true;
        kube(
          ["scale", "statefulset", release, "-n", layout.namespace, "--replicas=0"],
          "Stop exact owned embedded workload",
        );
        await eventually(
          async () => getPods(),
          (pods) => (pods.length === 0 ? "done" : "wait"),
          "Confirmed serving Pod absence before touching PVC",
          120_000,
        );
        helperResource.create(recoveryHelper(state.image, layout.namespace, helperName));
        await eventually(
          async () =>
            z
              .object({ status: z.object({ phase: z.string() }) })
              .parse(
                JSON.parse(
                  kube(
                    ["get", "pod", helperName, "-n", layout.namespace, "-o", "json"],
                    "Observe exact destructive helper",
                  ),
                ),
              ).status.phase,
          (phase) => {
            if (phase === "Failed") throw new Error("Owned database removal helper failed");
            return phase === "Succeeded" ? "done" : "wait";
          },
          "Positive primary DB removal and orphan WAL/SHM witness",
          120_000,
        );
        requireValue(
          kube(
            ["logs", helperName, "-n", layout.namespace],
            "Read safe database removal witness",
          ).trim() === "krun-test-database-removed-orphans-present",
          "Missing positive database removal witness",
        );
        await helperResource.remove();
        kube(
          ["scale", "statefulset", release, "-n", layout.namespace, "--replicas=1"],
          "Start chart's real restore init and replication",
        );
        scaledDown = false;
        const restored = await chartAcceptance().waitReady(
          new Set(before.map((p) => p.metadata.uid)),
        );
        requireValue(
          restored.length === 1 && restored[0]?.metadata.name === podName,
          "Unexpected restored serving identity",
        );
        downtimeSeconds = (performance.now() - downtimeStarted) / 1000;
        requireValue(downtimeSeconds < 86400, "Restore downtime exceeds finished-Job TTL");
      } catch (error) {
        try {
          writeFileSync(
            join(directory, "recovery-failure-pods.json"),
            kube(
              ["get", "pods", "-n", layout.namespace, "-o", "json"],
              "Private restore diagnostics",
            ),
            { mode: 0o600 },
          );
        } catch {
          /* Preserve original failure; cleanup still runs below. */
        }
        failure = error;
      } finally {
        let helperAbsent = true;
        try {
          await helperResource.remove();
        } catch {
          helperAbsent = false;
          failures.push("helper-absence-unproven");
          // Neither a Helm rollback nor scale-one may race an uncertain PVC writer.
          try {
            kube(
              ["scale", "statefulset", release, "-n", layout.namespace, "--replicas=0"],
              "Keep workload stopped while helper absence is unproven",
            );
          } catch {
            failures.push("stop");
          }
        }
        if (helperAbsent && scaledDown) {
          try {
            kube(
              ["scale", "statefulset", release, "-n", layout.namespace, "--replicas=1"],
              "Recovery failure workload restart",
            );
          } catch {
            failures.push("scale");
          }
        }
        if (helperAbsent && modified) {
          try {
            helm(
              ["rollback", release, String(revision), "--timeout=240s"],
              "Restore exact original chart revision",
            );
            patchTemplate(
              initial.spec.template,
              "Remove test transport and restore original Pod template",
            );
            kube(
              [
                "delete",
                "pod",
                podName,
                "-n",
                layout.namespace,
                "--ignore-not-found",
                "--wait=true",
                "--timeout=60s",
              ],
              "Converge exact restored template even after an interrupted init",
            );
            await chartAcceptance().waitReady();
            requireValue(
              isDeepStrictEqual(readSet().spec.template, initial.spec.template),
              "Original chart template was not restored exactly",
            );
          } catch {
            failures.push("chart");
          }
        }
        try {
          await secretResource.remove();
        } catch {
          failures.push("secret");
        }
      }
      if (failures.length)
        throw new AggregateError(
          [
            ...(failure === undefined ? [] : [failure]),
            new Error(`Owned recovery cleanup failed (${failures.join(",")})`),
          ],
          "Recovery and cleanup did not fully qualify",
        );
      if (failure !== undefined) throw failure;
      return {
        replicationWitnessSeconds: backupSeconds,
        downtimeSeconds,
        drillSeconds: (performance.now() - started) / 1000,
        litestreamVersion: "0.3.13",
        originalChartRevision: revision,
      };
    },
  };
};
