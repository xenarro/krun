import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { ConfigInvalid } from "@krun/shared/dist/config/index.js";
import { Cause, Data, Effect, Exit, Layer } from "effect";
import { SchedulerProcessLive } from "./runtime.js";

class SchedulerArgumentsInvalid extends Data.TaggedError("SchedulerArgumentsInvalid") {}
const usage = "Usage: krun scheduler [--help]";
const main = Effect.suspend((): Effect.Effect<void, unknown> => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return Effect.sync(() => console.log(usage));
  if (args.length !== 0) return Effect.fail(new SchedulerArgumentsInvalid());
  return Layer.launch(SchedulerProcessLive);
}).pipe(
  Effect.catchCause((cause) => {
    if (!Cause.hasInterruptsOnly(cause)) {
      const error = cause.reasons.find(Cause.isFailReason)?.error;
      console.error(
        JSON.stringify({
          level: 50,
          msg:
            error instanceof SchedulerArgumentsInvalid
              ? usage
              : "Scheduler startup or shutdown failed",
          ...(error instanceof ConfigInvalid ? { variable: error.variable } : {}),
        }),
      );
    }
    return Effect.failCause(cause);
  }),
);
NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  teardown: (exit, done) =>
    done(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
