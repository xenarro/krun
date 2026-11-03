import { createHash } from "node:crypto";
import { z } from "zod";

export const schedulerMetricsScript =
  "try{const r=await fetch('http://127.0.0.1:'+(process.env.KRUN_ADMIN_LISTEN_ADDR??':9090').split(':').at(-1)+'/metrics',{signal:AbortSignal.timeout(2000)});if(!r.ok)process.exit(1);process.stdout.write(await r.text())}catch{process.exit(1)}";

// Separate generated test principal; never a published or production credential.
export const backpressureKey = (key: string) =>
  createHash("sha256").update(key).update("krun-test-backpressure-key").digest("hex");
export const admissionVerdict = (
  status: number,
  retryAfter: string | null,
  body: unknown,
  limit: "function" | "key",
) => {
  const result = z
    .object({
      error: z.object({
        code: z.literal(429),
        status: z.literal("RESOURCE_EXHAUSTED"),
        message: z.string(),
        details: z.array(
          z.object({
            "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
            domain: z.literal("krun.io"),
            reason: z.literal("QUEUE_FULL"),
            metadata: z.object({ limit: z.literal(limit) }),
          }),
        ),
      }),
    })
    .safeParse(body);
  if (
    status !== 429 ||
    retryAfter !== "1" ||
    !result.success ||
    result.data.error.details.length !== 1
  )
    throw new Error("Invalid backpressure admission; private body withheld");
  return "full" as const;
};
export const pressureJobSchema = z.object({
  metadata: z.object({
    name: z.string(),
    uid: z.string(),
    labels: z.record(z.string(), z.string()),
  }),
  status: z
    .object({ conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional() })
    .optional(),
});
export const jobOccupancy = (jobs: readonly unknown[], name: string) => {
  const parsed = z.array(pressureJobSchema).safeParse(jobs);
  if (
    !parsed.success ||
    new Set(parsed.data.map((job) => job.metadata.uid)).size !== jobs.length ||
    parsed.data.some((job) => job.metadata.labels["krun.io/function"] !== name)
  )
    throw new Error("Invalid backpressure Job inventory");
  return parsed.data.filter(
    (job) =>
      !job.status?.conditions?.some(
        (condition) =>
          ["Complete", "Failed"].includes(condition.type) && condition.status === "True",
      ),
  ).length;
};
