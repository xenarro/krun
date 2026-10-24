import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { ConfigInvalid, parseDatabaseConfig } from "../config/index.js";
import { DatabasePostgres, DatabaseSqlite } from "../runtime/database.js";
import { migrate } from "./migrations.js";

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    yield* Effect.sync(() => console.log("Usage: krun migrate"));
    return;
  }
  if (args.length !== 0) {
    yield* Effect.logError("Usage: krun migrate");
    yield* Effect.sync(() => {
      process.exitCode = 1;
    });
    return;
  }
  // The migration hook has no ServiceAccount mount. Never acquire the full
  // gateway/scheduler config, namespace, keys or unrelated telemetry settings.
  const config = yield* parseDatabaseConfig({
    KRUN_DB_MODE: process.env.KRUN_DB_MODE,
    KRUN_DB_DSN: process.env.KRUN_DB_DSN,
    KRUN_DB_PATH: process.env.KRUN_DB_PATH,
  });
  if (config.KRUN_DB_MODE === "embedded") {
    yield* migrate.pipe(Effect.provide(DatabaseSqlite(config.KRUN_DB_PATH)));
  } else {
    if (config.KRUN_DB_DSN === undefined)
      return yield* Effect.fail(new ConfigInvalid({ variable: "KRUN_DB_DSN" }));
    yield* migrate.pipe(Effect.provide(DatabasePostgres(config.KRUN_DB_DSN)));
  }
});

NodeRuntime.runMain(main);
