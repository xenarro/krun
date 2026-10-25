import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Data, Effect } from "effect";
import { validatePaths } from "./validate-functions.js";

class UsageInvalid extends Data.TaggedError("UsageInvalid")<{
  readonly reason: "arguments";
}> {}

const usage = "Usage: krun validate [--help] <path>...";
const main = Effect.gen(function* () {
  const options = yield* Effect.try({
    try: () =>
      parseArgs({
        args: process.argv.slice(2),
        options: { help: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      }),
    catch: () => new UsageInvalid({ reason: "arguments" }),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (options === undefined || (!options.values.help && options.positionals.length === 0)) {
    yield* Effect.sync(() => {
      console.error(usage);
      process.exitCode = 1;
    });
    return;
  }
  if (options.values.help) {
    yield* Effect.sync(() => console.log(usage));
    return;
  }
  const result = yield* validatePaths(options.positionals);
  yield* Effect.sync(() => {
    if (result.ceilingsLine !== undefined) console.error(result.ceilingsLine);
    for (const line of result.lines) console.log(line);
    for (const error of result.errors) console.error(error);
    process.exitCode = result.exitCode;
  });
});
NodeRuntime.runMain(main);
