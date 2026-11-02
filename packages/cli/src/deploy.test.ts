import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { parse } from "yaml";
import { deployCommand, imageWithDigest, waitReady } from "./deploy-command.js";
import {
  DeployEnvironment,
  DeployFilesLive,
  DeployPrompt,
  DeployTerminal,
  Docker,
  deployFailure,
  Kubectl,
} from "./deploy-services.js";

const digest = `sha256:${"a".repeat(64)}`;
const ready = (observedGeneration = 2, status = "True", reason = "Valid") =>
  JSON.stringify({
    metadata: { generation: 2 },
    status: { observedGeneration, conditions: [{ type: "Ready", status, reason, message: "" }] },
  });
const starter = `# yaml-language-server: $schema=https://example.test/function.json
apiVersion: krun.io/v1alpha1
kind: Function
metadata:
  name: sample
spec:
  # Keep this comment and the schema below.
  image: REPLACE_WITH_DIGEST
  inputSchema: {type: object}
  heartbeatTimeout: 5m
`;
const fixture = (
  options: {
    env?: Record<string, string>;
    push?: string;
    inspect?: string;
    yaml?: string;
    tty?: boolean;
    kubectl?: (args: readonly string[]) => Effect.Effect<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-deploy-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    yield* Effect.promise(() => writeFile(join(dir, "function.yaml"), options.yaml ?? starter));
    const calls: { tool: string; args: readonly string[]; cwd: string }[] = [];
    const output: { stream: string; text: string }[] = [];
    const spinners: string[] = [];
    const layers = Layer.mergeAll(
      DeployFilesLive,
      Layer.succeed(DeployEnvironment, {
        values: { KRUN_REGISTRY: "localhost:5001", ...options.env },
      }),
      Layer.succeed(DeployTerminal, {
        cwd: dir,
        isTTY: options.tty ?? false,
        output: (stream, text) =>
          Effect.sync(() => {
            output.push({ stream, text });
          }),
      }),
      Layer.succeed(DeployPrompt, {
        start: (label) =>
          Effect.sync(() => {
            spinners.push(label);
            return () => {
              spinners.push("stop");
            };
          }),
      }),
      Layer.succeed(Docker, {
        run: (args, cwd) =>
          Effect.sync(() => {
            calls.push({ tool: "docker", args, cwd });
            if (args[0] === "push") return options.push ?? `latest: digest: ${digest} size: 123\n`;
            if (args[0] === "inspect") return options.inspect ?? "";
            return "";
          }),
      }),
      Layer.succeed(Kubectl, {
        run: (args, cwd) =>
          Effect.gen(function* () {
            calls.push({ tool: "kubectl", args, cwd });
            return options.kubectl ? yield* options.kubectl(args) : ready();
          }),
      }),
    );
    return { dir, calls, output, spinners, layers };
  });

for (const fallback of [false, true])
  it.effect(
    `concurrent deploys pin their own build through a unique reference (inspect=${fallback})`,
    () =>
      Effect.gen(function* () {
        const a = yield* fixture();
        const b = yield* fixture();
        const aBuilt = yield* Deferred.make<void>();
        const bBuilt = yield* Deferred.make<void>();
        const tags = new Map<string, string>();
        const calls: { cwd: string; args: readonly string[] }[] = [];
        const ownDigest = (cwd: string) => `sha256:${(cwd === a.dir ? "a" : "b").repeat(64)}`;
        const docker = {
          run: (args: readonly string[], cwd: string) =>
            Effect.gen(function* () {
              calls.push({ cwd, args });
              if (args[0] === "build") {
                if (cwd === b.dir) yield* Deferred.await(aBuilt);
                tags.set(args[2] ?? "", ownDigest(cwd));
                if (cwd === a.dir) {
                  yield* Deferred.succeed(aBuilt, undefined);
                  yield* Deferred.await(bBuilt);
                } else yield* Deferred.succeed(bBuilt, undefined);
                return "";
              }
              if (args[0] === "push")
                return fallback ? "push acknowledged" : `digest: ${tags.get(args[1] ?? "")}`;
              return `localhost:5001/sample@${tags.get(args[3] ?? "")}`;
            }),
        };
        yield* Effect.all(
          [a, b].map((f) =>
            deployCommand(["--no-apply"]).pipe(
              Effect.provideService(Docker, docker),
              Effect.provide(f.layers),
            ),
          ),
          { concurrency: 2 },
        );
        for (const f of [a, b]) {
          const manifest = parse(
            yield* Effect.promise(() => readFile(join(f.dir, "function.yaml"), "utf8")),
          );
          expect(manifest.spec.image).toBe(`localhost:5001/sample@${ownDigest(f.dir)}`);
          const own = calls.filter((c) => c.cwd === f.dir);
          const tag = own[0]?.args[2];
          expect(tag).toMatch(/^localhost:5001\/sample:krun-[a-f0-9-]{36}$/);
          expect(own[1]?.args[1]).toBe(tag);
          if (fallback) expect(own[2]?.args[3]).toBe(tag);
        }
        expect(tags.size).toBe(2);
      }),
  );

it.effect("does not rewrite an already pinned image even when YAML formatting differs", () =>
  Effect.gen(function* () {
    const yaml = starter
      .replace("REPLACE_WITH_DIGEST", `localhost:5001/sample@${digest}`)
      .replace("type: object", "type:    object");
    const f = yield* fixture({ yaml });
    yield* deployCommand(["--no-apply"]).pipe(Effect.provide(f.layers));
    expect(yield* Effect.promise(() => readFile(join(f.dir, "function.yaml"), "utf8"))).toBe(yaml);
  }),
);

it.effect("never reads SDK mode or API key values from the environment", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const values = new Proxy(
      { KRUN_REGISTRY: "localhost:5001" } as Record<string, string | undefined>,
      {
        get: (target, key) => {
          if (key === "KRUN_GATEWAY_URL" || key === "KRUN_API_KEY")
            throw new Error("Forbidden environment read");
          return typeof key === "string" ? target[key] : undefined;
        },
      },
    );
    yield* deployCommand(["--no-apply"]).pipe(
      Effect.provideService(DeployEnvironment, { values }),
      Effect.provide(f.layers),
    );
  }),
);

it.effect(
  "a push failure leaves YAML untouched and stops the spinner before any inspect/apply",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ tty: true });
      const effect = deployCommand([]).pipe(
        Effect.provideService(Docker, {
          run: (args) =>
            args[0] === "push"
              ? Effect.fail(deployFailure("Push denied", "Run docker login."))
              : Effect.succeed(""),
        }),
        Effect.provide(f.layers),
      );
      expect((yield* Effect.exit(effect))._tag).toBe("Failure");
      expect(f.spinners.filter((s) => s === "stop")).toHaveLength(2);
      expect(f.calls).toEqual([]);
      expect(yield* Effect.promise(() => readFile(join(f.dir, "function.yaml"), "utf8"))).toBe(
        starter,
      );
    }),
);

it.effect("prints non-TTY progress every ten seconds and cancels it when a step ends", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* deployCommand(["--no-apply"]).pipe(
      Effect.provideService(Docker, {
        run: (args) =>
          args[0] === "build"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(""),
              )
            : Effect.succeed(`digest: ${digest}`),
      }),
      Effect.provide(f.layers),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("20 seconds");
    expect(
      f.output.filter((o) => o.text === "Building function image (still working)"),
    ).toHaveLength(2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    const count = f.output.length;
    yield* TestClock.adjust("30 seconds");
    expect(f.output).toHaveLength(count);
  }),
);

it.effect("builds, pushes, preserves YAML, validates, applies and prints three safe commands", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      env: {
        KRUN_API_KEY: "must-not-print",
        KRUN_GATEWAY_URL: "ignored",
        KRUN_JOBS_NAMESPACE: "test-jobs",
      },
    });
    yield* deployCommand([
      "--api-url",
      "https://api.example.test",
      "--namespace",
      "test-platform",
    ]).pipe(Effect.provide(f.layers));
    expect(f.calls.map((c) => [c.tool, c.args[0]])).toEqual([
      ["docker", "build"],
      ["docker", "push"],
      ["kubectl", "apply"],
      ["kubectl", "get"],
    ]);
    expect(f.calls[0]?.args).toEqual([
      "build",
      "-t",
      expect.stringMatching(/^localhost:5001\/sample:krun-[a-f0-9-]{36}$/),
      f.dir,
    ]);
    expect(f.calls[1]?.args[1]).toBe(f.calls[0]?.args[2]);
    expect(f.calls[2]?.args).toEqual([
      "apply",
      "-f",
      join(f.dir, "function.yaml"),
      "-n",
      "test-platform",
    ]);
    const yaml = yield* Effect.promise(() => readFile(join(f.dir, "function.yaml"), "utf8"));
    expect(yaml).toContain("# yaml-language-server:");
    expect(yaml).toContain("# Keep this comment");
    expect(parse(yaml).spec.image).toBe(`localhost:5001/sample@${digest}`);
    const stdout = f.output
      .filter((o) => o.stream === "stdout")
      .map((o) => o.text)
      .join("\n");
    expect(stdout).toContain("https://api.example.test/v1/functions/sample/runs");
    expect(stdout).toContain("$KRUN_API_KEY");
    expect(stdout).toContain("kubectl logs -f -n 'test-jobs' 'job/krun-<id>'");
    expect(stdout).toContain("https://api.example.test/v1/functions/sample/runs/<id>");
    expect(stdout).toContain("logTail");
    expect(f.output.map((o) => o.text).join("\n")).not.toMatch(/must-not-print|ignored/);
    expect(f.output.map((o) => o.text).join("\n")).not.toContain(String.fromCharCode(27));
    expect(f.output.some((o) => o.stream === "stderr" && o.text.includes("Ready=True"))).toBe(true);
  }),
);

it.effect("no-apply pins the digest and never calls kubectl or prints applied commands", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* deployCommand(["--no-apply"]).pipe(Effect.provide(f.layers));
    expect(f.calls.every((c) => c.tool === "docker")).toBe(true);
    expect(f.output.filter((o) => o.stream === "stdout").map((o) => o.text)).toEqual([
      `localhost:5001/sample@${digest}`,
    ]);
  }),
);

it.effect("flags override environment and retain a registry port", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      env: {
        KRUN_REGISTRY: "bad registry",
        KRUN_NAMESPACE: "bad namespace",
        KRUN_API_URL: "bad url",
      },
    });
    yield* deployCommand([
      "--registry",
      "localhost:5001/team",
      "--namespace",
      "test",
      "--api-url",
      "http://localhost:8080/base/",
    ]).pipe(Effect.provide(f.layers));
    expect(f.calls[0]?.args[2]).toMatch(/^localhost:5001\/team\/sample:krun-[a-f0-9-]{36}$/);
    expect(f.output.find((o) => o.stream === "stdout")?.text).toContain(
      "http://localhost:8080/base/v1/functions",
    );
  }),
);

for (const [inspect, succeeds] of [
  [`localhost:5001/sample@${digest}`, true],
  [`other.test/sample@${digest}`, false],
  ["", false],
  [`localhost:5001/sample@sha256:${"b".repeat(63)}`, false],
] as const)
  it.effect(`fallback accepts only the exact pushed repository (${inspect || "empty"})`, () =>
    Effect.gen(function* () {
      const f = yield* fixture({ push: "No digest in transcript", inspect });
      const result = yield* Effect.exit(
        deployCommand(["--no-apply"]).pipe(Effect.provide(f.layers)),
      );
      expect(result._tag === "Success").toBe(succeeds);
      expect(f.calls.map((c) => c.args[0])).toEqual(["build", "push", "inspect"]);
      if (!succeeds)
        expect(yield* Effect.promise(() => readFile(join(f.dir, "function.yaml"), "utf8"))).toBe(
          starter,
        );
    }),
  );

it.effect("validation failure after pinning never applies", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ env: { KRUN_ALLOWED_REGISTRIES: "allowed.test" } });
    const result = yield* Effect.exit(deployCommand([]).pipe(Effect.provide(f.layers)));
    expect(result._tag).toBe("Failure");
    expect(f.calls.every((c) => c.tool === "docker")).toBe(true);
  }),
);

for (const args of [
  ["--registry", "https://bad.test"],
  ["--namespace", "-wrong"],
  ["--api-url", "https://user:password@example.test"],
  ["--unknown"],
  ["one", "two"],
])
  it.effect(`rejects invalid arguments before spawning: ${args[0]}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* Effect.exit(deployCommand(args).pipe(Effect.provide(f.layers))))._tag).toBe(
        "Failure",
      );
      expect(f.calls).toEqual([]);
    }),
  );

for (const yaml of [
  "not: [valid",
  `${starter}\n---\n${starter}`,
  starter.replace("name: sample", "name: INVALID"),
  starter.replace("kind: Function", "kind: Secret"),
])
  it.effect("rejects invalid or multiple documents before spawning", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ yaml });
      expect((yield* Effect.exit(deployCommand([]).pipe(Effect.provide(f.layers))))._tag).toBe(
        "Failure",
      );
      expect(f.calls).toEqual([]);
    }),
  );

it.effect("waits past stale Ready and polls until the current generation is Ready", () =>
  Effect.gen(function* () {
    let reads = 0;
    const first = yield* Deferred.make<void>();
    const f = yield* fixture({
      kubectl: () =>
        Effect.gen(function* () {
          reads++;
          yield* Deferred.succeed(first, undefined);
          return ready(reads === 1 ? 1 : 2);
        }),
    });
    const fiber = yield* waitReady("sample", "krun").pipe(
      Effect.provide(f.layers),
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(reads).toBe(2);
  }),
);

it.effect("fails fast on a current-generation Ready=False", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ kubectl: () => Effect.succeed(ready(2, "False", "SchemaInvalid")) });
    const error = yield* Effect.flip(waitReady("sample", "krun").pipe(Effect.provide(f.layers)));
    expect(error.message).toContain("SchemaInvalid");
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect("caps even a hung kubectl at 120 seconds and supplies a diagnostic hint", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const f = yield* fixture({
      kubectl: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* Effect.flip(
      waitReady("sample", "krun").pipe(Effect.provide(f.layers)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("120 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error.hint).toContain("kubectl describe kfn");
    expect(error.message).toContain("120");
  }),
);

it.effect("starts and stops a TTY spinner for every long step", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ tty: true });
    yield* deployCommand([]).pipe(Effect.provide(f.layers));
    expect(f.spinners.filter((s) => s === "stop")).toHaveLength(4);
  }),
);

for (const reference of ["repo", "repo:tag", "host:5001/repo:tag", "repo@sha256:old"])
  it(`pins ${reference} without losing the registry port`, () => {
    expect(imageWithDigest(reference, digest)).toBe(
      `${reference === "host:5001/repo:tag" ? "host:5001/repo" : "repo"}@${digest}`,
    );
  });
