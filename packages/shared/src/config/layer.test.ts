import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ConfigInvalid, ConfigLive, KrunConfig } from "./index.js";

it.effect(
  "provides the discriminated Effect 4 config service without namespace I/O for an explicit namespace",
  () => {
    let reads = 0;
    return Effect.gen(function* () {
      const service = yield* KrunConfig;
      expect(service.role).toBe("gateway");
      if (service.role === "gateway") expect(service.config.KRUN_LISTEN_ADDR).toBe(":8080");
      expect(yield* KrunConfig).toBe(service);
      expect(reads).toBe(0);
    }).pipe(
      Effect.provide(
        ConfigLive("gateway", {
          env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "explicit" },
          readNamespace: Effect.sync(() => {
            reads++;
            return "unused";
          }),
        }),
      ),
    );
  },
);

it.effect(
  "snapshots env once and derives the scheduler URL from a trimmed ServiceAccount namespace",
  () => {
    const env = { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "", KRUN_MAX_QUEUED: "1000" };
    let reads = 0;
    return Effect.gen(function* () {
      const service = yield* KrunConfig;
      expect(service.role).toBe("scheduler");
      if (service.role === "scheduler") {
        expect(service.config.KRUN_NAMESPACE).toBe("from-file");
        expect(service.config.KRUN_GATEWAY_INTERNAL_URL).toBe(
          "http://krun-gateway-internal.from-file.svc:8081",
        );
        expect(service.config.KRUN_MAX_QUEUED).toBe(1000);
      }
      yield* KrunConfig;
      expect(reads).toBe(1);
    }).pipe(
      Effect.provide(
        ConfigLive("scheduler", {
          env,
          readNamespace: Effect.sync(() => {
            reads++;
            env.KRUN_MAX_QUEUED = "7";
            return "  from-file\n";
          }),
        }),
      ),
    );
  },
);

for (const readNamespace of [
  Effect.succeed(""),
  Effect.succeed(" \n "),
  Effect.fail("reader-error-sentinel"),
]) {
  it.effect("maps an empty or unreadable namespace file to a name-only configuration failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        KrunConfig.pipe(
          Effect.provide(
            ConfigLive("gateway", {
              env: { KRUN_DB_MODE: "embedded" },
              readNamespace,
            }),
          ),
        ),
      );
      expect(error).toBeInstanceOf(ConfigInvalid);
      expect(error.variable).toBe("KRUN_NAMESPACE");
      expect(JSON.stringify(error)).not.toContain("reader-error-sentinel");
    }),
  );
}

const shared = fileURLToPath(new URL("../../", import.meta.url));
const moduleUrl = new URL("../../dist/config/index.js", import.meta.url).href;
const node = (script: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: shared,
    env,
    encoding: "utf8",
    timeout: 10000,
  });

it.effect("importing config performs no namespace file read or process startup", () =>
  Effect.sync(() => {
    const result = node(`
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.readFile;
      fs.readFile = (...args) => {
        if (args[0] === '/var/run/secrets/kubernetes.io/serviceaccount/namespace') {
          throw new Error('namespace I/O during import');
        }
        return original(...args);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(moduleUrl)});
      console.log('import-only');
    `);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("import-only\n");
    expect(result.stderr).toBe("");
  }),
);

it.effect("the live layer reads a sanitized process environment only at acquisition", () =>
  Effect.sync(() => {
    const result = node(
      `
      import { Effect } from 'effect';
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
      import { ConfigLive, KrunConfig } from ${JSON.stringify(moduleUrl)};
      const live = ConfigLive('gateway');
      process.env.KRUN_MAX_QUEUED = '7';
      NodeRuntime.runMain(Effect.gen(function* () {
        const { config } = yield* KrunConfig;
        console.log(config.KRUN_NAMESPACE, config.KRUN_MAX_QUEUED);
      }).pipe(Effect.provide(live)));
    `,
      { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "fixture" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fixture 7\n");
    expect(result.stderr).toBe("");
  }),
);

it.effect(
  "a dedicated startup fixture fails through NodeRuntime with exit1 and no sensitive values",
  () =>
    Effect.sync(() => {
      const result = node(`
      import { Effect, Layer } from 'effect';
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
      import { ConfigLive } from ${JSON.stringify(moduleUrl)};
      NodeRuntime.runMain(Layer.launch(ConfigLive('scheduler', { env: {
        KRUN_DB_MODE: 'postgres',
        KRUN_NAMESPACE: 'fixture',
        KRUN_DB_DSN: 'private-dsn-sentinel',
        KRUN_S3_SECRET_KEY: 'private-secret-sentinel',
        KRUN_RETENTION: 'private-duration-sentinel'
      }})));
    `);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("KRUN_RETENTION");
      for (const value of [
        "private-dsn-sentinel",
        "private-secret-sentinel",
        "private-duration-sentinel",
      ]) {
        expect(output).not.toContain(value);
      }
    }),
);
