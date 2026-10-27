import { z } from "zod";

export const podSchema = z.object({
  metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()) }),
  spec: z.object({
    automountServiceAccountToken: z.boolean(),
    containers: z.array(
      z.object({
        name: z.string(),
        env: z.array(
          z.object({
            name: z.string(),
            value: z.string().optional(),
            valueFrom: z
              .object({ secretKeyRef: z.object({ name: z.string(), key: z.string() }) })
              .optional(),
          }),
        ),
      }),
    ),
  }),
  status: z
    .object({
      phase: z.string().optional(),
      containerStatuses: z
        .array(
          z.object({
            name: z.string(),
            state: z.object({
              terminated: z
                .object({
                  exitCode: z.number(),
                  finishedAt: z.union([z.string(), z.null()]).optional(),
                })
                .optional(),
            }),
          }),
        )
        .optional(),
    })
    .optional(),
});
