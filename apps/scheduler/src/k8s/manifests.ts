import { keysFileSchema } from "@krun/shared/dist/auth/schema.js";
import { durationToMilliseconds } from "@krun/shared/dist/config/duration.js";
import type { SchedulerConfig } from "@krun/shared/dist/config/index.js";
import {
  type FunctionResource,
  functionMetadataSchema,
} from "@krun/shared/dist/functions/schema.js";
import type { Run } from "@krun/shared/dist/store/model.js";
import type { V1Job, V1ObjectMeta, V1Secret } from "@kubernetes/client-node";
import { Data, Result } from "effect";
import { z } from "zod";

export class ManifestInvalid extends Data.TaggedError("ManifestInvalid")<{
  readonly field: string;
}> {
  override get message() {
    return `Invalid manifest field: ${this.field}`;
  }
}
interface ResourceInput {
  readonly run: Pick<Run, "id" | "function_name" | "created_by">;
  readonly config: Pick<SchedulerConfig, "KRUN_JOBS_NAMESPACE">;
}
interface JobInput extends ResourceInput {
  readonly function: FunctionResource;
  readonly config: Pick<
    SchedulerConfig,
    | "KRUN_JOBS_NAMESPACE"
    | "KRUN_GATEWAY_INTERNAL_URL"
    | "KRUN_MAX_RESULT_BYTES"
    | "KRUN_TTL_AFTER_FINISHED"
    | "KRUN_JOB_HOST_USERS"
  >;
  // Supplied only by configured object-storage orchestration (P6.2). Never
  // sign, normalize or log this opaque URL inside a manifest builder.
  readonly resultUploadUrl?: string;
}
const identity = z.strictObject({
  runId: z.uuidv7().refine((value) => value === value.toLowerCase()),
  functionName: functionMetadataSchema.shape.name,
  createdBy: keysFileSchema.shape.keys.element.shape.name,
  namespace: functionMetadataSchema.shape.name,
});
const tokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  });
// Format integer milliseconds with integer arithmetic: dividing a safe integer
// by 1000 as a Number can still round away a valid millisecond at the ceiling.
const heartbeatSeconds = (millis: number) => {
  const value = BigInt(millis);
  const remainder = value % 1000n;
  const fraction =
    remainder === 0n ? "" : `.${String(remainder).padStart(3, "0").replace(/0+$/, "")}`;
  return `${value / 1000n}${fraction}`;
};
const metadata = ({
  run,
  config,
}: ResourceInput): Result.Result<
  Required<Pick<V1ObjectMeta, "name" | "namespace" | "labels">>,
  ManifestInvalid
> => {
  const parsed = identity.safeParse({
    runId: run.id,
    functionName: run.function_name,
    createdBy: run.created_by,
    namespace: config.KRUN_JOBS_NAMESPACE,
  });
  if (!parsed.success)
    return Result.fail(
      new ManifestInvalid({ field: String(parsed.error.issues[0]?.path[0] ?? "identity") }),
    );
  return Result.succeed({
    name: `krun-${run.id}`,
    namespace: config.KRUN_JOBS_NAMESPACE,
    labels: {
      "krun.io/run-id": run.id,
      "krun.io/function": run.function_name,
      "krun.io/created-by": run.created_by,
      "app.kubernetes.io/managed-by": "krun",
    },
  });
};

// Pure data constructors. Mint/adopt a token and persist its hash before Job
// creation in P4.3b; do not couple the Secret to Function/Job garbage collection.
export const buildSecret = (
  input: ResourceInput & { readonly token: string },
): Result.Result<V1Secret, ManifestInvalid> => {
  const meta = metadata(input);
  if (Result.isFailure(meta)) return Result.fail(meta.failure);
  if (!tokenSchema.safeParse(input.token).success)
    return Result.fail(new ManifestInvalid({ field: "token" }));
  return Result.succeed({
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta.success,
    immutable: true,
    type: "Opaque",
    data: { token: Buffer.from(input.token, "utf8").toString("base64") },
  });
};

export const buildJob = (input: JobInput): Result.Result<V1Job, ManifestInvalid> => {
  const meta = metadata(input);
  if (Result.isFailure(meta)) return Result.fail(meta.failure);
  if (input.function.metadata.name !== input.run.function_name)
    return Result.fail(new ManifestInvalid({ field: "functionName" }));
  const { spec } = input.function;
  const quantities = (values: Record<string, string | undefined> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
  const requests = quantities(spec.resources?.requests);
  const limits = quantities(spec.resources?.limits);
  const heartbeat =
    spec.heartbeatTimeout === undefined ? undefined : durationToMilliseconds(spec.heartbeatTimeout);
  if (spec.heartbeatTimeout !== undefined && (heartbeat === undefined || heartbeat < 30000))
    return Result.fail(new ManifestInvalid({ field: "heartbeatTimeout" }));
  return Result.succeed<V1Job>({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: meta.success,
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: spec.activeDeadlineSeconds,
      ttlSecondsAfterFinished: input.config.KRUN_TTL_AFTER_FINISHED,
      template: {
        metadata: { labels: { ...meta.success.labels } },
        spec: {
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 30,
          ...(input.config.KRUN_JOB_HOST_USERS === false ? { hostUsers: false } : {}),
          serviceAccountName: spec.serviceAccountName,
          automountServiceAccountToken: false,
          ...(spec.imagePullSecrets === undefined
            ? {}
            : { imagePullSecrets: structuredClone(spec.imagePullSecrets) }),
          ...(spec.nodeSelector === undefined
            ? {}
            : { nodeSelector: structuredClone(spec.nodeSelector) }),
          tolerations: [
            {
              key: "node.kubernetes.io/not-ready",
              operator: "Exists",
              effect: "NoExecute",
              tolerationSeconds: 60,
            },
            {
              key: "node.kubernetes.io/unreachable",
              operator: "Exists",
              effect: "NoExecute",
              tolerationSeconds: 60,
            },
          ],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: spec.runAsUser,
            runAsGroup: spec.runAsGroup,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "function",
              image: spec.image,
              imagePullPolicy: "IfNotPresent",
              ...(spec.resources === undefined
                ? {}
                : {
                    resources: {
                      ...(requests === undefined ? {} : { requests }),
                      ...(limits === undefined ? {} : { limits }),
                    },
                  }),
              env: [
                { name: "HOME", value: "/tmp" },
                { name: "KRUN_RUN_ID", value: input.run.id },
                { name: "KRUN_FUNCTION", value: input.run.function_name },
                { name: "KRUN_GATEWAY_URL", value: input.config.KRUN_GATEWAY_INTERNAL_URL },
                {
                  name: "KRUN_TOKEN",
                  valueFrom: { secretKeyRef: { name: meta.success.name, key: "token" } },
                },
                ...(input.resultUploadUrl === undefined
                  ? []
                  : [{ name: "KRUN_RESULT_UPLOAD_URL", value: input.resultUploadUrl }]),
                {
                  name: "KRUN_MAX_RESULT_BYTES",
                  value: String(input.config.KRUN_MAX_RESULT_BYTES),
                },
                ...(heartbeat === undefined
                  ? []
                  : [{ name: "KRUN_HEARTBEAT_TIMEOUT", value: heartbeatSeconds(heartbeat) }]),
                ...structuredClone(spec.env ?? []),
              ],
              ...(spec.secretRefs === undefined
                ? {}
                : { envFrom: spec.secretRefs.map((name) => ({ secretRef: { name } })) }),
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  });
};
