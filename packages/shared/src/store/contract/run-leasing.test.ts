import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, type Scope, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { sql } from "kysely";
import { Client, Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { DatabaseError } from "../errors.js";
import { migrate } from "../migrations.js";
import type { NewRun, State } from "../model.js";
import { decodeRun } from "../rows.js";
import { activePredicate, countByStateQuery, makeRunLeasing } from "../run-leasing.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p14-leasing-${process.pid}`)
      .withDatabase("krun_test_p14")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned leasing Postgres fixture failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({
      try: () => f(db),
      catch: () => new Error("Owned leasing fixture query failed"),
    }),
  );
const seed = (n: number, changes: Partial<NewRun> = {}, state: State = "queued") =>
  Effect.gen(function* () {
    const create = yield* makeCreateRun;
    const value: NewRun = {
      id: id(n),
      idempotency_key: null,
      request_hash: "a".repeat(64),
      function_name: "function-a",
      input: { opaque: { b: 2, a: 1 } },
      priority: 0,
      callback_url: null,
      created_by: "owner-a",
      created_at: yield* DateTime.now,
      ...changes,
    };
    yield* create(value);
    if (state !== "queued")
      yield* query((db) => sql`update runs set state=${state} where id=${value.id}`.execute(db));
    return value;
  });
const stored = (n: number) =>
  Effect.flatMap(Database, ({ db, dialect }) =>
    Effect.tryPromise({
      try: async () =>
        decodeRun((await sql`select * from runs where id=${id(n)}`.execute(db)).rows[0], dialect),
      catch: () => new Error("Owned leasing fixture decode failed"),
    }),
  );
const events = () =>
  query(
    async (db) =>
      (
        await sql<{
          at: unknown;
          from_state: string | null;
          to_state: string;
          reason: string | null;
          payload: unknown;
        }>`select * from run_events order by at`.execute(db)
      ).rows,
  );

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`run leasing contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p14-leasing-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned leasing schema reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const run = <A, E>(program: Effect.Effect<A, E, Database | Scope.Scope>) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T00:00:00.000Z")),
        );
        yield* migrate;
        return yield* program;
      }).pipe(
        Effect.provide(
          dialect === "sqlite" ? DatabaseSqlite(join(directory, "runs.db")) : DatabasePostgres(dsn),
        ),
      );
    it.effect("two concurrent claimers never share a live lease; state/events unchanged", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          for (let n = 1; n <= 20; n++) yield* seed(n);
          const until = DateTime.addDuration(yield* DateTime.now, "30 seconds");
          const results = yield* Effect.all(
            [
              m.claimQueued("function-a", "leader-a", until, 10),
              m.claimQueued("function-a", "leader-b", until, 10),
            ],
            { concurrency: "unbounded" },
          );
          const all = results.flat();
          expect(all).toHaveLength(20);
          expect(new Set(all.map((r) => r.id)).size).toBe(20);
          for (const row of all) {
            expect(row.state).toBe("queued");
            expect(row.attempt).toBe(1);
            expect(["leader-a", "leader-b"]).toContain(row.lease_owner);
            expect(DateTime.formatIso(row.lease_until ?? DateTime.makeUnsafe(0))).toBe(
              DateTime.formatIso(until),
            );
          }
          expect(yield* m.claimQueued("function-a", "leader-c", until, 20)).toEqual([]);
          expect(yield* m.countQueued("function-a")).toBe(20);
          expect(yield* events()).toHaveLength(20);
        }),
      ),
    );
    it.effect(
      "expiry is strict, driven by TestClock, and reclaims increment attempt while retaining token",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            yield* seed(1);
            yield* m.setJobToken(id(1), "krun-test-job", "b".repeat(64));
            const until = DateTime.addDuration(yield* DateTime.now, "30 seconds");
            yield* m.claimQueued("function-a", "first", until, 1);
            yield* TestClock.adjust("30 seconds");
            expect(yield* m.claimQueued("function-a", "second", until, 1)).toEqual([]);
            yield* TestClock.adjust("1 millis");
            const rows = yield* m.claimQueued(
              "function-a",
              "second",
              DateTime.addDuration(yield* DateTime.now, "30 seconds"),
              1,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]?.attempt).toBe(2);
            expect(rows[0]?.job_name).toBe("krun-test-job");
            expect(rows[0]?.job_token_hash).toBe("b".repeat(64));
            expect(yield* events()).toHaveLength(1);
          }),
        ),
    );
    it.effect("claim selects priority then oldest, respects function/state and limit", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          yield* seed(1, { priority: 1 });
          yield* seed(2, {
            priority: 9,
            created_at: DateTime.addDuration(yield* DateTime.now, "1 second"),
          });
          yield* seed(3, { priority: 9 });
          yield* seed(4, { priority: 99, function_name: "other" });
          yield* seed(5, { priority: 99 }, "running");
          const until = DateTime.addDuration(yield* DateTime.now, "30 seconds");
          const rows = yield* m.claimQueued("function-a", "leader", until, 1);
          expect(rows.map((r) => r.id)).toEqual([id(3)]);
          expect((yield* m.claimQueued("function-a", "leader", until, 1)).map((r) => r.id)).toEqual(
            [id(2)],
          );
          expect(yield* m.claimQueued("function-a", "leader", until, 0)).toEqual([]);
          expect((yield* stored(1)).attempt).toBe(0);
          expect((yield* stored(4)).attempt).toBe(0);
          expect((yield* stored(5)).attempt).toBe(0);
        }),
      ),
    );
    it.effect(
      "releaseLease clears both fields, allows immediate reclaim, and missing id is a no-op",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            yield* seed(1);
            const until = DateTime.addDuration(yield* DateTime.now, "30 seconds");
            yield* m.claimQueued("function-a", "first", until, 1);
            yield* m.releaseLease(id(1));
            const cleared = yield* stored(1);
            expect(cleared.lease_owner).toBeNull();
            expect(cleared.lease_until).toBeNull();
            expect(cleared.attempt).toBe(1);
            expect((yield* m.claimQueued("function-a", "second", until, 1))[0]?.attempt).toBe(2);
            yield* m.releaseLease(id(999));
            expect(yield* events()).toHaveLength(1);
          }),
        ),
    );
    it.effect("setJobToken is idempotent before scheduling and does not append an event", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          yield* seed(1);
          yield* m.setJobToken(id(1), "krun-test-job", "b".repeat(64));
          yield* m.setJobToken(id(1), "krun-test-job", "b".repeat(64));
          const row = yield* stored(1);
          expect(row.job_name).toBe("krun-test-job");
          expect(row.job_token_hash).toBe("b".repeat(64));
          expect(row.state).toBe("queued");
          expect(yield* events()).toHaveLength(1);
          yield* m.setJobToken(id(999), "krun-test-job", "b".repeat(64));
        }),
      ),
    );
    it.effect("markScheduled CAS succeeds once, clears lease and shares one event timestamp", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          yield* seed(1);
          yield* m.claimQueued(
            "function-a",
            "leader",
            DateTime.addDuration(yield* DateTime.now, "30 seconds"),
            1,
          );
          yield* TestClock.adjust("2 seconds");
          const at = yield* DateTime.now;
          const results = yield* Effect.all(
            Array.from({ length: 10 }, () => m.markScheduled(id(1))),
            { concurrency: "unbounded" },
          );
          expect(results.filter(Boolean)).toHaveLength(1);
          const row = yield* stored(1);
          expect(row.state).toBe("scheduled");
          expect(row.lease_owner).toBeNull();
          expect(row.lease_until).toBeNull();
          expect(DateTime.formatIso(row.scheduled_at ?? DateTime.makeUnsafe(0))).toBe(
            DateTime.formatIso(at),
          );
          const scheduled = (yield* events()).filter((e) => e.to_state === "scheduled");
          expect(scheduled).toHaveLength(1);
          expect(scheduled[0]?.from_state).toBe("queued");
          expect(scheduled[0]?.reason).toBeNull();
          expect(scheduled[0]?.payload).toBeNull();
          expect(DateTime.formatIso(DateTime.makeUnsafe(scheduled[0]?.at as string))).toBe(
            DateTime.formatIso(at),
          );
        }),
      ),
    );
    it.effect("markScheduled on cancelled/other stale states is false and writes nothing", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          const stale: State[] = [
            "cancelled",
            "cancelling",
            "failed",
            "succeeded",
            "running",
            "scheduled",
          ];
          for (let n = 0; n < stale.length; n++) {
            yield* seed(n + 1, {}, stale[n]);
            const before = yield* stored(n + 1);
            expect(yield* m.markScheduled(id(n + 1))).toBe(false);
            expect(yield* stored(n + 1)).toEqual(before);
          }
          expect(yield* m.markScheduled(id(999))).toBe(false);
          expect(yield* events()).toHaveLength(stale.length);
        }),
      ),
    );
    it.effect("event-insert failure rolls back scheduled state/time/lease atomically", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          yield* seed(1);
          yield* m.claimQueued(
            "function-a",
            "leader",
            DateTime.addDuration(yield* DateTime.now, "30 seconds"),
            1,
          );
          const before = yield* stored(1);
          yield* query(async (db) => {
            if (dialect === "postgres") {
              await sql`create function krun_test_p14_fail() returns trigger language plpgsql as $$ begin raise exception 'owned test event failure'; end $$`.execute(
                db,
              );
              await sql`create trigger krun_test_p14_fail before insert on run_events for each row execute function krun_test_p14_fail()`.execute(
                db,
              );
            } else
              await sql`create trigger krun_test_p14_fail before insert on run_events begin select raise(abort,'owned test event failure'); end`.execute(
                db,
              );
          });
          expect(yield* Effect.flip(m.markScheduled(id(1)))).toBeInstanceOf(DatabaseError);
          expect(yield* stored(1)).toEqual(before);
          expect(yield* events()).toHaveLength(1);
        }),
      ),
    );
    it.effect(
      "active counts exclude every terminal state; queue counts scope owner/function including leases",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            const all: State[] = [
              "queued",
              "scheduled",
              "running",
              "cancelling",
              "succeeded",
              "failed",
              "cancelled",
            ];
            for (let n = 0; n < all.length; n++) yield* seed(n + 1, {}, all[n]);
            yield* seed(8, { created_by: "owner-b" });
            yield* seed(9, { function_name: "other" });
            yield* m.claimQueued(
              "function-a",
              "leader",
              DateTime.addDuration(yield* DateTime.now, "30 seconds"),
              1,
            );
            expect(yield* m.countByState()).toEqual(
              new Map([
                [
                  "function-a",
                  new Map([
                    ["queued", 2],
                    ["scheduled", 1],
                    ["running", 1],
                    ["cancelling", 1],
                  ]),
                ],
                ["other", new Map([["queued", 1]])],
              ]),
            );
            expect(yield* m.countQueued("function-a")).toBe(2);
            expect(yield* m.countQueuedBy("function-a", "owner-a")).toBe(1);
            expect(yield* m.countQueuedBy("function-a", "owner-b")).toBe(1);
            expect(yield* m.countQueued("missing")).toBe(0);
            expect(yield* m.countQueuedBy("other", "owner-b")).toBe(0);
          }),
        ),
    );
    it.effect(
      "listByState intersects requested states with active predicate, validates data and limit",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            yield* seed(1);
            yield* seed(2, {}, "running");
            yield* seed(3, {}, "cancelled");
            yield* seed(4, {}, "scheduled");
            const rows = yield* m.listByState(["queued", "running", "cancelled"], 100);
            expect(new Set(rows.map((r) => r.id))).toEqual(new Set([id(1), id(2)]));
            expect(rows[0]?.input).toEqual({ opaque: { b: 2, a: 1 } });
            expect(yield* m.listByState([], 10)).toEqual([]);
            expect(yield* m.listByState(["cancelled"], 10)).toEqual([]);
            expect(yield* m.listByState(["queued"], 0)).toEqual([]);
            expect(yield* m.listByState(["queued", "running"], 1)).toHaveLength(1);
            expect(yield* Effect.flip(m.listByState(["queued"], -1))).toBeInstanceOf(DatabaseError);
            expect(
              yield* Effect.flip(m.listByState(["queued') or 1=1 --" as State], 10)),
            ).toBeInstanceOf(DatabaseError);
          }),
        ),
    );
    it.effect("malformed returned rows fail closed and roll the lease back", () =>
      run(
        Effect.gen(function* () {
          const m = yield* makeRunLeasing;
          yield* seed(1);
          yield* query((db) => sql`update runs set input=${"[]"} where id=${id(1)}`.execute(db));
          expect(
            yield* Effect.flip(
              m.claimQueued(
                "function-a",
                "leader",
                DateTime.addDuration(yield* DateTime.now, "30 seconds"),
                1,
              ),
            ),
          ).toBeInstanceOf(DatabaseError);
          const rows = yield* query(
            async (db) =>
              (
                await sql<{
                  attempt: number;
                  lease_owner: string | null;
                  lease_until: unknown;
                }>`select attempt,lease_owner,lease_until from runs`.execute(db)
              ).rows,
          );
          expect(rows).toEqual([{ attempt: 0, lease_owner: null, lease_until: null }]);
          expect(yield* Effect.flip(m.listByState(["queued"], 1))).toBeInstanceOf(DatabaseError);
        }),
      ),
    );
    it.effect("all eight method spans carry row counts, single-run ids and no private data", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const m = yield* makeRunLeasing;
          const native = yield* Effect.tracer;
          const spans: Tracer.Span[] = [];
          const tracer = Tracer.make({
            span(options) {
              const span = native.span(options);
              spans.push(span);
              return span;
            },
          });
          yield* Effect.gen(function* () {
            yield* m.claimQueued(
              "function-a",
              "leader",
              DateTime.addDuration(yield* DateTime.now, "30 seconds"),
              1,
            );
            yield* m.releaseLease(id(1));
            yield* m.setJobToken(id(1), "krun-test-job", "b".repeat(64));
            yield* m.markScheduled(id(1));
            yield* m.countByState();
            yield* m.countQueued("function-a");
            yield* m.countQueuedBy("function-a", "owner-a");
            yield* m.listByState(["scheduled"], 1);
          }).pipe(Effect.withTracer(tracer));
          expect(spans).toHaveLength(8);
          for (const span of spans) {
            expect(span.kind).toBe("client");
            expect(span.status._tag).toBe("Ended");
            expect(span.attributes.get("db.operation.name")).toBe(span.name.slice("store.".length));
            expect(span.attributes.get("db.response.returned_rows")).toBe(1);
            expect(
              [...span.attributes.keys()].every((k) =>
                ["db.operation.name", "db.response.returned_rows", "krun.run_id"].includes(k),
              ),
            ).toBe(true);
            if (
              ["store.releaseLease", "store.setJobToken", "store.markScheduled"].includes(span.name)
            )
              expect(span.attributes.get("krun.run_id")).toBe(id(1));
            expect(JSON.stringify([...span.attributes])).not.toContain("b".repeat(64));
          }
        }),
      ),
    );
    it.effect(
      "query failures remain sanitized DatabaseError for all eight methods, never empty success",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            yield* query((db) =>
              (dialect === "postgres"
                ? sql`drop table runs cascade`
                : sql`drop table runs`
              ).execute(db),
            );
            const attempts = [
              m.claimQueued(
                "function-a",
                "leader",
                DateTime.addDuration(yield* DateTime.now, "30 seconds"),
                1,
              ),
              m.releaseLease(id(1)),
              m.setJobToken(id(1), "krun-test-job", "b".repeat(64)),
              m.markScheduled(id(1)),
              m.countByState(),
              m.countQueued("function-a"),
              m.countQueuedBy("function-a", "owner-a"),
              m.listByState(["queued"], 1),
            ];
            for (const attempt of attempts) {
              const error = yield* Effect.flip(attempt);
              expect(error).toBeInstanceOf(DatabaseError);
              expect(Object.keys(error).sort()).toEqual(["_tag", "operation"]);
            }
          }),
        ),
    );
    if (dialect === "postgres") {
      it.effect(
        "Postgres scheduled notify commits once and is absent on stale or deferred rollback",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              yield* seed(2);
              const m = yield* makeRunLeasing;
              const client = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: async () => {
                    const c = new Client({ connectionString: dsn, query_timeout: 10000 });
                    await c.connect();
                    return c;
                  },
                  catch: () => new Error("Owned scheduled listener open failed"),
                }),
                (c) => Effect.promise(() => c.end()),
              );
              const notifications: string[] = [];
              let resolveDelivered: () => void = () => {};
              const delivered = new Promise<void>((resolve) => {
                resolveDelivered = resolve;
              });
              client.on("notification", (message) => {
                notifications.push(message.payload ?? "");
                resolveDelivered();
              });
              yield* Effect.tryPromise({
                try: () => client.query("listen krun_runs"),
                catch: () => new Error("Owned scheduled listener failed"),
              });
              expect(yield* m.markScheduled(id(1))).toBe(true);
              yield* Effect.promise(() => delivered);
              const visible = yield* Effect.tryPromise({
                try: () => client.query("select state,scheduled_at from runs where id=$1", [id(1)]),
                catch: () => new Error("Owned committed visibility query failed"),
              });
              expect(visible.rows[0]?.state).toBe("scheduled");
              expect(visible.rows[0]?.scheduled_at).not.toBeNull();
              expect(yield* m.markScheduled(id(1))).toBe(false);
              yield* query(async (db) => {
                await sql`create function krun_test_p14_deferred_fail() returns trigger language plpgsql as $$ begin raise exception 'owned deferred test failure'; end $$`.execute(
                  db,
                );
                await sql`create constraint trigger krun_test_p14_deferred_fail after insert on run_events deferrable initially deferred for each row execute function krun_test_p14_deferred_fail()`.execute(
                  db,
                );
              });
              expect(yield* Effect.flip(m.markScheduled(id(2)))).toBeInstanceOf(DatabaseError);
              expect((yield* stored(2)).state).toBe("queued");
              expect((yield* events()).filter((e) => e.to_state === "scheduled")).toHaveLength(1);
              yield* Effect.tryPromise({
                try: () => client.query("select 1"),
                catch: () => new Error("Owned scheduled listener barrier failed"),
              });
              expect(notifications).toEqual([`${id(1)}:scheduled`]);
            }),
          ),
      );
      it.effect("Postgres locked candidates are skipped without waiting", () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunLeasing;
            yield* seed(1, { priority: 9 });
            yield* seed(2);
            const client = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: async () => {
                  const c = new Client({ connectionString: dsn, query_timeout: 10000 });
                  await c.connect();
                  return c;
                },
                catch: () => new Error("Owned lock client acquisition failed"),
              }),
              (c) => Effect.promise(() => c.end()),
            );
            yield* Effect.tryPromise({
              try: async () => {
                await client.query("begin");
                await client.query("select id from runs where id=$1 for update", [id(1)]);
              },
              catch: () => new Error("Owned row-lock fixture failed"),
            });
            const claimed = yield* m.claimQueued(
              "function-a",
              "leader",
              DateTime.addDuration(yield* DateTime.now, "30 seconds"),
              2,
            );
            expect(claimed.map((r) => r.id)).toEqual([id(2)]);
            yield* Effect.tryPromise({
              try: () => client.query("rollback"),
              catch: () => new Error("Owned row-lock release failed"),
            });
          }),
        ),
      );
      it.effect(
        "Postgres real count query uses runs_active_idx after 5000 terminal/50 active rows",
        () =>
          run(
            Effect.gen(function* () {
              const m = yield* makeRunLeasing;
              const at = DateTime.formatIso(yield* DateTime.now);
              const plan = yield* query(async (db) => {
                await sql`insert into runs (id,request_hash,function_name,input,state,created_by,created_at,finished_at) select ('0192f000-0000-7000-8000-'||lpad(to_hex(n),12,'0'))::uuid,repeat('a',64),'planner','{}'::jsonb,case when n<=5000 then 'succeeded' else 'queued' end,'owner-a',${at}::timestamptz,case when n<=5000 then ${at}::timestamptz else null end from generate_series(1,5050) n`.execute(
                  db,
                );
                await sql`analyze runs`.execute(db);
                expect(activePredicate.compile(db).parameters).toEqual([]);
                expect(countByStateQuery.compile(db).parameters).toEqual([]);
                return db.transaction().execute(async (tx) => {
                  await sql`set local enable_seqscan = off`.execute(tx);
                  return (
                    await sql<{ "QUERY PLAN": string }>`explain ${countByStateQuery}`.execute(tx)
                  ).rows
                    .map((r) => r["QUERY PLAN"])
                    .join("\n");
                });
              });
              expect(plan).toContain("runs_active_idx");
              expect(yield* m.countByState()).toEqual(
                new Map([["planner", new Map([["queued", 50]])]]),
              );
            }),
          ),
      );
    }
  });
}
