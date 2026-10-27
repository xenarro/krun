import { type Run, toRunSummary } from "@krun/shared/dist/store/index.js";
import { DateTime, Effect, Queue, Semaphore } from "effect";
import type { FastifyReply } from "fastify";
import { ApiError } from "./errors.js";
import { publicSchemas } from "./public-contracts.js";

const terminal = (state: Run["state"]) =>
  state === "succeeded" || state === "failed" || state === "cancelled";
const stateTime = (row: Run) => {
  switch (row.state) {
    case "queued":
      return Effect.succeed(row.created_at);
    case "scheduled":
      return row.scheduled_at === null
        ? Effect.fail(new ApiError({ reason: "INTERNAL" }))
        : Effect.succeed(row.scheduled_at);
    case "running":
      return row.started_at === null
        ? Effect.fail(new ApiError({ reason: "INTERNAL" }))
        : Effect.succeed(row.started_at);
    case "cancelling":
      return DateTime.now;
    default:
      return row.finished_at === null
        ? Effect.fail(new ApiError({ reason: "INTERNAL" }))
        : Effect.succeed(row.finished_at);
  }
};
const jobFields = (row: Run) => {
  if (row.job_status === null) return undefined;
  const { podName, phase, reason, message, exitCode } = row.job_status;
  return JSON.stringify([podName, phase, reason, message, exitCode]);
};

// The caller owns queue registration and stored-row authorization. This scoped
// transport consumes the same id-only hints as both wait methods, never a second
// Store subscription. All data passes through the canonical BASIC whitelist.
export const watchRun = <E>(
  reply: FastifyReply,
  requestId: string,
  queue: Queue.Queue<void>,
  read: Effect.Effect<Run, E>,
  closing: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const first = yield* Effect.raceFirst(
      read,
      closing.pipe(Effect.andThen(Effect.fail(new ApiError({ reason: "NOT_READY" })))),
    );
    const initial = publicSchemas.RunSummary.parse(toRunSummary(first));
    const initialId = DateTime.formatIso(yield* stateTime(first));
    // Everything that can produce a normal API envelope precedes hijack.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }),
    );
    yield* Effect.sync(() => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-request-id": requestId,
      });
    });
    const writer = yield* Effect.sync(() => Semaphore.makeUnsafe(1));
    const destroy = Effect.sync(() => {
      reply.raw.destroy();
    });
    const drain = Effect.callback<void, ApiError>((resume) => {
      const cleanup = () => {
        reply.raw.off("drain", drained);
        reply.raw.off("close", failed);
        reply.raw.off("error", failed);
      };
      const drained = () => {
        cleanup();
        resume(Effect.void);
      };
      const failed = () => {
        cleanup();
        resume(Effect.fail(new ApiError({ reason: "INTERNAL" })));
      };
      reply.raw.once("drain", drained);
      reply.raw.once("close", failed);
      reply.raw.once("error", failed);
      // Drain may have happened before this callback was scheduled. Never wait
      // for a second drain after the native buffer has already emptied.
      if (reply.raw.destroyed || reply.raw.writableEnded) failed();
      else if (!reply.raw.writableNeedDrain) drained();
      return Effect.sync(cleanup);
    });
    const write = (frame: string) =>
      writer.withPermit(
        Effect.gen(function* () {
          const accepted = yield* Effect.try({
            try: () => reply.raw.write(frame),
            catch: () => new ApiError({ reason: "INTERNAL" }),
          });
          // false means the frame WAS buffered. Do not replay it or destroy a
          // healthy large-snapshot reader; suspend production until drain.
          if (!accepted)
            yield* drain.pipe(
              Effect.timeout("2 seconds"),
              Effect.onInterrupt(() => destroy),
            );
        }).pipe(Effect.catch(() => destroy.pipe(Effect.andThen(Effect.interrupt)))),
      );
    const send = (kind: string, id: string, value: typeof initial) =>
      write(`event: ${kind}\nid: ${id}\ndata: ${JSON.stringify(value)}\n\n`);
    const stream = Effect.gen(function* () {
      yield* send("state", initialId, initial);
      if (terminal(first.state)) return;
      let previous = first;
      const changes = Effect.gen(function* () {
        while (true) {
          yield* Effect.raceFirst(Queue.take(queue), Effect.sleep("1 second"));
          const row = yield* read;
          const value = publicSchemas.RunSummary.parse(toRunSummary(row));
          // Report every observed changed group before the terminal state ends
          // the stream. Observation-only Job timestamp refreshes are not changes.
          if (
            row.runtime_status !== null &&
            (previous.runtime_status === null ||
              DateTime.toEpochMillis(row.runtime_status.at) !==
                DateTime.toEpochMillis(previous.runtime_status.at))
          )
            yield* send("status", DateTime.formatIso(row.runtime_status.at), value);
          if (row.job_status !== null && jobFields(row) !== jobFields(previous))
            yield* send("job_status", DateTime.formatIso(row.job_status.observedAt), value);
          if (row.state !== previous.state)
            yield* send("state", DateTime.formatIso(yield* stateTime(row)), value);
          previous = row;
          if (terminal(row.state)) return;
        }
      });
      const keepalive = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("15 seconds");
          yield* write(": keepalive\n\n");
        }
      });
      yield* Effect.raceFirst(changes, keepalive);
    });
    // Once headers are committed an error envelope would corrupt SSE and could
    // expose an internal failure. All outcomes end the scoped transport instead.
    yield* Effect.raceFirst(stream, closing).pipe(Effect.ignoreCause);
  });
