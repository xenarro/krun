import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { spinner } from "@clack/prompts";
import { Context, Data, Effect, Layer } from "effect";
import { x } from "tinyexec";

export class DeployFailure extends Data.TaggedError("DeployFailure")<{
  readonly message: string;
  readonly hint: string;
}> {}
export const deployFailure = (message: string, hint = "Run krun deploy --help.") =>
  new DeployFailure({ message, hint });

type Command = (args: readonly string[], cwd: string) => Effect.Effect<string, DeployFailure>;
export class Docker extends Context.Service<Docker, { readonly run: Command }>()(
  "@krun/cli/Docker",
) {}
export class Kubectl extends Context.Service<Kubectl, { readonly run: Command }>()(
  "@krun/cli/Kubectl",
) {}
export class DeployEnvironment extends Context.Service<
  DeployEnvironment,
  {
    readonly values: Readonly<Record<string, string | undefined>>;
  }
>()("@krun/cli/DeployEnvironment") {}
export class DeployTerminal extends Context.Service<
  DeployTerminal,
  {
    readonly cwd: string;
    readonly isTTY: boolean;
    readonly output: (stream: "stdout" | "stderr", text: string) => Effect.Effect<void>;
  }
>()("@krun/cli/DeployTerminal") {}
export class DeployPrompt extends Context.Service<
  DeployPrompt,
  {
    readonly start: (label: string) => Effect.Effect<() => void>;
  }
>()("@krun/cli/DeployPrompt") {}
export class DeployFiles extends Context.Service<
  DeployFiles,
  {
    readonly read: (path: string) => Effect.Effect<string, DeployFailure>;
    readonly replace: (
      path: string,
      expected: string,
      content: string,
    ) => Effect.Effect<void, DeployFailure>;
  }
>()("@krun/cli/DeployFiles") {}

// The only subprocess adapter. Never attach raw child output/cause to a public
// error: registry helpers and kubectl may include credentials or private URLs.
// Cancellation owns the process group/tree, not just the direct child. Do not
// pass an AbortSignal to tinyexec: on Windows that can kill the parent before
// taskkill has enumerated its descendants.
export const execute = (command: string, args: readonly string[], cwd: string) =>
  Effect.suspend(() => {
    let child: ReturnType<typeof x> | undefined;
    let settled = Promise.resolve();
    return Effect.tryPromise({
      try: () => {
        child = x(command, args, {
          throwOnError: false,
          nodePath: false,
          nodeOptions: {
            cwd,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          },
        });
        const result = Promise.resolve(child);
        settled = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      catch: () =>
        deployFailure(
          `${command === "docker" ? "Docker" : "Command"} could not start.`,
          command === "docker"
            ? "Run docker version."
            : "Run kubectl config get-contexts; kubectl cluster-info.",
        ),
    }).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0)
          return Effect.succeed(
            command === "kubectl" ? result.stdout : `${result.stdout}\n${result.stderr}`,
          );
        if (command === "docker")
          return Effect.fail(
            deployFailure(
              `Docker ${args[0] ?? "command"} failed.`,
              args[0] === "push"
                ? "Check registry access with docker login, then retry krun deploy."
                : "Run docker version and inspect the project's Dockerfile.",
            ),
          );
        const missingCrd = /doesn't have a resource type|no matches for kind/i.test(result.stderr);
        const missingConfig = /no configuration|no context exists|current-context is not set/i.test(
          result.stderr,
        );
        return Effect.fail(
          deployFailure(
            missingCrd
              ? "Function CRD is not installed."
              : missingConfig
                ? "Kubectl has no usable kubeconfig/context."
                : "Kubectl command failed.",
            missingCrd
              ? "Install the krun platform chart with crds.install=true."
              : "Run kubectl config get-contexts; kubectl cluster-info.",
          ),
        );
      }),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const pid = child?.pid;
          if (pid !== undefined) {
            if (process.platform === "win32") {
              yield* Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    x("taskkill", ["/PID", String(pid), "/T", "/F"], {
                      timeout: 5_000,
                      throwOnError: false,
                      nodePath: false,
                      nodeOptions: { shell: false, stdio: "ignore" },
                    }),
                  ),
                catch: () => undefined,
              }).pipe(Effect.ignore);
              child?.kill("SIGKILL");
            } else {
              yield* Effect.sync(() => {
                try {
                  // detached created this group; never signal the caller's group.
                  process.kill(-pid, "SIGKILL");
                } catch {
                  child?.kill("SIGKILL");
                }
              });
            }
          }
          // Even an escaped/daemonized pipe holder must not keep shutdown stuck.
          yield* Effect.promise(() => settled).pipe(
            Effect.interruptible,
            Effect.timeoutOption("5 seconds"),
          );
          child?.process?.stdout?.destroy();
          child?.process?.stderr?.destroy();
        }),
      ),
    );
  });
export const DockerLive = Layer.succeed(Docker, {
  run: (args, cwd) => execute("docker", args, cwd),
});
export const KubectlLive = Layer.succeed(Kubectl, {
  run: (args, cwd) => execute("kubectl", args, cwd),
});
export const DeployPromptLive = Layer.succeed(DeployPrompt, {
  start: (label) =>
    Effect.sync(() => {
      const progress = spinner({ output: process.stderr });
      progress.start(label);
      return () => progress.stop(label);
    }),
});
export const DeployFilesLive = Layer.succeed(DeployFiles, {
  read: (path) =>
    Effect.tryPromise({
      try: async (signal) => {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Not a regular file");
        return readFile(path, { encoding: "utf8", signal });
      },
      catch: () =>
        deployFailure(
          "Cannot read function.yaml as a regular file.",
          "Run krun deploy in a function project, or pass its directory.",
        ),
    }),
  replace: (path, expected, content) =>
    Effect.suspend(() => {
      if (expected === content) return Effect.void;
      let settled = Promise.resolve();
      return Effect.tryPromise({
        try: (signal) => {
          const transaction = (async () => {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error("Not a regular file");
            const temporary = `${path}.krun-${randomUUID()}`;
            const handle = await open(temporary, "wx", info.mode & 0o777);
            try {
              await handle.writeFile(content, { signal });
              if ((await readFile(path, { encoding: "utf8", signal })) !== expected)
                throw new Error("Function changed during deploy");
              signal.throwIfAborted();
              await rename(temporary, path);
            } finally {
              await handle.close();
              await unlink(temporary).catch(() => undefined);
            }
          })();
          settled = transaction.then(
            () => undefined,
            () => undefined,
          );
          return transaction;
        },
        catch: () =>
          deployFailure(
            "Cannot update function.yaml, or it changed during deploy.",
            "Check file permissions and retry without concurrent edits.",
          ),
      }).pipe(Effect.onInterrupt(() => Effect.promise(() => settled)));
    }),
});
