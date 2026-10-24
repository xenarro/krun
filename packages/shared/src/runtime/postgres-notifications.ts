import { Cause, Duration, Effect, Queue, Schedule, Stream } from "effect";
import { Client, type Notification } from "pg";
import { DatabaseError } from "../store/errors.js";

// One lazy, ref-counted transport per Database layer, not one pool borrower or
// connection per Store consumer. Notifications are hints; wait/SSE re-reads
// remain the correctness path (SPEC section 6). Bound both callback and fan-out
// buffers so an abandoned/slow consumer cannot retain unbounded payloads.
export const makePostgresNotifications = (dsn: string) =>
  Stream.callback<string, DatabaseError>(
    (queue) =>
      Effect.gen(function* () {
        let listening = false;
        let failed = false;
        let closing = false;
        const failure = () => {
          if (failed || closing) return;
          failed = true;
          Queue.failCauseUnsafe(queue, Cause.fail(new DatabaseError({ operation: "subscribe" })));
        };
        const notification = (value: Notification) => {
          if (value.channel === "krun_runs" && typeof value.payload === "string")
            Queue.offerUnsafe(queue, value.payload);
        };
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const value = new Client({
              connectionString: dsn,
              connectionTimeoutMillis: 10000,
              query_timeout: 10000,
            });
            value.on("error", failure);
            value.on("end", failure);
            value.on("notification", notification);
            return value;
          }),
          (value) =>
            Effect.promise(async () => {
              closing = true;
              try {
                if (listening && !failed) await value.query("UNLISTEN krun_runs");
              } catch {
                // A failed connection is still closed; never retain/log driver data.
              } finally {
                await value.end().catch(() => undefined);
                value.off("notification", notification);
                value.off("end", failure);
                value.off("error", failure);
              }
            }),
        );
        yield* Effect.tryPromise({
          try: async () => {
            await client.connect();
            await client.query("LISTEN krun_runs");
            listening = true;
          },
          catch: () => new DatabaseError({ operation: "subscribe" }),
        });
      }),
    { bufferSize: 256, strategy: "sliding" },
  ).pipe(
    // A pg Client cannot reconnect. Retrying re-acquires a NEW scoped client;
    // error followed by end only completes the failed queue once.
    Stream.retry(
      Schedule.exponential("100 millis").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(1))),
        ),
      ),
    ),
    Stream.share({ capacity: 256, strategy: "sliding" }),
  );
