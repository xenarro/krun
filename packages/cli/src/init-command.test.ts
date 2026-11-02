import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { InitFiles, InitFilesLive, InitPrompt, InitTerminal, initCommand } from "./init-command.js";

const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-init-effect-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);
function services(cwd: string, isTTY: boolean, selected: "node" | "python" | symbol) {
  const prompts: string[] = [],
    lines: string[] = [];
  return {
    prompts,
    lines,
    layer: Layer.mergeAll(
      InitFilesLive,
      Layer.succeed(InitTerminal, {
        cwd,
        isTTY,
        output: (_stream, text) =>
          Effect.sync(() => {
            lines.push(text);
          }),
      }),
      Layer.succeed(InitPrompt, {
        language: Effect.sync(() => {
          prompts.push("language");
          return selected;
        }),
      }),
    ),
  };
}
it.effect("TTY prompts only for language and keeps the basename default", () =>
  Effect.gen(function* () {
    const cwd = yield* scratch;
    const s = services(cwd, true, "node");
    yield* initCommand(["sample"]).pipe(Effect.provide(s.layer));
    expect(s.prompts).toEqual(["language"]);
    expect(s.lines.join("\n")).toContain("npm test");
    expect(yield* Effect.promise(() => readdir(join(cwd, "sample")))).toContain("function.yaml");
  }),
);
it.effect("explicit TTY language never prompts", () =>
  Effect.gen(function* () {
    const cwd = yield* scratch;
    const s = services(cwd, true, Symbol("must not prompt"));
    yield* initCommand(["--lang", "node", "sample"]).pipe(Effect.provide(s.layer));
    expect(s.prompts).toEqual([]);
  }),
);
it.effect("cancelled TTY selection exits130 without filesystem writes", () =>
  Effect.gen(function* () {
    const cwd = yield* scratch;
    const s = services(cwd, true, Symbol("cancel"));
    const error = yield* initCommand(["sample"]).pipe(Effect.provide(s.layer), Effect.flip);
    expect(error.exitCode).toBe(130);
    expect(yield* Effect.promise(() => readdir(cwd))).toEqual([]);
  }),
);
it.effect("missing non-TTY language never prompts or creates a directory", () =>
  Effect.gen(function* () {
    const cwd = yield* scratch;
    const s = services(cwd, false, "node");
    const error = yield* initCommand(["sample"]).pipe(Effect.provide(s.layer), Effect.flip);
    expect(error.message).toContain("--lang");
    expect(s.prompts).toEqual([]);
    expect(yield* Effect.promise(() => readdir(cwd))).toEqual([]);
  }),
);
it.effect("post-write schema failures roll back only newly created files", () =>
  Effect.gen(function* () {
    const cwd = yield* scratch;
    yield* Effect.promise(() => writeFile(join(cwd, ".keep"), "owned by user"));
    const program = Effect.gen(function* () {
      const fs = yield* InitFiles;
      return yield* fs.publish(
        cwd,
        new Map([
          ["handler.js", "invalid project"],
          ["function.yaml", "kind: NotAFunction"],
        ]),
      );
    });
    yield* program.pipe(Effect.provide(InitFilesLive), Effect.flip);
    expect(yield* Effect.promise(() => readdir(cwd))).toEqual([".keep"]);
  }),
);
