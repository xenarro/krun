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
const bodySchema = z.looseObject({ message: z.string().optional(), reason: z.string().optional() });
const detailSchema = z.looseObject({
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
});
interface StatusDetail {
  readonly message: string;
  readonly reason: string;
  readonly retryAfter?: string;
}
// ApiException.message includes the raw body and headers. Never put it (or the
// Status message) in the Effect error channel: failures are automatically traced.
const details = new WeakMap<KubeApiError, StatusDetail>();
export const kubeApiStatus = (error: KubeApiError): StatusDetail =>
  details.get(error) ?? { message: "Kubernetes API request failed", reason: "Unknown" };
/** Never retain library errors: bodies, headers and kubeconfig paths may contain secrets. */
export const kubeApiError = (error: unknown): KubeApiError => {
  if (error instanceof KubeApiError) return error;
  const parsed = statusSchema.safeParse(error);
  const code = parsed.success ? (parsed.data.statusCode ?? parsed.data.code) : undefined;
  const status =
    code !== undefined && Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
  const mapped = new KubeApiError({
    operation: "request",
    reason: "request_failed",
    ...(status === undefined ? {} : { status }),
  });
  const detail = detailSchema.safeParse(error);
  if (detail.success) {
    const headers = detail.data.headers;
    const retry =
      headers && Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    let body: unknown = detail.data.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = undefined;
      }
    }
    const parsedBody = bodySchema.safeParse(body);
    details.set(mapped, {
      message: parsedBody.success
        ? (parsedBody.data.message ?? "Kubernetes API request failed")
        : "Kubernetes API request failed",
      reason: parsedBody.success ? (parsedBody.data.reason ?? "Unknown") : "Unknown",
      ...(typeof retry === "string" ? { retryAfter: retry } : {}),
    });
  }
  return mapped;
};
