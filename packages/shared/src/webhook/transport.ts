import { isIP, type LookupFunction } from "node:net";
import { Effect } from "effect";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { type CallbackNotAllowed, WebhookTransportError } from "./errors.js";
import { type DnsLookup, resolveAndCheck, type WebhookPolicy } from "./policy.js";

const headersSchema = z.strictObject({
  deliveryId: z.string().min(1),
  runId: z.string().min(1),
  signature: z.string().min(1),
  traceparent: z.string().min(1).optional(),
});
export type WebhookHeaders = z.infer<typeof headersSchema>;

/** One attempt only. Retry scheduling, tracing headers and Store writes belong to the delivery loop. */
export const postWebhook = (
  url: string,
  policy: WebhookPolicy,
  body: Uint8Array,
  headers: WebhookHeaders,
): Effect.Effect<number, WebhookTransportError | CallbackNotAllowed, DnsLookup> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* Effect.try({
        try: () => ({ body: Buffer.from(body), headers: headersSchema.parse(headers) }),
        catch: () => new WebhookTransportError({ reason: "headers" }),
      });
      // Resolve immediately before acquisition: no globally pooled dispatcher can preserve an earlier pin.
      const target = yield* resolveAndCheck(url, policy);
      const pinnedLookup: LookupFunction = (hostname, options, callback) => {
        if (hostname !== target.hostname) {
          callback(new Error("Pinned target mismatch"), "");
          return;
        }
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      };
      const dispatcher = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new Agent({
              connect: {
                lookup: pinnedLookup,
                ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
              },
            }),
          catch: () => new WebhookTransportError({ reason: "request" }),
        }),
        // Per-attempt ownership: destroy also settles active sockets on failure, timeout and interruption.
        (agent) =>
          Effect.tryPromise({
            try: () => agent.destroy(),
            catch: () => new WebhookTransportError({ reason: "cleanup" }),
          }).pipe(Effect.orDie),
      );
      const status = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(target.url, {
            method: "POST",
            dispatcher,
            redirect: "manual",
            signal,
            body: request.body,
            headers: {
              "Content-Type": "application/json",
              "X-Krun-Delivery": request.headers.deliveryId,
              "X-Krun-Run-Id": request.headers.runId,
              "X-Krun-Signature": request.headers.signature,
              ...(request.headers.traceparent === undefined
                ? {}
                : { traceparent: request.headers.traceparent }),
            },
          });
          // Never read/log a response body. Releasing it is necessary even for an unsuccessful status.
          await response.body?.cancel();
          return response.status;
        },
        catch: () => new WebhookTransportError({ reason: "request" }),
      });
      if (status < 200 || status >= 300)
        return yield* Effect.fail(new WebhookTransportError({ reason: "status", status }));
      return status;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new WebhookTransportError({ reason: "timeout" })),
    }),
  );
