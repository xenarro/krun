import { watch } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { DeployFiles, DeployFilesLive, execute } from "./deploy-services.js";

it.effect("real tinyexec captures success and never exposes failed child output", () =>
  Effect.gen(function* () {
    const output = yield* execute(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      process.cwd(),
    );
    expect(output).toBe("out\nerr");
    const error = yield* Effect.flip(
      execute(
        process.execPath,
        ["-e", "console.error('private-child-output'); process.exit(7)"],
        process.cwd(),
      ),
    );
    expect(error.message).toBe("Kubectl command failed.");
    expect(JSON.stringify(error)).not.toContain("private-child-output");
    const missing = yield* Effect.flip(execute("krun-test-missing-command", [], process.cwd()));
    expect(missing.message).toBe("Command could not start.");
  }),
);

it.effect("interruption joins a real tinyexec child even when it ignores SIGTERM", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-deploy-child-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const ready = yield* Deferred.make<void>();
    const observed = yield* Deferred.make<void>();
    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() =>
        watch(root, (_event, filename) => {
          if (filename === "pid") Effect.runFork(Deferred.succeed(observed, undefined));
        }),
      ),
      (handle) => Effect.sync(() => handle.close()),
    );
    const program = `import {writeFileSync,renameSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(join(root, "pid.pending"))},String(process.pid)); renameSync(${JSON.stringify(join(root, "pid.pending"))},${JSON.stringify(join(root, "pid"))}); setInterval(()=>{},1000);`;
    const fiber = yield* execute(
      process.execPath,
      ["--input-type=module", "-e", program],
      root,
    ).pipe(Effect.ensuring(Deferred.succeed(ready, undefined)), Effect.forkChild);
    yield* Deferred.await(observed);
    watcher.close();
    const pid = Number(yield* Effect.promise(() => readFile(join(root, "pid"), "utf8")));
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(ready);
    expect(() => process.kill(pid, 0)).toThrow();
  }),
);

it.effect("atomic replacement preserves permissions and refuses a stale expected file", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-deploy-files-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const file = join(root, "function.yaml");
    yield* Effect.promise(() => writeFile(file, "original", { mode: 0o640 }));
    yield* Effect.gen(function* () {
      const fs = yield* DeployFiles;
      yield* fs.replace(file, "original", "pinned");
      expect(yield* fs.read(file)).toBe("pinned");
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o640);
      expect((yield* Effect.exit(fs.replace(file, "original", "lost edit")))._tag).toBe("Failure");
      expect(yield* fs.read(file)).toBe("pinned");
      expect(yield* Effect.promise(() => readdir(root))).toEqual(["function.yaml"]);
    }).pipe(Effect.provide(DeployFilesLive));
  }),
);
