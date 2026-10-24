import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ConfigInvalid, parseDatabaseConfig } from "./index.js";

it.effect("parses embedded database defaults without process or namespace configuration", () =>
  Effect.gen(function* () {
    expect(yield* parseDatabaseConfig({ KRUN_DB_MODE: "embedded" })).toEqual({
      KRUN_DB_MODE: "embedded",
      KRUN_DB_PATH: "/data/krun.db",
    });
  }),
);

it.effect("defaults to postgres and preserves explicit database settings", () =>
  Effect.gen(function* () {
    const value = "synthetic-database-setting";
    const config = yield* parseDatabaseConfig({
      KRUN_DB_DSN: value,
      KRUN_DB_PATH: "krun-test-custom.db",
    });
    expect(config).toEqual({
      KRUN_DB_MODE: "postgres",
      KRUN_DB_DSN: value,
      KRUN_DB_PATH: "krun-test-custom.db",
    });
  }),
);

it.effect("normalizes empty fields with the same defaults as the process schemas", () =>
  Effect.gen(function* () {
    expect(
      yield* parseDatabaseConfig({
        KRUN_DB_MODE: "embedded",
        KRUN_DB_PATH: "",
        KRUN_DB_DSN: "",
      }),
    ).toEqual({ KRUN_DB_MODE: "embedded", KRUN_DB_PATH: "/data/krun.db" });
    expect(
      (yield* parseDatabaseConfig({
        KRUN_DB_MODE: "",
        KRUN_DB_DSN: "synthetic-database-setting",
      })).KRUN_DB_MODE,
    ).toBe("postgres");
  }),
);

it.effect("ignores unrelated invalid process settings and leaves its environment untouched", () =>
  Effect.gen(function* () {
    const env = Object.freeze({
      KRUN_DB_MODE: "embedded",
      KRUN_NAMESPACE: "",
      KRUN_MAX_QUEUED: "invalid",
      KRUN_ALLOWED_SERVICE_ACCOUNTS: "",
      KRUN_LOG_LEVEL: "invalid",
      KRUN_WEBHOOK_ALLOWED_CIDRS: "invalid",
    });
    const before = { ...env };
    expect(yield* parseDatabaseConfig(env)).toEqual({
      KRUN_DB_MODE: "embedded",
      KRUN_DB_PATH: "/data/krun.db",
    });
    expect(env).toEqual(before);
  }),
);

it.effect("retains the postgres requirement and redacts field errors", () =>
  Effect.gen(function* () {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "KRUN_DB_DSN"],
      [{ KRUN_DB_MODE: "postgres", KRUN_DB_DSN: "" }, "KRUN_DB_DSN"],
      [{ KRUN_DB_MODE: "not-a-mode" }, "KRUN_DB_MODE"],
    ];
    for (const [env, variable] of cases) {
      const error = yield* Effect.flip(parseDatabaseConfig(env));
      expect(error).toBeInstanceOf(ConfigInvalid);
      expect(error.variable).toBe(variable);
      expect(error.message).toBe(`Invalid configuration: ${variable}`);
      expect(Object.keys(error).sort()).toEqual(["_tag", "variable"]);
      expect(JSON.stringify(error)).not.toContain("not-a-mode");
    }
  }),
);
