import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { ConfigInvalid } from "@krun/shared/dist/config/index.js";
import { Cause, Data, Effect, Exit, Layer } from "effect";
import { GatewayProcessLive } from "./runtime.js";

class GatewayArgumentsInvalid extends Data.TaggedError("GatewayArgumentsInvalid") {}
const usage = "Usage: krun gateway [--help]";
const main = Effect.suspend((): Effect.Effect<void, unknown> => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return Effect.sync(() => console.log(usage));
  if (args.length !== 0) return Effect.fail(new GatewayArgumentsInvalid());
  return Layer.launch(GatewayProcessLive);
}).pipe(
  Effect.catchCause((cause) => {
    if (!Cause.hasInterruptsOnly(cause)) {
      const error = cause.reasons.find(Cause.isFailReason)?.error;
      // Bootstrap failures happen before a configured pino logger may exist.
      // Emit only owned diagnostics, never causes, config values or credentials.
      console.error(
        JSON.stringify({
          level: 50,
          msg:
            error instanceof GatewayArgumentsInvalid ? usage : "Gateway startup or shutdown failed",
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
