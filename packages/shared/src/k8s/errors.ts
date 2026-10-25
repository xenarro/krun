import { Data } from "effect";
import { z } from "zod";

export class KubeConfigError extends Data.TaggedError("KubeConfigError")<{
  readonly message: "Kubernetes configuration could not be loaded";
}> {}

export class KubeApiError extends Data.TaggedError("KubeApiError")<{
  readonly operation: "functions" | "request";
  readonly reason: "request_failed" | "timeout" | "disconnected" | "invalid_response";
  readonly status?: number;
}> {}

const statusSchema = z.looseObject({
  code: z.number().optional(),
  statusCode: z.number().optional(),
});
/** Never retain library errors: bodies, headers and kubeconfig paths may contain secrets. */
export const kubeApiError = (error: unknown): KubeApiError => {
  if (error instanceof KubeApiError) return error;
  const parsed = statusSchema.safeParse(error);
  const code = parsed.success ? (parsed.data.statusCode ?? parsed.data.code) : undefined;
  const status =
    code !== undefined && Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
  return new KubeApiError({
    operation: "request",
    reason: "request_failed",
    ...(status === undefined ? {} : { status }),
  });
};
