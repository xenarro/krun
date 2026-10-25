import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sql } from "kysely";
import { afterEach, beforeEach, vi } from "vitest";
import { Database, DatabaseSqlite } from "../../runtime/database.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "krun-test-repair-p111-init-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it.effect(
  "applies required connection policy before persistent initialization writes on every open",
  () =>
    Effect.gen(function* () {
      const observations: { synchronous: unknown; busy_timeout: unknown }[] = [];
      const original = DatabaseSync.prototype.exec;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
            this: DatabaseSync,
            statement: string,
          ) {
            if (
              statement === "pragma auto_vacuum = INCREMENTAL" ||
              statement === "pragma journal_mode = WAL"
            ) {
              observations.push({
                synchronous: this.prepare("pragma synchronous").get()?.synchronous,
                busy_timeout: this.prepare("pragma busy_timeout").get()?.timeout,
              });
            }
            return original.call(this, statement);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      for (const _ of [0, 1]) {
        yield* Effect.gen(function* () {
          const { db } = yield* Database;
          const rows = yield* Effect.promise(async () => ({
            vacuum: (await sql`pragma auto_vacuum`.execute(db)).rows[0],
            journal: (await sql`pragma journal_mode`.execute(db)).rows[0],
            foreign: (await sql`pragma foreign_keys`.execute(db)).rows[0],
          }));
          expect(rows).toEqual({
            vacuum: { auto_vacuum: 2 },
            journal: { journal_mode: "wal" },
            foreign: { foreign_keys: 1 },
          });
        }).pipe(Effect.provide(DatabaseSqlite(join(directory, "runs.db"))));
      }
      expect(observations).toEqual(
        Array.from({ length: 4 }, () => ({ synchronous: 1, busy_timeout: 5000 })),
      );
    }),
);
