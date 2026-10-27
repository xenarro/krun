import type { SchedulerConfig } from "@krun/shared/dist/config/index.js";
import { type Delivery, Store } from "@krun/shared/dist/store/index.js";
import {
  type CallbackNotAllowed,
  DnsLookup,
  makeWebhookPolicy,
  postWebhook,
  sign,
  WebhookSigningError,
  type WebhookTransportError,
} from "@krun/shared/dist/webhook/index.js";
import { DateTime, Deferred, Effect, Metric, Result, Schedule, Semaphore } from "effect";

type Options = Pick<
  SchedulerConfig,
  "KRUN_WEBHOOK_ALLOWED_HOSTS" | "KRUN_WEBHOOK_ALLOWED_CIDRS" | "KRUN_WEBHOOK_SECRET"
>;
const delays = ["1 minute", "5 minutes", "30 minutes", "2 hours", "12 hours"] as const;
const deliveries = Metric.counter("krun_deliveries_total", { incremental: true });
const failure = (error: CallbackNotAllowed | WebhookSigningError | WebhookTransportError) =>
  error._tag === "CallbackNotAllowed"
    ? `address rejected: ${error.reason}`
    : error._tag === "WebhookSigningError"
      ? "signing"
      : error.reason === "status"
        ? `status ${error.status ?? 0}`
        : error.reason;

/** One component per elected leader; HTTP retries live in Store rows, never fibers. */
export const makeDeliveriesLoop = (options: Options) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const dns = yield* DnsLookup;
    const policy = yield* makeWebhookPolicy(options);
    const secrets = [...options.KRUN_WEBHOOK_SECRET];
    const enabled = options.KRUN_WEBHOOK_ALLOWED_HOSTS.length > 0;
    const gate = yield* Semaphore.make(1);
    const stopping = yield* Deferred.make<void>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(
        Effect.andThen(Deferred.succeed(stopping, undefined)),
        // An externally invoked iterate also settles before its owner can release
        // Store dependencies. The race below aborts HTTP, not just the next tick.
        Effect.andThen(gate.withPermit(Effect.void)),
      ),
    );
    const attempt = (delivery: Delivery) =>
      Effect.gen(function* () {
        if (closed) return;
        const span = yield* Effect.currentSpan;
        const send = Effect.gen(function* () {
          // Store owns the immutable BASIC terminal snapshot. Encode once and give
          // the same bytes to the existing signer and pinned one-attempt transport.
          const body = yield* Effect.try({
            try: () => Buffer.from(JSON.stringify(delivery.payload)),
            catch: () => new WebhookSigningError({ reason: "sign" }),
          });
          const signature = yield* sign(body, secrets);
          return yield* postWebhook(delivery.url, policy, body, {
            deliveryId: delivery.id,
            runId: delivery.run_id,
            signature,
            traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`,
          }).pipe(Effect.provideService(DnsLookup, dns));
        });
        const result = yield* Effect.result(send);
        if (closed) return;
        const ok = Result.isSuccess(result);
        const error = Result.isFailure(result) ? result.failure : undefined;
        const status = Result.isSuccess(result)
          ? result.success
          : error?._tag === "WebhookTransportError"
            ? error.status
            : undefined;
        if (status !== undefined)
          yield* Effect.annotateCurrentSpan("http.response.status_code", status);
        const delay = delays[delivery.attempt];
        const state = ok ? "delivered" : delay === undefined ? "dead" : "pending";
        const count = ok ? delivery.attempt : delivery.attempt + 1;
        const nextAt =
          !ok && delay !== undefined ? DateTime.addDuration(yield* DateTime.now, delay) : null;
        const lastError = error === undefined ? null : failure(error);
        const applied = yield* store
          .updateDelivery(delivery.id, state, count, nextAt, lastError, delivery)
          .pipe(
            Effect.tap((applied) =>
              applied
                ? Metric.update(deliveries.pipe(Metric.withAttributes({ state })), 1)
                : Effect.void,
            ),
            // Never mask the POST. Only the existing settled write and its exact
            // committed counter publication share an interruption-safe boundary.
            Effect.uninterruptible,
          );
        if (!applied) {
          // Reclaimed, already settled or retention-deleted: do not publish a
          // counter or overwrite the newer outcome. Keep HTTP span semantics.
          if (error !== undefined) return yield* Effect.fail(error);
          return;
        }
        yield* (
          ok
            ? Effect.logInfo("Webhook delivery acknowledged")
            : Effect.logWarning("Webhook delivery attempt failed; outcome persisted")
        ).pipe(
          Effect.annotateLogs({
            delivery_id: delivery.id,
            "krun.run_id": delivery.run_id,
            attempt: count,
            state,
            last_error: lastError ?? "",
          }),
        );
        // Preserve a failed attempt's span status without aborting sibling sends.
        if (error !== undefined) return yield* Effect.fail(error);
      }).pipe(
        Effect.withSpan("webhook.deliver", {
          kind: "client",
          attributes: {
            "krun.run_id": delivery.run_id,
            "krun.delivery_id": delivery.id,
            "krun.delivery.attempt": delivery.attempt + 1,
          },
        }),
        Effect.annotateSpans("krun.run_id", delivery.run_id),
        Effect.catch((error) =>
          error._tag === "DatabaseError"
            ? Effect.logWarning("Webhook outcome write failed; pending lease retained").pipe(
                Effect.annotateLogs({
                  delivery_id: delivery.id,
                  "krun.run_id": delivery.run_id,
                  errorTag: error._tag,
                }),
              )
            : Effect.void,
        ),
      );
    const work = Effect.gen(function* () {
      while (!closed) {
        const batch = yield* store.claimDeliveries(yield* DateTime.now, 40);
        if (closed) return;
        yield* Effect.forEach(batch, attempt, { concurrency: 8, discard: true });
        if (batch.length < 40) return;
      }
    }).pipe(
      Effect.withSpan("scheduler.deliveries"),
      Effect.catch((error) =>
        Effect.logWarning("Webhook delivery claim failed; retrying on the next pass").pipe(
          Effect.annotateLogs({ errorTag: error._tag }),
        ),
      ),
    );
    const iterate = Effect.suspend(() =>
      closed || !enabled
        ? Effect.void
        : Effect.raceFirst(gate.withPermit(work), Deferred.await(stopping)).pipe(Effect.asVoid),
    );
    return {
      iterate,
      run: enabled
        ? Effect.raceFirst(
            iterate.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.asVoid),
            Deferred.await(stopping),
          )
        : Deferred.await(stopping),
    };
  });
