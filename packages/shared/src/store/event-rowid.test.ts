import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { type KyselyPlugin, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterEach, beforeEach } from "vitest";
import { Database, DatabaseSqlite } from "../runtime/database.js";
import { makeCreateRun } from "./create-run.js";
import { DatabaseError } from "./errors.js";
import * as initial from "./migrations/sqlite/0001_init.js";
import { migrate } from "./migrations.js";
import { makeRunMaintenance } from "./run-maintenance.js";
import { makeTransition } from "./transition.js";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "krun-test-repair-p18-migration-"));
  path = join(directory, "runs.db");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({
      try: () => f(db),
      catch: () => new Error("Owned event-rowid migration query failed"),
    }),
  );
const legacy = query(async (db) => {
  const result = await new Migrator({
    db,
    provider: { getMigrations: async () => ({ "0001_init": initial }) },
  }).migrateToLatest();
  if (result.error !== undefined) throw new Error("Owned legacy event schema failed");
});
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const seed = (n: number) =>
  Effect.gen(function* () {
    const create = yield* makeCreateRun;
    yield* create({
      id: id(n),
      idempotency_key: null,
      request_hash: "a".repeat(64),
      function_name: "migration",
      input: {},
      priority: 0,
      callback_url: null,
      created_by: "owner",
      created_at: yield* DateTime.now,
    });
  });
const history = () =>
  query(async (db) =>
    (
      await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)
    ).rows.map((r) => r.name),
  );
const rows = () =>
  query(
    async (db) =>
      (
        await sql`select rowid,run_id,at,from_state,to_state,reason,payload from run_events order by rowid`.execute(
          db,
        )
      ).rows,
  );
const columns = () =>
  query(
    async (db) =>
      (
        await sql<{
          name: string;
          pk: number;
        }>`select name,pk from pragma_table_info('run_events')`.execute(db)
      ).rows,
  );
const legacyData = Effect.gen(function* () {
  yield* legacy;
  yield* seed(1);
  const transition = yield* makeTransition;
  yield* transition(
    id(1),
    "queued",
    "failed",
    "job_create_failed",
    { failure_reason: "job_create_failed" },
    { actor: "owner" },
  );
  yield* query((db) => sql`update run_events set rowid=rowid*10`.execute(db));
});

it.effect(
  "forward event migration preserves sparse legacy rowids,metadata,index,cascade and idempotent history",
  () =>
    Effect.gen(function* () {
      yield* legacyData;
      const before = yield* rows();
      expect((yield* columns()).some((c) => c.name === "rowid")).toBe(false);
      yield* migrate;
      expect(yield* rows()).toEqual(before);
      expect(yield* history()).toEqual(["0001_init", "0002_event_rowid"]);
      expect((yield* columns()).find((c) => c.name === "rowid")?.pk).toBe(1);
      const indexes = yield* query(
        async (db) =>
          (
            await sql<{
              name: string;
            }>`select name from sqlite_master where type='index' and tbl_name='run_events'`.execute(
              db,
            )
          ).rows,
      );
      expect(indexes).toEqual([{ name: "run_events_run_idx" }]);
      expect(
        yield* query(async (db) => (await sql`pragma foreign_key_check`.execute(db)).rows),
      ).toEqual([]);
      yield* migrate;
      expect(yield* rows()).toEqual(before);
      yield* seed(2);
      const next = yield* query(
        async (db) =>
          (
            await sql<{
              rowid: number;
            }>`select rowid from run_events where run_id=${id(2)}`.execute(db)
          ).rows[0]?.rowid,
      );
      expect(next).toBeGreaterThan(20);
      yield* query((db) => sql`delete from runs where id=${id(2)}`.execute(db));
      expect(yield* rows()).toEqual(before);
    }).pipe(Effect.provide(DatabaseSqlite(path))),
);

it.effect(
  "allocator survives normal cascade retention,incremental vacuum and connection restart",
  () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* legacyData;
        yield* migrate;
        yield* TestClock.adjust("720 hours");
        yield* TestClock.adjust("1 millis");
        const maintenance = yield* makeRunMaintenance;
        expect(
          yield* maintenance.sweep(DateTime.subtractDuration(yield* DateTime.now, "720 hours"), 10),
        ).toBe(1);
        expect(yield* rows()).toEqual([]);
        expect(
          yield* query(
            async (db) =>
              (
                await sql<{
                  seq: number;
                }>`select seq from sqlite_sequence where name='run_events'`.execute(db)
              ).rows[0]?.seq,
          ),
        ).toBe(20);
      }).pipe(Effect.provide(DatabaseSqlite(path)));
      yield* Effect.gen(function* () {
        yield* migrate;
        yield* seed(2);
        const transition = yield* makeTransition;
        yield* transition(id(2), "queued", "cancelling", null, {});
        const fresh = yield* query(async (db) =>
          (
            await sql<{ rowid: number }>`select rowid from run_events order by rowid`.execute(db)
          ).rows.map((r) => r.rowid),
        );
        expect(fresh).toEqual([21, 22]);
      }).pipe(Effect.provide(DatabaseSqlite(path)));
    }),
);

it.effect(
  "late forward-migration failure restores old rows,schema,index and history before retry",
  () =>
    Effect.gen(function* () {
      yield* legacyData;
      const before = yield* rows();
      const beforeColumns = yield* columns();
      const database = yield* Database;
      const plugin: KyselyPlugin = {
        transformQuery(args) {
          if (
            args.node.kind === "RawNode" &&
            args.node.sqlFragments.join("").includes("create index run_events_run_idx")
          )
            throw new Error("Owned late migration failure");
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      };
      const error = yield* migrate.pipe(
        Effect.provideService(Database, { ...database, db: database.db.withPlugin(plugin) }),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(DatabaseError);
      expect(JSON.stringify(error)).not.toContain("Owned late");
      expect(yield* rows()).toEqual(before);
      expect(yield* columns()).toEqual(beforeColumns);
      expect(yield* history()).toEqual(["0001_init"]);
      const scratch = yield* query(
        async (db) =>
          (
            await sql`select name from sqlite_master where name='krun_run_events_monotonic'`.execute(
              db,
            )
          ).rows,
      );
      expect(scratch).toEqual([]);
      yield* migrate;
      expect(yield* rows()).toEqual(before);
      expect(yield* history()).toEqual(["0001_init", "0002_event_rowid"]);
    }).pipe(Effect.provide(DatabaseSqlite(path))),
);
