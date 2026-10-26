import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, Layer, type Scope } from "effect";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { ConflictError, DatabaseError } from "../errors.js";
import { Store } from "../index.js";
import { StoreLive } from "../live.js";
import * as initial from "../migrations/postgres/0001_init.js";
import * as unicode from "../migrations/postgres/0002_opaque_unicode.js";
import * as opaqueResults from "../migrations/postgres/0003_opaque_results.js";
import type { NewRun } from "../model.js";
import { requestHash } from "../request-hash.js";
import { decodeRun } from "../rows.js";

let container: StartedPostgreSqlContainer;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p33-repair-unicode-${process.pid}`)
      .withDatabase("krun_test_p33_repair")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned Unicode fixture failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({ try: () => f(db), catch: () => new Error("Owned Unicode query failed") }),
  );
const fresh = (
  n: number,
  key: string | null,
  input: NewRun["input"] = { "\0key": ["\0", { literal: "\\u0000", unicode: "🧪" }] },
) =>
  Effect.gen(function* () {
    return {
      id: `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
      idempotency_key: key,
      request_hash: yield* requestHash({ input, priority: 0 }),
      input,
      priority: 0,
      callback_url: null,
      created_by: "owner",
      function_name: "unicode",
      created_at: yield* DateTime.now,
    } satisfies NewRun;
  });

for (const dialect of ["sqlite", "postgres"] as const)
  describe(`opaque Unicode ${dialect}`, () => {
    let dir: string;
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "krun-test-p33-repair-unicode-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned Unicode schema reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const use = <A, E>(body: Effect.Effect<A, E, Store | Database | Scope.Scope>) =>
      body.pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provideMerge(
              dialect === "postgres"
                ? DatabasePostgres(dsn)
                : DatabaseSqlite(join(dir, "store.sqlite")),
            ),
          ),
        ),
        Effect.scoped,
      );

    it.effect("retains opaque Unicode results through both reporting and terminal CAS writes", () =>
      use(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          const values = [
            "before\0after",
            { "\0key": ["\0", { literal: "\\u0000", unicode: "🧪" }] },
            JSON.parse('{"__proto__":{"nul":"\\u0000"},"nested":[null,false,0]}'),
          ];
          for (const [n, value] of values.entries()) {
            const reported = yield* fresh(20 + n, null);
            yield* store.createRun(reported);
            yield* store.setJobToken(reported.id, "krun-test-p36-result", "b".repeat(64));
            yield* store.markScheduled(reported.id);
            expect(yield* store.setResult(reported.id, value)).toBe(true);
            expect((yield* store.getRun(reported.id)).result).toEqual(value);
            yield* store.transition(reported.id, "scheduled", "succeeded", null, {});
            expect((yield* store.getRun(reported.id)).result).toEqual(value);
            const patched = yield* fresh(30 + n, null);
            yield* store.createRun(patched);
            yield* store.setJobToken(patched.id, "krun-test-p36-result", "b".repeat(64));
            yield* store.markScheduled(patched.id);
            expect(
              yield* store.transition(patched.id, "scheduled", "succeeded", null, {
                result: value,
              }),
            ).toBe(true);
            expect((yield* store.getRun(patched.id)).result).toEqual(value);
          }
        }),
      ),
    );

    it.effect(
      "retains literal keys, values and exact opaque IDs across insertion, lookup, BASIC and scope reopen",
      () => {
        const keys = [
          "a\0b",
          "a\\u0000b",
          "",
          null,
          "\0🧪\0",
          "a\0b\u200b",
          `${"a".repeat(127)}\0`,
        ];
        return Effect.gen(function* () {
          yield* use(
            Effect.gen(function* () {
              const store = yield* Store;
              yield* store.migrate();
              for (const [n, key] of keys.entries()) {
                const value = yield* fresh(n + 1, key);
                const result = yield* store.createRun(value);
                expect(result.created).toBe(true);
                expect(result.run.input).toEqual(value.input);
                expect(result.run.idempotency_key).toBe(key);
                expect((yield* store.getRun(value.id)).input).toEqual(value.input);
                if (key !== null)
                  expect((yield* store.findRunByRequestId("unicode", "owner", key))?.id).toBe(
                    value.id,
                  );
              }
              expect(
                (yield* store.listRuns({ function_name: "unicode" }, null, 100)).runs,
              ).toHaveLength(keys.length);
            }),
          );
          yield* use(
            Effect.gen(function* () {
              const store = yield* Store;
              yield* store.migrate();
              for (const [n, key] of keys.entries())
                if (key !== null) {
                  const row = yield* store.findRunByRequestId("unicode", "owner", key);
                  expect(row?.idempotency_key).toBe(key);
                  expect(row?.input).toEqual((yield* fresh(n + 1, key)).input);
                }
            }),
          );
        });
      },
    );

    it.effect(
      "uses database uniqueness for concurrent NUL-key replay, conflicts and owner/function isolation",
      () =>
        use(
          Effect.gen(function* () {
            const store = yield* Store;
            yield* store.migrate();
            const values = yield* Effect.forEach(
              Array.from({ length: 20 }, (_, n) => n + 1),
              (n) => fresh(n, "same\0key"),
            );
            const results = yield* Effect.all(
              values.map((value) => store.createRun(value)),
              { concurrency: "unbounded" },
            );
            expect(results.filter((r) => r.created)).toHaveLength(1);
            expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
            expect(results.every((r) => r.run.idempotency_key === "same\0key")).toBe(true);
            expect(
              yield* Effect.flip(store.createRun(yield* fresh(21, "same\0key", { changed: true }))),
            ).toBeInstanceOf(ConflictError);
            expect(
              (yield* store.createRun({ ...(yield* fresh(22, "same\0key")), created_by: "other" }))
                .created,
            ).toBe(true);
            expect(
              (yield* store.createRun({
                ...(yield* fresh(23, "same\0key")),
                function_name: "other",
              })).created,
            ).toBe(true);
            expect((yield* store.createRun(yield* fresh(24, "same\\u0000key"))).created).toBe(true);
            expect(
              yield* store.findRunByRequestId("unicode", "missing", "same\0key"),
            ).toBeUndefined();
            expect(
              yield* query(
                async (db) =>
                  (
                    await sql<{
                      n: number;
                    }>`select cast(count(*) as integer) as n from run_events`.execute(db)
                  ).rows[0]?.n,
              ),
            ).toBe(4);
          }),
        ),
    );

    it.effect("rolls back a NUL-bearing run if its initial event insertion fails", () =>
      use(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          yield* query((db) => db.schema.dropTable("run_events").execute());
          expect(
            yield* Effect.flip(store.createRun(yield* fresh(1, "rollback\0key"))),
          ).toBeInstanceOf(DatabaseError);
          expect(
            yield* query(
              async (db) =>
                (
                  await sql<{ n: number }>`select cast(count(*) as integer) as n from runs`.execute(
                    db,
                  )
                ).rows[0]?.n,
            ),
          ).toBe(0);
        }),
      ),
    );

    if (dialect === "postgres") {
      const initialOnly = query(async (db) => {
        const result = await new Migrator({
          db,
          provider: { getMigrations: async () => ({ "0001_init": initial }) },
        }).migrateToLatest();
        if (result.error) throw new Error("Owned initial migration failed");
      });
      it.effect(
        "upgrades result storage from the shipped two-migration schema atomically without changing data or events",
        () =>
          use(
            Effect.gen(function* () {
              yield* query(async (db) => {
                const result = await new Migrator({
                  db,
                  provider: {
                    getMigrations: async () => ({
                      "0001_init": initial,
                      "0002_opaque_unicode": unicode,
                    }),
                  },
                }).migrateToLatest();
                if (result.error) throw new Error("Owned previous-schema setup failed");
              });
              const store = yield* Store;
              const run = yield* fresh(1, null, { legacy: true });
              yield* store.createRun(run);
              yield* store.setJobToken(run.id, "krun-test-p36-upgrade", "b".repeat(64));
              yield* store.markScheduled(run.id);
              yield* store.setResult(run.id, { legacy: [false, 0, null], literal: "\\u0000" });
              const before = yield* store.getRun(run.id);
              const beforeEvents = yield* query(
                async (db) => (await sql`select * from run_events`.execute(db)).rows,
              );
              const failed = yield* query(
                async (db) =>
                  await new Migrator({
                    db,
                    provider: {
                      getMigrations: async () => ({
                        "0001_init": initial,
                        "0002_opaque_unicode": unicode,
                        "0003_opaque_results": {
                          up: async (tx) => {
                            await opaqueResults.up(tx);
                            throw new Error("Owned post-DDL failure");
                          },
                        },
                      }),
                    },
                  }).migrateToLatest(),
              );
              expect(failed.error).toBeDefined();
              const storage = () =>
                query(
                  async (db) =>
                    (
                      await sql<{
                        storage: string;
                      }>`select pg_typeof(result)::text as storage from runs limit 1`.execute(db)
                    ).rows[0]?.storage,
                );
              expect(yield* storage()).toBe("jsonb");
              expect(yield* store.getRun(run.id)).toEqual(before);
              expect(
                (yield* query(
                  async (db) =>
                    (
                      await sql<{
                        name: string;
                      }>`select name from kysely_migration order by name`.execute(db)
                    ).rows,
                )).map((r) => r.name),
              ).toEqual(["0001_init", "0002_opaque_unicode"]);
              yield* store.migrate();
              yield* store.migrate();
              expect(yield* storage()).toBe("json");
              expect(yield* store.getRun(run.id)).toEqual(before);
              expect(
                yield* query(async (db) => (await sql`select * from run_events`.execute(db)).rows),
              ).toEqual(beforeEvents);
              expect(yield* store.setResult(run.id, "after\0upgrade")).toBe(true);
              expect((yield* store.getRun(run.id)).result).toBe("after\0upgrade");
            }),
          ),
      );

      it.effect(
        "upgrades shipped data without rewriting text keys and preserves legacy SQL writers/readers",
        () =>
          use(
            Effect.gen(function* () {
              yield* initialOnly;
              const store = yield* Store;
              const original = yield* fresh(1, 'literal\\u0000🧪"', { legacy: { x: 1 } });
              yield* store.createRun(original);
              const events = yield* query(
                async (db) => (await sql`select * from run_events`.execute(db)).rows,
              );
              yield* store.migrate();
              yield* store.migrate();
              expect((yield* store.getRun(original.id)).idempotency_key).toBe(
                original.idempotency_key,
              );
              expect(
                (yield* store.createRun({ ...original, id: (yield* fresh(2, null)).id })).created,
              ).toBe(false);
              expect(
                yield* query(async (db) => (await sql`select * from run_events`.execute(db)).rows),
              ).toEqual(events);
              const newer = yield* fresh(3, "ordinary-after-upgrade");
              // The shipped explicit-column / text-index statement still works. json
              // preserves escaped NUL and pg's existing JSON parser returns it exactly.
              const rows = yield* query(
                async (db) =>
                  (
                    await sql`insert into runs
        (id,idempotency_key,request_hash,function_name,input,created_by,created_at,state)
        values (${newer.id},${newer.idempotency_key},${newer.request_hash},${newer.function_name},${JSON.stringify(newer.input)},${newer.created_by},${DateTime.formatIso(newer.created_at)},'queued')
        on conflict (created_by,function_name,idempotency_key) where idempotency_key is not null do nothing returning *`.execute(
                      db,
                    )
                  ).rows,
              );
              expect(rows).toHaveLength(1);
              expect(decodeRun(rows[0], "postgres").input).toEqual(newer.input);
              expect(
                (yield* store.createRun({ ...newer, id: (yield* fresh(4, null)).id })).created,
              ).toBe(false);
              expect(
                yield* query(
                  async (db) =>
                    (
                      await sql<{
                        storage: string;
                      }>`select pg_typeof(input)::text as storage from runs limit 1`.execute(db)
                    ).rows[0]?.storage,
                ),
              ).toBe("json");
              expect(
                (yield* query(
                  async (db) =>
                    (
                      await sql<{
                        name: string;
                      }>`select name from kysely_migration order by name`.execute(db)
                    ).rows,
                )).map((x) => x.name),
              ).toEqual([
                "0001_init",
                "0002_opaque_unicode",
                "0003_opaque_results",
                "0004_opaque_reports",
              ]);
            }),
          ),
      );

      it.effect(
        "rolls back the entire forward migration on DDL failure and retries without data loss",
        () =>
          use(
            Effect.gen(function* () {
              yield* initialOnly;
              const store = yield* Store;
              const value = yield* fresh(1, "before", { before: true });
              yield* store.createRun(value);
              yield* query((db) =>
                sql`create index runs_idem_nul_idx on runs(created_by)`.execute(db),
              );
              expect(yield* Effect.flip(store.migrate())).toBeInstanceOf(DatabaseError);
              expect(
                yield* query(
                  async (db) =>
                    (
                      await sql<{
                        storage: string;
                      }>`select pg_typeof(input)::text as storage from runs limit 1`.execute(db)
                    ).rows[0]?.storage,
                ),
              ).toBe("jsonb");
              expect(
                yield* query(
                  async (db) =>
                    (
                      await sql`select column_name from information_schema.columns where table_schema='public' and table_name='runs' and column_name='idempotency_key_nul'`.execute(
                        db,
                      )
                    ).rows,
                ),
              ).toHaveLength(0);
              expect((yield* store.getRun(value.id)).input).toEqual(value.input);
              yield* query((db) => sql`drop index runs_idem_nul_idx`.execute(db));
              // The exported forward migration also rolls back under an
              // explicitly aborted caller transaction, not just the migrator.
              yield* Effect.flip(
                query((db) =>
                  db.transaction().execute(async (tx) => {
                    await unicode.up(tx);
                    throw new Error("Owned intentional migration rollback");
                  }),
                ),
              );
              expect(
                yield* query(
                  async (db) =>
                    (
                      await sql<{
                        storage: string;
                      }>`select pg_typeof(input)::text as storage from runs limit 1`.execute(db)
                    ).rows[0]?.storage,
                ),
              ).toBe("jsonb");
              yield* store.migrate();
              expect(
                (yield* store.createRun(yield* fresh(2, "after\0migration"))).run.idempotency_key,
              ).toBe("after\0migration");
              const row = yield* query(
                async (db) =>
                  (
                    await sql<
                      Record<string, unknown>
                    >`select * from runs where id=${value.id}`.execute(db)
                  ).rows[0],
              );
              expect(() =>
                decodeRun(
                  { ...row, idempotency_key: null, idempotency_key_nul: Buffer.from([0]) },
                  "postgres",
                ),
              ).toThrow("Invalid identifier storage");
              expect(() =>
                decodeRun(
                  {
                    ...row,
                    idempotency_key: null,
                    idempotency_key_nul: Buffer.from("no-null", "utf16le"),
                  },
                  "postgres",
                ),
              ).toThrow("Invalid identifier storage");
              yield* query((db) =>
                sql`update runs set idempotency_key=null, idempotency_key_nul=${Buffer.from("no-null", "utf16le")} where id=${value.id}`.execute(
                  db,
                ),
              );
              expect(yield* Effect.flip(store.getRun(value.id))).toBeInstanceOf(DatabaseError);
            }),
          ),
      );
    }
  });
