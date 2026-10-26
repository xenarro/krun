import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, Layer } from "effect";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { Database, DatabasePostgres } from "../../runtime/database.js";
import { Store } from "../index.js";
import { StoreLive } from "../live.js";
import * as initial from "../migrations/postgres/0001_init.js";
import * as unicode from "../migrations/postgres/0002_opaque_unicode.js";
import * as results from "../migrations/postgres/0003_opaque_results.js";
import * as reports from "../migrations/postgres/0004_opaque_reports.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer(
    "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
  )
    .withName(`krun-test-p38-upgrade-${randomBytes(6).toString("hex")}`)
    .withDatabase("krun_test_p38_upgrade")
    .withPassword(randomBytes(32).toString("hex"))
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}, 120000);
afterAll(async () => {
  await postgres?.stop();
}, 120000);
it.effect(
  "opaque reports forward migration preserves shipped data,backfills heartbeat and rolls back atomically",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database;
      const store = yield* Store;
      const old = {
        "0001_init": initial,
        "0002_opaque_unicode": unicode,
        "0003_opaque_results": results,
      };
      yield* Effect.promise(() =>
        new Migrator({ db, provider: { getMigrations: async () => old } }).migrateToLatest(),
      );
      const at = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z"),
        id = "0192f000-0000-7000-8000-000000000038";
      yield* store.createRun({
        id,
        function_name: "echo",
        input: {},
        priority: 0,
        created_by: "test",
        request_hash: "a".repeat(64),
        idempotency_key: null,
        callback_url: "https://example.test/hook",
        created_at: at,
      });
      yield* store.setJobToken(id, "krun-test-p38-job", "b".repeat(64));
      yield* store.markScheduled(id);
      yield* store.transition(id, "scheduled", "running", null, {});
      const legacy = {
        message: "old",
        data: { nested: [null, false] },
        at: DateTime.formatIso(at),
      };
      yield* Effect.promise(() =>
        sql`update runs set runtime_status=${JSON.stringify(legacy)},error=${JSON.stringify({ source: "function", message: "old" })} where id=${id}`.execute(
          db,
        ),
      );
      const before = yield* store.getRun(id);
      const failed = yield* Effect.promise(() =>
        new Migrator({
          db,
          provider: {
            getMigrations: async () => ({
              ...old,
              "0004_opaque_reports": {
                up: async (db) => {
                  await reports.up(db);
                  throw new Error("Owned post-DDL rollback");
                },
              },
            }),
          },
        }).migrateToLatest(),
      );
      expect(failed.error).toBeDefined();
      expect(
        (yield* Effect.promise(() =>
          sql`select column_name from information_schema.columns where table_name='runs' and column_name='runtime_status_at'`.execute(
            db,
          ),
        )).rows,
      ).toHaveLength(0);
      expect(yield* store.getRun(id)).toEqual(before);
      expect(
        (yield* Effect.promise(() =>
          sql`select 1 from pg_proc where proname='krun_invalidate_runtime_status_at'`.execute(db),
        )).rows,
      ).toEqual([]);
      yield* store.migrate();
      yield* store.migrate();
      expect(yield* store.getRun(id)).toEqual(before);
      const meta = yield* Effect.promise(() =>
        sql<{
          status: string;
          error: string;
          at: string;
        }>`select pg_typeof(runtime_status)::text as status,pg_typeof(error)::text as error,runtime_status_at::text as at from runs where id=${id}`.execute(
          db,
        ),
      );
      expect(meta.rows[0]).toMatchObject({ status: "json", error: "json" });
      expect(meta.rows[0]?.at).toContain("2026-10-26");
      // Byte-equivalent parent setRuntimeStatus SQL: old writers do not know
      // runtime_status_at. A migrated reader must still use authoritative at.
      const cutoff = DateTime.add(at, { seconds: 60 });
      yield* store.setRuntimeStatus(id, { message: "old projection", at });
      expect((yield* store.listStale("echo", cutoff)).map((row) => row.id)).toContain(id);
      for (const legacyData of [
        { ordinary: true },
        JSON.parse('{"key\\u0000":"\\ud800","__proto__":true}'),
      ]) {
        const report = {
          message: "fresh legacy",
          data: legacyData,
          at: DateTime.formatIso(DateTime.add(at, { seconds: 120 })),
        };
        const updated = yield* Effect.promise(() =>
          db.transaction().execute(async (tx) => {
            const changed = await sql`update runs set runtime_status=${JSON.stringify(report)}
            where id=${id} and (state in ('scheduled','running')
              or (state='queued' and job_token_hash is not null)) returning *`.execute(tx);
            await sql`select pg_notify('krun_runs',${`${id}:status`})`.execute(tx);
            return changed.rows.length;
          }),
        );
        expect(updated).toBe(1);
        expect(
          (yield* Effect.promise(() =>
            sql`select runtime_status_at from runs where id=${id}`.execute(db),
          )).rows[0],
        ).toEqual({ runtime_status_at: null });
        expect((yield* store.getRun(id)).runtime_status?.data).toEqual(legacyData);
        expect((yield* store.listStale("echo", cutoff)).map((row) => row.id)).not.toContain(id);
      }
      yield* store.setRuntimeStatus(id, {
        message: "fresh projection",
        at: DateTime.add(at, { seconds: 120 }),
      });
      yield* Effect.promise(() =>
        sql`update runs set runtime_status=null where id=${id}`.execute(db),
      );
      expect((yield* store.listStale("echo", cutoff)).map((row) => row.id)).toContain(id);
      // Projection publication and opaque status replacement remain atomic;
      // same timestamp with different data must also work.
      yield* store.setRuntimeStatus(id, { message: "current again", at, data: { n: 1 } });
      yield* store.setRuntimeStatus(id, {
        message: "same time",
        at,
        data: JSON.parse('{"n":"\\u0000"}'),
      });
      expect((yield* store.listStale("echo", cutoff)).map((row) => row.id)).toContain(id);
      // A database failure publishing the projection must roll the status back,
      // not leave a committed heartbeat paired with an unrelated projection.
      const consistent = yield* store.getRun(id);
      yield* Effect.promise(async () => {
        await sql`create function krun_test_reject_projection() returns trigger language plpgsql as $$ begin raise exception 'Owned projection failure'; end $$`.execute(
          db,
        );
        await sql`create trigger krun_test_reject_projection before update of runtime_status_at on runs for each row execute function krun_test_reject_projection()`.execute(
          db,
        );
      });
      const rejected = yield* Effect.exit(
        store.setRuntimeStatus(id, { message: "must rollback", at: cutoff }),
      );
      yield* Effect.promise(() =>
        sql`drop trigger krun_test_reject_projection on runs`.execute(db),
      );
      expect(rejected._tag).toBe("Failure");
      expect(yield* store.getRun(id)).toEqual(consistent);
      expect((yield* store.listStale("echo", cutoff)).map((row) => row.id)).toContain(id);
      const details = JSON.parse(
        '{"nul":"\\u0000","surrogate":"\\ud800","__proto__":{"opaque":true}}',
      );
      yield* store.setRuntimeStatus(id, { message: "nul\0", data: details, at });
      yield* store.setError(id, { source: "function", message: "nul\0", details });
      expect((yield* store.getRun(id)).runtime_status?.data).toEqual(details);
      yield* store.transition(
        id,
        "running",
        "failed",
        "exit_code",
        { error: { source: "krun", message: "fallback" } },
        details,
      );
      expect((yield* store.getRun(id)).error).toEqual({
        source: "function",
        message: "nul\0",
        details,
      });
      const events = yield* Effect.promise(() =>
        sql<{
          payload: unknown;
        }>`select payload from run_events where run_id=${id} order by at desc`.execute(db),
      );
      expect(
        events.rows.some((row) => JSON.stringify(row.payload) === JSON.stringify(details)),
      ).toBe(true);
      const delivery = yield* Effect.promise(() =>
        sql<{
          payload: { error: { message: string } };
        }>`select payload from deliveries where run_id=${id}`.execute(db),
      );
      expect(delivery.rows[0]?.payload.error.message).toBe("nul\0");
    }).pipe(
      Effect.provide(
        StoreLive.pipe(Layer.provideMerge(DatabasePostgres(postgres.getConnectionUri()))),
      ),
    ),
);
