import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { publicSchemas } from "../../../apps/gateway/src/public-contracts.js";
import { chartLayout, type DatabaseMode, release } from "./chart.js";
import { contextArgs, probeVerdict } from "./contracts.js";
import { securityFailure, securityKey, securityProbe } from "./security.js";
import { eventually } from "./wait.js";

type Run = z.infer<typeof publicSchemas.Run>;
type Scope = {
  name: string;
  namespace: string;
  jobsNamespace: string;
  kubeconfig: string;
  url: string;
  key: string;
  mode: DatabaseMode;
  kube: (args: string[], operation: string, input?: string) => string;
  live: (run: Run) => void;
  pod: (run: Run) => Promise<string>;
  privateYaml: (content: string) => void;
};
const check = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const decode = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid private security witness");
  return parsed.data;
};
const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid private security JSON");
  }
};
const projection = z.object({
  metadata: z.object({ generation: z.number() }),
  spec: z.record(z.string(), z.unknown()),
  status: z
    .object({
      observedGeneration: z.number().optional(),
      conditions: z
        .array(z.object({ type: z.string(), status: z.string(), reason: z.string() }))
        .optional(),
    })
    .optional(),
});
const serving = z.object({
  items: z.array(
    z.object({
      metadata: z.object({
        name: z.string(),
        labels: z.record(z.string(), z.string()),
        deletionTimestamp: z.string().optional(),
      }),
      spec: z.object({ containers: z.array(z.object({ name: z.string() })) }),
      status: z.object({ podIP: z.ipv4() }),
    }),
  ),
});
const nodeProbe = `import net from "node:net";import {readFileSync} from "node:fs";
const p=JSON.parse(readFileSync(0,"utf8"));const s=net.connect(p);s.setTimeout(1500);
s.once("connect",()=>{console.log("krun-probe-open");s.destroy()});
s.once("timeout",()=>{console.log("krun-probe-blocked");s.destroy();process.exitCode=28});
s.once("error",()=>{process.exitCode=29});`;
const curlProbe = `IFS=' ' read -r host port
value=$(curl -sS --connect-timeout 1.5 --max-time 2 -o /dev/null -w '%{time_connect}' "http://$host:$port/healthz" 2>/dev/null)
code=$?
printf 'krun-security-probe:%s:%s' "$code" "$value"`;
const jobInput = `IFS= read -r id
curl -sS --max-time 3 -H "Authorization: Bearer $KRUN_TOKEN" "$KRUN_GATEWAY_URL/internal/v1/runs/$id/input" -w '\nkrun-security-status:%{http_code}'`;

export const securityAcceptance = (scope: Scope) => {
  const layout = chartLayout(scope.mode);
  const functions = new Set<string>();
  const unexpectedRuns: { run: Run; key: string }[] = [];
  const control = `${scope.name}-control`;
  let controlCreated = false;
  const ownerKey = securityKey(scope.key, "owner");
  const otherKey = securityKey(scope.key, "other");
  const readFunction = (name: string) =>
    decode(
      projection,
      json(
        scope.kube(
          ["get", "function", name, "-n", scope.namespace, "-o", "json"],
          "Read owned security Function",
        ),
      ),
    );
  const request = async (path: string, key: string, method = "GET", body?: unknown) => {
    let response: Response;
    try {
      response = await fetch(`${scope.url}/v1/${path}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("Security public transport failed");
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Security reply was not JSON");
    }
    check(
      response.headers.get("content-type")?.startsWith("application/json"),
      "Security reply media type differs",
    );
    if (method === "POST" && path.endsWith("/runs")) {
      const created = publicSchemas.Run.safeParse(value);
      if (created.success) {
        const parent = path.slice("functions/".length, -"/runs".length);
        const creator =
          key === ownerKey
            ? "e2e-security-owner"
            : key === otherKey
              ? "e2e-security-other"
              : undefined;
        check(
          response.status === 201 &&
            creator !== undefined &&
            (parent === scope.name || functions.has(parent)) &&
            created.data.name.slice(0, created.data.name.lastIndexOf("/")) === path &&
            created.data.createdBy === creator,
          "Create response is outside the exact owned admission boundary",
        );
        if (parent === scope.name) scope.live(created.data);
        else unexpectedRuns.push({ run: created.data, key });
      }
    }
    return { status: response.status, body: value };
  };
  const getOwned = async (run: Run, key: string) => {
    const reply = await request(run.name, key);
    check(reply.status === 200, "Positive owned Run read failed");
    const value = decode(publicSchemas.Run, reply.body);
    check(
      value.name === run.name && ["QUEUED", "SCHEDULED", "RUNNING"].includes(value.state),
      "Positive Run identity/lifetime differs",
    );
  };
  const create = async (key: string, input: unknown) => {
    const reply = await request(`functions/${scope.name}/runs`, key, "POST", { input });
    check(reply.status === 201, "Positive security Run admission failed");
    const run = decode(publicSchemas.Run, reply.body);
    await eventually(
      async () => request(run.name, key),
      (reply) => {
        if (reply.status !== 200) return "fail";
        const current = decode(publicSchemas.Run, reply.body);
        return current.state === "RUNNING" && current.runtimeStatus?.message === "holding"
          ? "done"
          : ["SUCCEEDED", "FAILED", "CANCELLED"].includes(current.state)
            ? "fail"
            : "wait";
      },
      "Live security producer with accepted input/status",
    );
    return run;
  };
  const jobRead = (pod: string, id: string) => {
    decode(z.uuidv7(), id);
    const text = scope.kube(
      [
        "exec",
        "-i",
        "-n",
        scope.jobsNamespace,
        pod,
        "-c",
        "function",
        "--",
        "/bin/sh",
        "-c",
        jobInput,
      ],
      "Actual Job token request",
      `${id}\n`,
    );
    const marker = "\nkrun-security-status:";
    const index = text.lastIndexOf(marker);
    check(index >= 0, "Job token reply lacks its HTTP witness");
    const status = decode(z.string().regex(/^\d{3}$/), text.slice(index + marker.length).trim());
    return { status: Number(status), body: json(text.slice(0, index)) };
  };
  const controlProbe = (host: string, port: number, database: boolean) => {
    const result = spawnSync(
      "kubectl",
      [
        ...contextArgs(scope.kubeconfig),
        "exec",
        "-i",
        "-n",
        database ? scope.namespace : layout.monitoringNamespace,
        database ? layout.gateway : control,
        ...(database ? ["-c", "gateway"] : []),
        "--",
        "/nodejs/bin/node",
        "--input-type=module",
        "-e",
        nodeProbe,
      ],
      {
        input: JSON.stringify({ host, port }),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (result.error) throw new Error("Positive security probe transport failed");
    check(
      probeVerdict({ code: result.status, stdout: result.stdout ?? "" }) === "open",
      "Security destination lacks a positive live listener",
    );
  };
  const applyFunction = (name: string, spec: Record<string, unknown>) => {
    functions.add(name);
    scope.kube(
      ["apply", "-f", "-"],
      "Apply owned security Function",
      JSON.stringify({
        apiVersion: "krun.io/v1alpha1",
        kind: "Function",
        metadata: { name, namespace: scope.namespace },
        spec,
      }),
    );
  };
  return {
    async run(firstInput: unknown, secondInput: unknown) {
      const base = readFunction(scope.name);
      const first = await create(ownerKey, firstInput);
      const second = await create(otherKey, secondInput);
      const firstPod = await scope.pod(first);
      const secondPod = await scope.pod(second);
      for (const pod of [firstPod, secondPod])
        scope.privateYaml(
          scope.kube(
            ["get", "pod", pod, "-n", scope.jobsNamespace, "-o", "yaml"],
            "Read actual Job Pod YAML privately",
          ),
        );
      for (const [run, key, foreign] of [
        [first, ownerKey, otherKey],
        [second, otherKey, ownerKey],
      ] as const) {
        await getOwned(run, key);
        securityFailure(await request(run.name, foreign), "RUN_NOT_FOUND");
        await getOwned(run, key);
      }
      for (const [pod, own, foreign, input] of [
        [firstPod, first, second, firstInput],
        [secondPod, second, first, secondInput],
      ] as const) {
        const ownId = own.name.split("/").at(-1) ?? "";
        const foreignId = foreign.name.split("/").at(-1) ?? "";
        const before = jobRead(pod, ownId);
        check(
          before.status === 200 && isDeepStrictEqual(before.body, input),
          "Positive own-token input differs",
        );
        securityFailure(jobRead(pod, foreignId), "TOKEN_INVALID");
        const after = jobRead(pod, ownId);
        check(
          after.status === 200 && isDeepStrictEqual(after.body, input),
          "Own token stopped working after cross-run denial",
        );
      }
      securityFailure(
        await request(`functions/${scope.name}/runs`, ownerKey, "POST", {
          input: firstInput,
          callback: { url: "http://10.0.0.1/hook" },
        }),
        "CALLBACK_NOT_ALLOWED",
      );

      for (const [suffix, patch, reason] of [
        ["schema", { inputSchema: { $ref: "#/$defs/krunMissingDefinition" } }, "SchemaInvalid"],
        ["account", { serviceAccountName: `${scope.name}-forbidden` }, "ServiceAccountNotAllowed"],
      ] as const) {
        const name = `${scope.name}-${suffix}`;
        applyFunction(name, { ...base.spec, ...patch });
        await eventually(
          async () => readFunction(name),
          (fn) => {
            if (fn.status?.observedGeneration !== fn.metadata.generation) return "wait";
            const ready = fn.status.conditions?.find((c) => c.type === "Ready");
            return !ready
              ? "wait"
              : ready.status === "False" && ready.reason === reason
                ? "done"
                : "fail";
          },
          "Current-generation rejected Function condition",
        );
        securityFailure(
          await request(`functions/${name}/runs`, ownerKey, "POST", { input: firstInput }),
          "FUNCTION_NOT_FOUND",
        );
      }
      const tagged = `${scope.name}-tag`;
      functions.add(tagged);
      const image = decode(z.string(), base.spec.image);
      for (const dry of [true, false]) {
        const result = spawnSync(
          "kubectl",
          [
            ...contextArgs(scope.kubeconfig),
            "apply",
            ...(dry ? ["--dry-run=server"] : []),
            "-f",
            "-",
          ],
          {
            input: JSON.stringify({
              apiVersion: "krun.io/v1alpha1",
              kind: "Function",
              metadata: { name: tagged, namespace: scope.namespace },
              spec: { ...base.spec, image: `${image.split("@")[0]}:e2e` },
            }),
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        check(
          !result.error &&
            result.status !== 0 &&
            result.stderr.includes("image must contain @sha256:"),
          "Tag-only Function lacks actual CRD validation denial",
        );
      }
      check(
        !scope
          .kube(
            ["get", "function", tagged, "-n", scope.namespace, "--ignore-not-found", "-o", "name"],
            "Read rejected Function absence",
          )
          .trim(),
        "Rejected tag-only Function exists",
      );

      controlCreated = true;
      scope.kube(
        ["apply", "-f", "-"],
        "Create owned restricted positive-control Pod",
        JSON.stringify({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: control, namespace: layout.monitoringNamespace },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "control",
                image: scope.kube(
                  [
                    "get",
                    "pod",
                    "-n",
                    scope.namespace,
                    "-l",
                    "krun.io/gateway=true",
                    "-o",
                    "jsonpath={.items[0].spec.containers[0].image}",
                  ],
                  "Read actual chart platform digest",
                ),
                command: [
                  "/nodejs/bin/node",
                  "-e",
                  "const s=require('node:net').createServer(c=>c.end()).listen(0,'127.0.0.1');process.once('SIGTERM',()=>s.close())",
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { cpu: "500m", memory: "128Mi" },
                },
              },
            ],
          },
        }),
      );
      scope.kube(
        [
          "wait",
          "pod",
          control,
          "-n",
          layout.monitoringNamespace,
          "--for=condition=Ready",
          "--timeout=90s",
        ],
        "Await security control Pod readiness",
      );
      const pods = decode(
        serving,
        json(
          scope.kube(
            [
              "get",
              "pods",
              "-n",
              scope.namespace,
              "-l",
              `app.kubernetes.io/instance=${release},app.kubernetes.io/name=krun,app.kubernetes.io/component in (embedded,gateway,scheduler)`,
              "-o",
              "json",
            ],
            "Read actual serving endpoint identities",
          ),
        ),
      ).items.filter((pod) => !pod.metadata.deletionTimestamp);
      const targets: { host: string; port: number; database: boolean }[] = [];
      for (const pod of pods) {
        if (pod.metadata.labels["krun.io/gateway"] === "true")
          targets.push({ host: pod.status.podIP, port: 8080, database: false });
        for (const container of pod.spec.containers)
          targets.push({
            host: pod.status.podIP,
            port: container.name === "scheduler" && scope.mode === "embedded" ? 9091 : 9090,
            database: false,
          });
      }
      check(
        targets.length === (scope.mode === "embedded" ? 3 : 6),
        "Serving endpoint inventory is incomplete",
      );
      if (scope.mode === "postgres") {
        const db = decode(
          z.object({
            items: z.array(z.object({ status: z.object({ podIP: z.ipv4() }) })).length(1),
          }),
          json(
            scope.kube(
              [
                "get",
                "pods",
                "-n",
                scope.namespace,
                "-l",
                "app.kubernetes.io/name=krun-test-postgres",
                "-o",
                "json",
              ],
              "Read actual database endpoint",
            ),
          ),
        ).items[0];
        check(db, "Database endpoint is absent");
        targets.push({ host: db?.status.podIP ?? "", port: 5432, database: true });
      } else {
        const volume = json(
          scope.kube(
            ["get", "pod", firstPod, "-n", scope.jobsNamespace, "-o", "json"],
            "Read embedded isolation volumes",
          ),
        );
        const parsed = decode(
          z.object({
            spec: z.object({
              volumes: z
                .array(
                  z.object({
                    persistentVolumeClaim: z.unknown().optional(),
                    hostPath: z.unknown().optional(),
                  }),
                )
                .optional(),
            }),
          }),
          volume,
        );
        check(
          !parsed.spec.volumes?.some(
            (v) => v.persistentVolumeClaim !== undefined || v.hostPath !== undefined,
          ),
          "Job can access embedded database storage",
        );
      }
      const firstId = first.name.split("/").at(-1) ?? "";
      const gateway = decode(
        z.object({
          spec: z.object({
            containers: z.array(
              z.object({
                name: z.string(),
                env: z
                  .array(z.object({ name: z.string(), value: z.string().optional() }))
                  .optional(),
              }),
            ),
          }),
        }),
        json(
          scope.kube(
            ["get", "pod", firstPod, "-n", scope.jobsNamespace, "-o", "json"],
            "Read positive internal Job destination",
          ),
        ),
      );
      check(
        gateway.spec.containers.some(
          (c) =>
            c.name === "function" &&
            c.env?.some((e) => e.name === "KRUN_RUN_ID" && e.value === firstId),
        ),
        "Network source is not the actual owned Job",
      );
      for (const target of targets) {
        controlProbe(target.host, target.port, target.database);
        const outcome = scope.kube(
          [
            "exec",
            "-i",
            "-n",
            scope.jobsNamespace,
            firstPod,
            "-c",
            "function",
            "--",
            "/bin/sh",
            "-c",
            curlProbe,
          ],
          "Actual Job forbidden endpoint probe",
          `${target.host} ${target.port}\n`,
        );
        check(securityProbe(outcome) === "blocked", "Actual Job reached a forbidden live endpoint");
        controlProbe(target.host, target.port, target.database);
      }
      console.log(
        JSON.stringify({
          scenario: "security",
          mode: scope.mode,
          yamlPrivacyWitnesses: 2,
          validOwnTokenControls: 4,
          crossRunTokenDenied: 2,
          ownKeyReadControls: 4,
          crossKeyRunDenied: 2,
          tagOnlyFunctionRejected: true,
          rejectedFunctionAbsent: true,
          nonCompilingSchemaReadyFalse: true,
          forbiddenServiceAccountReadyFalse: true,
          function404Opaque: true,
          privateCallbackRejected: true,
          blockedLiveEndpoints: targets.length,
          databaseTcpDenied: scope.mode === "postgres",
          embeddedDatabaseVolumeAbsent: scope.mode === "embedded",
          actualJobSource: true,
          positiveListenerControls: targets.length * 2,
        }),
      );
    },
    async close() {
      const failures: string[] = [];
      for (const { run, key } of unexpectedRuns) {
        try {
          const witness = (reply: { status: number; body: unknown }) => {
            check(reply.status === 200, "Owned unexpected Run cleanup request failed");
            const value = decode(publicSchemas.Run, reply.body);
            check(
              value.name === run.name && value.createdBy === run.createdBy,
              "Owned unexpected Run cleanup identity changed",
            );
            return value;
          };
          const terminal = (value: Run) =>
            ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state);
          const before = witness(await request(run.name, key));
          if (!terminal(before)) {
            const cancelled = witness(await request(`${run.name}:cancel`, key, "POST", {}));
            check(
              cancelled.state === "CANCELLING" || terminal(cancelled),
              "Owned unexpected Run cancellation was not accepted",
            );
          }
          await eventually(
            async () => request(run.name, key),
            (reply) => (terminal(witness(reply)) ? "done" : "wait"),
            "Owned unexpected Run terminal readback",
            45_000,
          );
          const id = run.name.split("/").at(-1);
          const parent = run.name.split("/")[1];
          await eventually(
            async () =>
              json(
                scope.kube(
                  [
                    "get",
                    "jobs,secrets",
                    "-n",
                    scope.jobsNamespace,
                    "-l",
                    `krun.io/function-name=${parent},krun.io/run-id=${id}`,
                    "-o",
                    "json",
                  ],
                  "Read owned unexpected Run cleanup inventory",
                ),
              ),
            (value) =>
              decode(z.object({ items: z.array(z.unknown()) }), value).items.length === 0
                ? "done"
                : "wait",
            "Owned unexpected Run Job and Secret cleanup",
            45_000,
          );
        } catch {
          failures.push("unexpected-run");
        }
      }
      for (const name of functions) {
        try {
          scope.kube(
            [
              "delete",
              "function",
              name,
              "-n",
              scope.namespace,
              "--ignore-not-found",
              "--wait=true",
              "--timeout=60s",
            ],
            "Clean owned rejected Function",
          );
          check(
            !scope
              .kube(
                [
                  "get",
                  "function",
                  name,
                  "-n",
                  scope.namespace,
                  "--ignore-not-found",
                  "-o",
                  "name",
                ],
                "Read back rejected Function cleanup",
              )
              .trim(),
            "Rejected Function cleanup failed",
          );
        } catch {
          failures.push("function");
        }
      }
      if (controlCreated) {
        try {
          scope.kube(
            [
              "delete",
              "pod",
              control,
              "-n",
              layout.monitoringNamespace,
              "--ignore-not-found",
              "--wait=true",
              "--timeout=60s",
            ],
            "Clean owned security control",
          );
          check(
            !scope
              .kube(
                [
                  "get",
                  "pod",
                  control,
                  "-n",
                  layout.monitoringNamespace,
                  "--ignore-not-found",
                  "-o",
                  "name",
                ],
                "Read back security control cleanup",
              )
              .trim(),
            "Security control cleanup failed",
          );
        } catch {
          failures.push("control");
        }
      }
      check(failures.length === 0, "Owned security cleanup failed; private diagnostics withheld");
    },
  };
};
