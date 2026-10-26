import { inspect } from "node:util";
import { expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { KubeApiError, kubeApiError, kubeApiStatus } from "./errors.js";

for (const encoded of [false, true])
  it.effect(
    `native Status ${encoded ? "JSON text" : "object"} survives only through explicit persistence view`,
    () =>
      Effect.gen(function* () {
        const message = "krun-test-private-status";
        const body = { reason: "Invalid", message, private: "krun-test-private-extra" };
        const error = kubeApiError({
          code: 422,
          message: "krun-test-private-library",
          body: encoded ? JSON.stringify(body) : body,
          headers: { Authorization: "krun-test-private-header", "Retry-After": "7" },
        });
        expect(kubeApiStatus(error)).toEqual({ message, reason: "Invalid", retryAfter: "7" });
        expect(kubeApiError(error)).toBe(error);
        const exit = yield* Effect.exit(Effect.fail(error));
        const rendered =
          JSON.stringify(error) +
          inspect(error) +
          (exit._tag === "Failure" ? Cause.pretty(exit.cause) : "");
        expect(rendered).not.toContain("krun-test-private");
        expect(error.status).toBe(422);
      }),
  );

it.effect(
  "unknown/malformed response data never becomes diagnostics and fallbacks are bounded",
  () =>
    Effect.sync(() => {
      for (const body of [undefined, "not JSON", { reason: 3 }, null, ["private"]]) {
        const error = kubeApiError({ code: 429, body, headers: { "retry-after": "5" } });
        expect(kubeApiStatus(error).message).toBe("Kubernetes API request failed");
        expect(kubeApiStatus(error).retryAfter).toBe("5");
        expect(JSON.stringify(error)).not.toContain("private");
      }
      expect(kubeApiStatus(new KubeApiError({ operation: "request", reason: "timeout" }))).toEqual({
        message: "Kubernetes API request failed",
        reason: "Unknown",
      });
    }),
);
