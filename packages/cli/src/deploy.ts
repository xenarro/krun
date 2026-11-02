import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import pc from "picocolors";
import { deployCommand } from "./deploy-command.js";
import {
  DeployEnvironment,
  DeployFilesLive,
  DeployPromptLive,
  DeployTerminal,
  DockerLive,
  KubectlLive,
} from "./deploy-services.js";

const terminal = Layer.succeed(DeployTerminal, {
  cwd: process.cwd(),
  isTTY: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
  output: (stream, text) =>
    Effect.sync(() => {
      if (stream === "stdout") console.log(text);
      else
        console.error(
          process.stderr.isTTY && process.env.NO_COLOR === undefined ? pc.cyan(text) : text,
        );
    }),
});
const main = deployCommand(process.argv.slice(2)).pipe(
  Effect.catchTag("DeployFailure", (error) =>
    Effect.gen(function* () {
      yield* (yield* DeployTerminal).output("stderr", `${error.message}\nTry this: ${error.hint}`);
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }),
  ),
  Effect.provide(
    Layer.mergeAll(
      terminal,
      Layer.succeed(DeployEnvironment, { values: process.env }),
      DeployFilesLive,
      DeployPromptLive,
      DockerLive,
      KubectlLive,
    ),
  ),
);
NodeRuntime.runMain(main);
