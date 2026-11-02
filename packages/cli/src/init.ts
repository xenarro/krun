import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import pc from "picocolors";
import { InitFilesLive, InitPromptLive, InitTerminal, initCommand } from "./init-command.js";

const terminal = Layer.succeed(InitTerminal, {
  cwd: process.cwd(),
  isTTY: process.stdin.isTTY === true,
  output: (stream, text) =>
    Effect.sync(() => {
      if (stream === "stdout") console.log(text);
      else console.error(pc.cyan(text));
    }),
});
const main = initCommand(process.argv.slice(2)).pipe(
  Effect.catchTag("InitFailure", (error) =>
    Effect.gen(function* () {
      const output = yield* InitTerminal;
      yield* output.output("stderr", `${error.message}\nTry this: ${error.hint}`);
      yield* Effect.sync(() => {
        process.exitCode = error.exitCode;
      });
    }),
  ),
  Effect.provide(Layer.mergeAll(terminal, InitFilesLive, InitPromptLive)),
);
NodeRuntime.runMain(main);
