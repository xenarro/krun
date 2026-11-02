import { lstat, mkdir, open, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isCancel, select } from "@clack/prompts";
import {
  functionMetadataSchema,
  functionResourceSchema,
  functionSpecSchema,
} from "@krun/shared/dist/functions/schema.js";
import { Context, Data, Effect, Layer } from "effect";
import { parse } from "yaml";
import { z } from "zod";

export class InitFailure extends Data.TaggedError("InitFailure")<{
  readonly message: string;
  readonly hint: string;
  readonly exitCode: 1 | 130;
}> {}
const failure = (message: string, hint = "Run krun init --help.") =>
  new InitFailure({ message, hint, exitCode: 1 });
const usage = "Usage: krun init [--help] --lang node|python [--name <function>] <dir>";
const files = [
  "handler.js",
  "handler.test.js",
  "package.json",
  "Dockerfile",
  ".dockerignore",
  ".gitignore",
  "function.yaml",
  "README.md",
];
const starterSchema = functionResourceSchema.extend({
  spec: functionSpecSchema.extend({ image: z.literal("REPLACE_WITH_DIGEST") }),
});
const validStarter = (text: string) => starterSchema.safeParse(parse(text)).success;
export class InitFiles extends Context.Service<
  InitFiles,
  {
    readonly read: (file: string | URL) => Effect.Effect<string, InitFailure>;
    readonly publish: (
      directory: string,
      files: ReadonlyMap<string, string>,
    ) => Effect.Effect<void, InitFailure>;
  }
>()("@krun/cli/InitFiles") {}
export class InitPrompt extends Context.Service<
  InitPrompt,
  {
    readonly language: Effect.Effect<"node" | "python" | symbol, InitFailure>;
  }
>()("@krun/cli/InitPrompt") {}
export class InitTerminal extends Context.Service<
  InitTerminal,
  {
    readonly cwd: string;
    readonly isTTY: boolean;
    readonly output: (stream: "stdout" | "stderr", text: string) => Effect.Effect<void>;
  }
>()("@krun/cli/InitTerminal") {}

const missing = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
export const InitFilesLive = Layer.succeed(InitFiles, {
  read: (file) =>
    Effect.tryPromise({
      try: (signal) => readFile(file, { encoding: "utf8", signal }),
      catch: () =>
        failure(
          "Cannot read CLI template or package metadata.",
          "Reinstall the matching CLI package.",
        ),
    }),
  publish: (directory, content) =>
    Effect.suspend(() => {
      // AbortSignal stops supported I/O, but tryPromise alone does not await
      // its catch/finally on interruption. Own the entire transaction's
      // settlement before yielding, including late open/mkdir acquisitions.
      let settled = Promise.resolve();
      return Effect.tryPromise({
        try: (signal) => {
          const transaction = (async () => {
            const owned: string[] = [];
            let created = false;
            try {
              const info = await lstat(directory).catch((error: unknown) => {
                if (missing(error)) return undefined;
                throw error;
              });
              if (info && (!info.isDirectory() || info.isSymbolicLink()))
                throw failure(
                  "Target must be a directory, not a file or symlink.",
                  "Choose a new directory.",
                );
              if (!info) {
                await mkdir(directory, { recursive: true });
                created = true;
              }
              const entries = await readdir(directory);
              const conflict = entries.find((name) => !name.startsWith(".") || content.has(name));
              if (conflict)
                throw failure(
                  `Target contains ${JSON.stringify(conflict)}.`,
                  "Choose an empty directory; existing files are never overwritten.",
                );
              for (const [name, text] of content) {
                signal.throwIfAborted();
                const file = join(directory, name);
                const handle = await open(file, "wx");
                owned.push(file);
                try {
                  await handle.writeFile(text, { signal });
                } finally {
                  await handle.close();
                }
              }
              if (
                !validStarter(
                  await readFile(join(directory, "function.yaml"), { encoding: "utf8", signal }),
                )
              )
                throw failure(
                  "Generated function.yaml does not satisfy the starter schema.",
                  "Reinstall the matching CLI package.",
                );
            } catch (error) {
              for (const file of owned.reverse()) await unlink(file).catch(() => undefined);
              if (created) await rmdir(directory).catch(() => undefined);
              throw error;
            }
          })();
          settled = transaction.then(
            () => undefined,
            () => undefined,
          );
          return transaction;
        },
        catch: (error) =>
          error instanceof InitFailure
            ? error
            : failure(
                "Cannot create the function project.",
                "Check directory permissions and use an empty target directory.",
              ),
      }).pipe(Effect.onInterrupt(() => Effect.promise(() => settled)));
    }),
});
export const InitPromptLive = Layer.succeed(InitPrompt, {
  language: Effect.tryPromise({
    try: (signal) =>
      select({
        message: "Function language",
        options: [
          { value: "node" as const, label: "Node.js" },
          { value: "python" as const, label: "Python" },
        ],
        input: process.stdin,
        output: process.stderr,
        signal,
      }),
    catch: () => failure("Language prompt failed."),
  }),
});
const optionsSchema = z.strictObject({
  lang: z.enum(["node", "python"]).optional(),
  name: z.string().optional(),
  directory: z.string().min(1),
});
const versionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
});
export const initCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const terminal = yield* InitTerminal;
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            help: { type: "boolean" },
            lang: { type: "string" },
            name: { type: "string" },
          },
          allowPositionals: true,
          strict: true,
        }),
      catch: () =>
        failure("Invalid init arguments. A name beginning with '-' may be a mistyped flag."),
    });
    if (parsed.values.help) {
      yield* terminal.output("stdout", usage);
      return;
    }
    const checked = optionsSchema.safeParse({
      lang: parsed.values.lang,
      name: parsed.values.name,
      directory: parsed.positionals[0],
    });
    if (!checked.success || parsed.positionals.length !== 1)
      return yield* failure("Invalid init arguments; provide --lang node and one directory.");
    const options = checked.data;
    let language = options.lang;
    if (language === undefined) {
      if (!terminal.isTTY)
        return yield* failure(
          "Missing --lang on a non-interactive terminal.",
          "Use krun init --lang node <dir>.",
        );
      const prompt = yield* InitPrompt;
      const selected = yield* prompt.language;
      if (isCancel(selected) || typeof selected === "symbol")
        return yield* new InitFailure({
          message: "Init cancelled.",
          hint: "Run krun init again when ready.",
          exitCode: 130,
        });
      language = selected;
    }
    if (language !== "node")
      return yield* failure(
        "The Python template is not implemented yet (P8.5).",
        "Use --lang node for the available template.",
      );
    const target = resolve(terminal.cwd, options.directory);
    const name = options.name ?? basename(target);
    if (!functionMetadataSchema.shape.name.safeParse(name).success)
      return yield* failure(
        "Function name must be a DNS-1123 label of at most 63 characters; a leading '-' may be a mistyped flag.",
        "Use --name with lowercase letters, digits and internal hyphens.",
      );
    const fs = yield* InitFiles;
    const metadata = yield* fs.read(new URL("../package.json", import.meta.url));
    const version = yield* Effect.try({
      try: () => versionSchema.parse(JSON.parse(metadata)).version,
      catch: () => failure("Invalid CLI package version.", "Reinstall the CLI package."),
    });
    const content = new Map<string, string>();
    for (const file of files) {
      const source = yield* fs.read(
        new URL(`../templates/node/${file === ".gitignore" ? "gitignore" : file}`, import.meta.url),
      );
      content.set(
        file,
        source.replaceAll("__KRUN_NAME__", name).replaceAll("__KRUN_VERSION__", version),
      );
    }
    const manifest = content.get("function.yaml");
    const valid = yield* Effect.try({
      try: () => manifest !== undefined && validStarter(manifest),
      catch: () => failure("Invalid starter template YAML."),
    });
    if (!valid)
      return yield* failure("Invalid starter template schema.", "Reinstall the CLI package.");
    yield* fs.publish(target, content);
    yield* terminal.output(
      "stderr",
      `Created ${JSON.stringify(target)}. Next: cd '${target.replaceAll("'", "'\\''")}'; npm install; npm test. Replace REPLACE_WITH_DIGEST via krun deploy before applying function.yaml.`,
    );
  });
