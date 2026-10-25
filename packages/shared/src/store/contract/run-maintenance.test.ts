import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, type Scope, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { type KyselyPlugin, sql } from "kysely";
import { Client, Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { DatabaseError } from "../errors.js";
import { toRunSummary } from "../mappers.js";
import { migrate } from "../migrations.js";
import type { DeliveryState, NewRun, State } from "../model.js";
import { decodeRun } from "../rows.js";
import { makeRunMaintenance } from "../run-maintenance.js";
import { makeTransition } from "../transition.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p17-maintenance-${process.pid}`)
      .withDatabase("krun_test_p17")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned maintenance Postgres fixture failed");
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
      catch: () => new Error("Owned maintenance fixture query failed"),
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
      catch: () => new Error("Owned maintenance fixture decode failed"),
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

const deliveries = () =>
  query(
    async (db) =>
      (await sql<Record<string, unknown>>`select * from deliveries order by id`.execute(db)).rows,
  );
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const iso = (value: unknown) => DateTime.formatIso(DateTime.makeUnsafe(value as string | Date));
const stamp = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

const seedDelivery = (n: number, due: DateTime.Utc, state: DeliveryState = "pending") =>
  Effect.gen(function* () {
    yield* seed(n, { callback_url: "https://callback.invalid/maintenance" });
    const transition = yield* makeTransition;
    yield* transition(id(n), "queued", "failed", "job_create_failed", {});
    yield* query((db) =>
      sql`update deliveries set id=${id(1000 + n)},next_at=${DateTime.formatIso(due)},state=${state} where run_id=${id(n)}`.execute(
        db,
      ),
    );
  });
for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`maintenance contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p17-maintenance-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned maintenance reset failed");
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
    it.effect(
      "expireQueued is strict,scoped and returns updated FULL cleanup metadata with atomic BASIC delivery",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const cutoff = DateTime.subtractDuration(now, "1 hour");
            const old = DateTime.subtractDuration(cutoff, "1 millis");
            yield* seed(1, { created_at: old, callback_url: "https://callback.invalid/expiry" });
            yield* seed(2, { created_at: cutoff });
            yield* seed(3, { created_at: now });
            yield* seed(4, { created_at: old, function_name: "other" });
            yield* seed(5, { created_at: old }, "scheduled");
            yield* seed(6, { created_at: old }, "running");
            yield* seed(7, { created_at: old }, "cancelling");
            const accepted = {
              source: "function",
              message: "accepted failure",
              details: { opaque: "private input" },
            };
            yield* query((db) =>
              sql`update runs set job_name='krun-owned-job',job_token_hash=${"b".repeat(64)},error=${JSON.stringify(accepted)},result='{"private":"result"}',log_tail='private log' where id=${id(1)}`.execute(
                db,
              ),
            );
            const m = yield* makeRunMaintenance;
            const expired = yield* m.expireQueued("function-a", cutoff);
            expect(expired).toHaveLength(1);
            const row = expired[0];
            expect(row).toEqual(yield* stored(1));
            expect(row).toMatchObject({
              state: "failed",
              failure_reason: "queue_timeout",
              job_name: "krun-owned-job",
              job_token_hash: "b".repeat(64),
              error: accepted,
            });
            expect(stamp(row?.finished_at ?? null)).toBe(DateTime.formatIso(now));
            expect(row?.started_at).toBeNull();
            const event = (yield* events()).filter((e) => e.to_state === "failed");
            expect(event).toHaveLength(1);
            expect(event[0]).toMatchObject({
              from_state: "queued",
              to_state: "failed",
              reason: "queue_timeout",
              payload: null,
            });
            expect(iso(event[0]?.at)).toBe(stamp(row?.finished_at ?? null));
            const d = (yield* deliveries())[0];
            expect(d).toMatchObject({
              run_id: id(1),
              attempt: 0,
              state: "pending",
              last_error: null,
            });
            expect(iso(d?.next_at)).toBe(DateTime.formatIso(now));
            expect(iso(d?.created_at)).toBe(DateTime.formatIso(now));
            if (row === undefined) throw new Error("Owned expiry result missing");
            expect(json(d?.payload)).toEqual(toRunSummary(row));
            expect(json(d?.payload)).not.toHaveProperty("input");
            expect(json(d?.payload)).not.toHaveProperty("result");
            expect(json(d?.payload)).not.toHaveProperty("logTail");
            expect(json(d?.payload)).not.toHaveProperty("error.details");
            for (const n of [2, 3, 4, 5, 6, 7]) expect((yield* stored(n)).state).not.toBe("failed");
            expect(yield* m.expireQueued("function-a", cutoff)).toEqual([]);
            expect(yield* m.expireQueued("function-a' OR 'x'='x", cutoff)).toEqual([]);
          }),
        ),
    );
    it.effect(
      "P17-C1 supplies a KRUN fallback in returned/stored runs and the immutable BASIC callback",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const old = DateTime.subtractDuration(now, "2 hours");
            yield* seed(1, { created_at: old, callback_url: "https://callback.invalid/fallback" });
            yield* seed(2, { created_at: old });
            const m = yield* makeRunMaintenance;
            const expired = yield* m.expireQueued(
              "function-a",
              DateTime.subtractDuration(now, "1 hour"),
            );
            expect(expired).toHaveLength(2);
            for (const run of expired) {
              expect(run.error).toMatchObject({ source: "krun", message: expect.any(String) });
              if (run.error === null) throw new Error("Owned fallback diagnostic missing");
              expect(run.error.message.trim().length).toBeGreaterThan(0);
              expect((yield* stored(Number(run.id === id(1) ? 1 : 2))).error).toEqual(run.error);
              expect(run.failure_reason).toBe("queue_timeout");
              expect(stamp(run.finished_at)).toBe(stamp(now));
            }
            const callback = (yield* deliveries())[0];
            const first = expired.find((row) => row.id === id(1));
            if (first === undefined) throw new Error("Owned expired row missing");
            expect(json(callback?.payload)).toEqual(toRunSummary(first));
            expect(json(callback?.payload)).toMatchObject({
              error: { source: "KRUN", message: first.error?.message },
              failureReason: "QUEUE_TIMEOUT",
              endTime: stamp(now),
            });
            expect(json(callback?.payload)).not.toHaveProperty("error.details");
            expect(yield* m.expireQueued("function-a", now)).toEqual([]);
            expect(yield* deliveries()).toHaveLength(1);
          }),
        ),
    );
    it.effect("P17-C1 fallback never overwrites accepted FUNCTION,KUBERNETES or KRUN reports", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const prior = [];
          for (const [index, source] of (["function", "kubernetes", "krun"] as const).entries()) {
            const n = index + 1;
            yield* seed(n, {
              created_at: DateTime.subtractDuration(now, "2 hours"),
              callback_url: "https://callback.invalid/precedence",
            });
            const error = {
              source,
              message: `accepted-${source}`,
              type: "owned-report",
              details: { opaque: { keep: true } },
            };
            prior.push({ n, error });
            yield* query((db) =>
              sql`update runs set error=${JSON.stringify(error)} where id=${id(n)}`.execute(db),
            );
          }
          const m = yield* makeRunMaintenance;
          const expired = yield* m.expireQueued("function-a", now);
          expect(expired).toHaveLength(3);
          const callbacks = yield* deliveries();
          for (const item of prior) {
            expect(expired.find((row) => row.id === id(item.n))?.error).toEqual(item.error);
            expect((yield* stored(item.n)).error).toEqual(item.error);
            expect(json(callbacks.find((row) => row.run_id === id(item.n))?.payload)).toMatchObject(
              {
                error: {
                  source: item.error.source.toUpperCase(),
                  message: item.error.message,
                  type: "owned-report",
                },
              },
            );
            expect(
              json(callbacks.find((row) => row.run_id === id(item.n))?.payload),
            ).not.toHaveProperty("error.details");
          }
        }),
      ),
    );
    it.effect(
      "expireQueued uses one frozen Clock timestamp and skips callback insertion when unset",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            for (let n = 1; n <= 3; n++)
              yield* seed(n, { created_at: DateTime.subtractDuration(now, "2 hours") });
            const m = yield* makeRunMaintenance;
            const rows = yield* m.expireQueued(
              "function-a",
              DateTime.subtractDuration(now, "1 hour"),
            );
            expect(rows).toHaveLength(3);
            expect(rows.every((r) => stamp(r.finished_at) === DateTime.formatIso(now))).toBe(true);
            expect((yield* events()).filter((e) => e.to_state === "failed")).toHaveLength(3);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
    );
    it.effect("concurrent expiry produces one terminal event and unique callback per winner", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          for (let n = 1; n <= 20; n++)
            yield* seed(n, {
              created_at: DateTime.subtractDuration(now, "2 hours"),
              callback_url: "https://callback.invalid/concurrent",
            });
          const m = yield* makeRunMaintenance;
          const rows = (yield* Effect.all(
            Array.from({ length: 6 }, () => m.expireQueued("function-a", now)),
            { concurrency: "unbounded" },
          )).flat();
          expect(rows).toHaveLength(20);
          expect(new Set(rows.map((r) => r.id)).size).toBe(20);
          const d = yield* deliveries();
          expect(d).toHaveLength(20);
          expect(new Set(d.map((x) => x.id)).size).toBe(20);
          expect(
            rows.every((row) => row.error?.source === "krun" && row.error.message.length > 0),
          ).toBe(true);
          for (const delivery of d)
            expect(json(delivery.payload)).toMatchObject({
              error: { source: "KRUN", message: expect.any(String) },
            });
          expect((yield* events()).filter((e) => e.to_state === "failed")).toHaveLength(20);
        }),
      ),
    );
    it.effect("expiry and cancellation race preserves the winning CAS and dependent writes", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* seed(1, {
            created_at: DateTime.subtractDuration(now, "2 hours"),
            callback_url: "https://callback.invalid/race",
          });
          const m = yield* makeRunMaintenance;
          const transition = yield* makeTransition;
          const [expired, cancelled] = yield* Effect.all(
            [
              m.expireQueued("function-a", now),
              transition(id(1), "queued", "cancelling", null, {}, { actor: "owner-a" }),
            ] as const,
            { concurrency: "unbounded" },
          );
          expect(expired.length + Number(cancelled)).toBe(1);
          expect((yield* stored(1)).state).toBe(cancelled ? "cancelling" : "failed");
          expect((yield* stored(1)).error?.source ?? null).toBe(cancelled ? null : "krun");
          expect(yield* events()).toHaveLength(2);
          expect(yield* deliveries()).toHaveLength(cancelled ? 0 : 1);
        }),
      ),
    );
    for (const failure of ["event", "delivery", "decode"] as const)
      it.effect(`expiry ${failure} failure rolls the entire batch back`, () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            for (const n of [1, 2])
              yield* seed(n, {
                callback_url: "https://callback.invalid/rollback",
                created_at: DateTime.subtractDuration(now, "1 hour"),
              });
            if (failure === "event") yield* query((db) => sql`drop table run_events`.execute(db));
            if (failure === "delivery")
              yield* query((db) => sql`drop table deliveries`.execute(db));
            if (failure === "decode")
              yield* query((db) => sql`update runs set input='[]' where id=${id(2)}`.execute(db));
            const m = yield* makeRunMaintenance;
            const error = yield* Effect.flip(m.expireQueued("function-a", now));
            expect(error).toMatchObject({ _tag: "DatabaseError", operation: "expireQueued" });
            const states = yield* query(
              async (db) =>
                (
                  await sql<{
                    state: string;
                    finished_at: unknown;
                    error: unknown;
                  }>`select state,finished_at,error from runs order by id`.execute(db)
                ).rows,
            );
            expect(states).toEqual([
              { state: "queued", finished_at: null, error: null },
              { state: "queued", finished_at: null, error: null },
            ]);
            if (failure !== "event") expect(yield* events()).toHaveLength(2);
            if (failure !== "delivery") expect(yield* deliveries()).toEqual([]);
            expect(JSON.stringify(error)).not.toMatch(/rollback|private input|select |update /);
          }),
        ),
      );
    it.effect(
      "claimDeliveries selects earliest due pending rows and leases in the selection statement",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seedDelivery(1, DateTime.subtractDuration(now, "2 seconds"));
            yield* seedDelivery(2, DateTime.subtractDuration(now, "1 second"));
            yield* seedDelivery(3, now);
            yield* seedDelivery(4, DateTime.addDuration(now, "1 millis"));
            yield* seedDelivery(5, DateTime.subtractDuration(now, "3 seconds"), "dead");
            yield* seedDelivery(6, now, "delivered");
            const m = yield* makeRunMaintenance;
            const rows = yield* m.claimDeliveries(now, 2);
            expect(rows.map((r) => r.id).sort()).toEqual([id(1001), id(1002)]);
            for (const row of rows) {
              expect(stamp(row.next_at)).toBe(stamp(DateTime.addDuration(now, "60 seconds")));
              expect(row.attempt).toBe(0);
              expect(row.state).toBe("pending");
              expect(row.payload).toMatchObject({
                state: "FAILED",
                createTime: DateTime.formatIso(now),
              });
              expect(row.payload).not.toHaveProperty("input");
              expect(row.last_error).toBeNull();
              expect(stamp(row.created_at)).toBe(stamp(now));
            }
            expect((yield* m.claimDeliveries(now, 20)).map((r) => r.id)).toEqual([id(1003)]);
            expect(yield* m.claimDeliveries(now, 0)).toEqual([]);
          }),
        ),
    );
    it.effect("claimed delivery cannot be re-claimed before60s and is due exactly at60s", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* seedDelivery(1, now);
          const m = yield* makeRunMaintenance;
          expect(yield* m.claimDeliveries(now, 1)).toHaveLength(1);
          yield* TestClock.adjust("59999 millis");
          expect(yield* m.claimDeliveries(yield* DateTime.now, 1)).toEqual([]);
          yield* TestClock.adjust("1 millis");
          expect(yield* m.claimDeliveries(yield* DateTime.now, 1)).toHaveLength(1);
        }),
      ),
    );
    it.effect("concurrent delivery claimers never share a live lease", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          for (let n = 1; n <= 20; n++) yield* seedDelivery(n, now);
          const m = yield* makeRunMaintenance;
          const claims = (yield* Effect.all(
            Array.from({ length: 12 }, () => m.claimDeliveries(now, 2)),
            { concurrency: "unbounded" },
          )).flat();
          expect(claims).toHaveLength(20);
          expect(new Set(claims.map((r) => r.id)).size).toBe(20);
          expect(yield* m.claimDeliveries(now, 100)).toEqual([]);
        }),
      ),
    );
    it.effect("malformed callback payload fails closed and rolls the claim lease back", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* seedDelivery(1, now);
          yield* query((db) =>
            sql`update deliveries set payload='{"name":"invalid callback","input":{"private":true}}'`.execute(
              db,
            ),
          );
          const m = yield* makeRunMaintenance;
          expect(yield* Effect.flip(m.claimDeliveries(now, 1))).toBeInstanceOf(DatabaseError);
          expect(iso((yield* deliveries())[0]?.next_at)).toBe(stamp(now));
        }),
      ),
    );
    it.effect(
      "updateDelivery changes only scheduling/state fields and null nextAt retains the NOT NULL lease",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seedDelivery(1, now);
            const before = (yield* deliveries())[0];
            const m = yield* makeRunMaintenance;
            const next = DateTime.addDuration(now, "5 minutes");
            yield* m.updateDelivery(id(1001), "pending", 3, next, "owned retry failure");
            const row = (yield* deliveries())[0];
            expect(row).toMatchObject({
              state: "pending",
              attempt: 3,
              last_error: "owned retry failure",
            });
            expect(iso(row?.next_at)).toBe(stamp(next));
            for (const key of ["id", "run_id", "url", "payload", "created_at"] as const)
              expect(row?.[key]).toEqual(before?.[key]);
            for (const state of ["delivered", "dead"] as const) {
              yield* m.updateDelivery(id(1001), state, 4, null, null);
              expect((yield* deliveries())[0]).toMatchObject({
                state,
                attempt: 4,
                last_error: null,
              });
              expect(iso((yield* deliveries())[0]?.next_at)).toBe(stamp(next));
              expect(yield* m.claimDeliveries(DateTime.addDuration(next, "1 hour"), 20)).toEqual(
                [],
              );
            }
            yield* m.updateDelivery(id(9999), "dead", 0, null, null);
          }),
        ),
    );
    it.effect("invalid limits/states/attempts fail without changing rows", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* seedDelivery(1, now);
          const before = yield* deliveries();
          const m = yield* makeRunMaintenance;
          for (const n of [-1, 0.5, Number.POSITIVE_INFINITY]) {
            expect(yield* Effect.flip(m.claimDeliveries(now, n))).toBeInstanceOf(DatabaseError);
            expect(yield* Effect.flip(m.sweep(now, n))).toBeInstanceOf(DatabaseError);
            expect(
              yield* Effect.flip(m.updateDelivery(id(1001), "pending", n, null, null)),
            ).toBeInstanceOf(DatabaseError);
          }
          expect(
            yield* Effect.flip(
              m.updateDelivery(id(1001), "unknown" as DeliveryState, 0, null, null),
            ),
          ).toBeInstanceOf(DatabaseError);
          expect(yield* deliveries()).toEqual(before);
        }),
      ),
    );
    it.effect("sweep deletes strict oldest bounded batches and cascades events/deliveries", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          for (let n = 1; n <= 5; n++) {
            yield* seedDelivery(n, now);
            yield* query((db) =>
              sql`update runs set finished_at=${DateTime.formatIso(DateTime.subtractDuration(now, `${6 - n} seconds`))} where id=${id(n)}`.execute(
                db,
              ),
            );
          }
          yield* seedDelivery(6, now);
          yield* seed(7);
          yield* seed(8, {}, "failed");
          const m = yield* makeRunMaintenance;
          expect(yield* m.sweep(now, 0)).toBe(0);
          expect(yield* m.sweep(now, 2)).toBe(2);
          expect(
            (yield* query(
              async (db) =>
                (await sql<{ id: string }>`select id from runs order by id`.execute(db)).rows,
            )).map((r) => r.id),
          ).toEqual([3, 4, 5, 6, 7, 8].map(id));
          expect(yield* m.sweep(now, 2)).toBe(2);
          expect(yield* m.sweep(now, 2)).toBe(1);
          expect(yield* m.sweep(now, 2)).toBe(0);
          expect(yield* deliveries()).toHaveLength(1);
          expect(yield* events()).toHaveLength(4);
          expect((yield* stored(6)).state).toBe("failed");
          expect((yield* stored(7)).state).toBe("queued");
          expect((yield* stored(8)).finished_at).toBeNull();
        }),
      ),
    );
    it.effect("failed retention delete rolls back child cascades and every row in its batch", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          for (const n of [1, 2]) yield* seedDelivery(n, now);
          yield* query(async (db) => {
            if (dialect === "sqlite")
              await sql`create trigger krun_test_p17_reject before delete on runs when old.id=${sql.lit(id(2))} begin select raise(abort,'owned retention failure'); end`.execute(
                db,
              );
            else {
              await sql`create function krun_test_p17_reject() returns trigger language plpgsql as $$ begin raise exception 'owned retention failure'; end $$`.execute(
                db,
              );
              await sql`create trigger krun_test_p17_reject before delete on runs for each row execute function krun_test_p17_reject()`.execute(
                db,
              );
            }
          });
          const m = yield* makeRunMaintenance;
          expect(
            yield* Effect.flip(m.sweep(DateTime.addDuration(now, "1 millis"), 2)),
          ).toBeInstanceOf(DatabaseError);
          expect(yield* deliveries()).toHaveLength(2);
          expect(yield* events()).toHaveLength(4);
        }),
      ),
    );
    for (const op of ["expireQueued", "sweep", "claimDeliveries", "updateDelivery"] as const)
      it.effect(`${op} driver failure is sanitized,never empty success`, () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const m = yield* makeRunMaintenance;
            yield* query(async (db) => {
              await sql`drop table deliveries`.execute(db);
              await sql`drop table run_events`.execute(db);
              await sql`drop table runs`.execute(db);
            });
            const effect =
              op === "expireQueued"
                ? Effect.asVoid(m.expireQueued("function-a", now))
                : op === "sweep"
                  ? Effect.asVoid(m.sweep(now, 10))
                  : op === "claimDeliveries"
                    ? Effect.asVoid(m.claimDeliveries(now, 10))
                    : m.updateDelivery(id(1001), "dead", 1, null, "private failure");
            const error = yield* Effect.flip(effect);
            expect(error).toMatchObject({ _tag: "DatabaseError", operation: op });
            expect(JSON.stringify(error)).not.toMatch(
              /private failure|deliveries|SQLITE|select |delete |update /,
            );
          }),
        ),
      );
    it.effect(
      "delivery decoder retains every canonical BASIC optional field and opaque nested metadata",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seed(1, { callback_url: "https://callback.invalid/full-summary" });
            yield* query((db) =>
              sql`update runs set priority=3,error=${JSON.stringify({ source: "function", message: "accepted function error", type: "owned-error", details: { private: true } })},runtime_status=${JSON.stringify({ message: "reported", progress: 0.5, data: { nested: { constructor: "opaque" } }, at: DateTime.formatIso(now) })},job_status=${JSON.stringify({ podName: "owned-pod", phase: "Failed", reason: "owned", message: "observed", exitCode: 2, observedAt: DateTime.formatIso(now) })},job_name='owned-job',scheduled_at=${DateTime.formatIso(now)},started_at=${DateTime.formatIso(now)} where id=${id(1)}`.execute(
                db,
              ),
            );
            const transition = yield* makeTransition;
            yield* transition(id(1), "queued", "failed", "queue_timeout", {
              failure_reason: "queue_timeout",
            });
            const expected = toRunSummary(yield* stored(1));
            const m = yield* makeRunMaintenance;
            const claims = yield* m.claimDeliveries(now, 1);
            expect(claims[0]?.payload).toEqual(expected);
            expect(claims[0]?.payload).not.toHaveProperty("error.details");
            expect(claims[0]?.payload.runtimeStatus?.data).toEqual({
              nested: { constructor: "opaque" },
            });
          }),
        ),
    );
    it.effect(
      "corrupt stored BASIC snapshots are rejected without leaking FULL fields or losing the lease",
      () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seedDelivery(1, now);
            const good = json((yield* deliveries())[0]?.payload) as Record<string, unknown>;
            const bad = [
              null,
              [],
              { ...good, input: {} },
              { ...good, result: 1 },
              { ...good, logTail: "private" },
              {
                ...good,
                error: { source: "FUNCTION", message: "bad", details: { private: true } },
              },
              { ...good, state: "failed" },
            ];
            const m = yield* makeRunMaintenance;
            for (const value of bad) {
              yield* query((db) =>
                sql`update deliveries set payload=${JSON.stringify(value)}`.execute(db),
              );
              expect(yield* Effect.flip(m.claimDeliveries(now, 1))).toBeInstanceOf(DatabaseError);
              expect(iso((yield* deliveries())[0]?.next_at)).toBe(stamp(now));
            }
          }),
        ),
    );
    it.effect("four method spans expose only method/count and sanitize failure paths", () =>
      run(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* seed(1, {
            created_at: DateTime.subtractDuration(now, "1 hour"),
            callback_url: "https://callback.invalid/private",
          });
          const m = yield* makeRunMaintenance;
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
            yield* m.expireQueued("function-a", now);
            const rows = yield* m.claimDeliveries(now, 1);
            const first = rows[0];
            if (first === undefined) throw new Error("Owned claim missing");
            yield* m.updateDelivery(first.id, "dead", 1, null, "private callback error");
            yield* m.sweep(DateTime.addDuration(now, "1 millis"), 1);
            yield* Effect.flip(m.claimDeliveries(now, -1));
          }).pipe(Effect.withTracer(tracer));
          expect(spans.map((s) => s.name)).toEqual([
            "store.expireQueued",
            "store.claimDeliveries",
            "store.updateDelivery",
            "store.sweep",
            "store.claimDeliveries",
          ]);
          expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([
            1, 1, 1, 1, 0,
          ]);
          for (const span of spans) {
            expect(span.kind).toBe("client");
            expect(span.status._tag).toBe("Ended");
            expect([...span.attributes.keys()].sort()).toEqual([
              "db.operation.name",
              "db.response.returned_rows",
            ]);
            expect(JSON.stringify([...span.attributes])).not.toMatch(
              /private|callback.invalid|select |update /,
            );
          }
        }),
      ),
    );
    if (dialect === "sqlite") {
      it.effect("real SQLite incremental vacuum reclaims pages after a bounded cascade batch", () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            for (let n = 1; n <= 32; n++) yield* seed(n, { input: { pad: "x".repeat(32768) } });
            yield* query((db) =>
              sql`update runs set state='failed',finished_at=${DateTime.formatIso(DateTime.subtractDuration(now, "1 second"))}`.execute(
                db,
              ),
            );
            const before = yield* query(
              async (db) =>
                (await sql<{ page_count: number }>`pragma page_count`.execute(db)).rows[0]
                  ?.page_count,
            );
            const m = yield* makeRunMaintenance;
            expect(yield* m.sweep(now, 32)).toBe(32);
            const after = yield* query(
              async (db) =>
                (await sql<{ page_count: number }>`pragma page_count`.execute(db)).rows[0]
                  ?.page_count,
            );
            expect(Number(after)).toBeLessThan(Number(before));
            expect(yield* events()).toEqual([]);
          }),
        ),
      );
      it.effect("SQLite executes incremental_vacuum after each batch including empty ones", () =>
        run(
          Effect.gen(function* () {
            const seen: string[] = [];
            const database = yield* Database;
            const plugin: KyselyPlugin = {
              transformQuery(args) {
                if (args.node.kind === "RawNode") seen.push(args.node.sqlFragments.join("?"));
                return args.node;
              },
              async transformResult(args) {
                return args.result;
              },
            };
            const m = yield* makeRunMaintenance.pipe(
              Effect.provideService(Database, { ...database, db: database.db.withPlugin(plugin) }),
            );
            const now = yield* DateTime.now;
            yield* m.sweep(now, 1);
            yield* m.sweep(now, 1);
            expect(seen.filter((s) => s.trim() === "pragma incremental_vacuum")).toHaveLength(2);
            expect(seen[0]).toContain("delete from runs");
            expect(seen[1]?.trim()).toBe("pragma incremental_vacuum");
          }),
        ),
      );
      it.effect("vacuum failure rolls the SQLite retention delete back", () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seedDelivery(1, now);
            const database = yield* Database;
            const plugin: KyselyPlugin = {
              transformQuery(args) {
                if (
                  args.node.kind === "RawNode" &&
                  args.node.sqlFragments.join("").includes("pragma incremental_vacuum")
                )
                  throw new Error("owned vacuum failure");
                return args.node;
              },
              async transformResult(args) {
                return args.result;
              },
            };
            const m = yield* makeRunMaintenance.pipe(
              Effect.provideService(Database, { ...database, db: database.db.withPlugin(plugin) }),
            );
            expect(
              yield* Effect.flip(m.sweep(DateTime.addDuration(now, "1 millis"), 1)),
            ).toBeInstanceOf(DatabaseError);
            expect(yield* deliveries()).toHaveLength(1);
            expect(yield* events()).toHaveLength(2);
          }),
        ),
      );
    }
    if (dialect === "postgres") {
      it.effect("Postgres claims skip an externally locked due delivery", () =>
        run(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* seedDelivery(1, DateTime.subtractDuration(now, "1 second"));
            yield* seedDelivery(2, now);
            const m = yield* makeRunMaintenance;
            yield* Effect.acquireUseRelease(
              Effect.tryPromise({
                try: async () => {
                  const c = new Client({ connectionString: dsn });
                  await c.connect();
                  await c.query("begin");
                  await c.query("select id from deliveries where id=$1 for update", [id(1001)]);
                  return c;
                },
                catch: () => new Error("Owned locker failed"),
              }),
              () =>
                Effect.gen(function* () {
                  expect((yield* m.claimDeliveries(now, 1)).map((r) => r.id)).toEqual([id(1002)]);
                }),
              (c) =>
                Effect.promise(async () => {
                  await c.query("rollback");
                  await c.end();
                }),
            );
            expect((yield* m.claimDeliveries(now, 1)).map((r) => r.id)).toEqual([id(1001)]);
          }),
        ),
      );
      it.effect(
        "Postgres expiry notifies only committed run/event/callback and not deferred rollback",
        () =>
          run(
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              yield* seed(1, {
                function_name: "winner",
                created_at: DateTime.subtractDuration(now, "1 second"),
                callback_url: "https://callback.invalid/winner",
              });
              yield* seed(2, {
                function_name: "rollback",
                created_at: DateTime.subtractDuration(now, "1 second"),
                callback_url: "https://callback.invalid/rollback",
              });
              const client = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: async () => {
                    const c = new Client({ connectionString: dsn, query_timeout: 10000 });
                    await c.connect();
                    return c;
                  },
                  catch: () => new Error("Owned listener failed"),
                }),
                (c) => Effect.promise(() => c.end()),
              );
              const notifications: string[] = [];
              const delivered = Promise.withResolvers<void>();
              client.on("notification", (message) => {
                notifications.push(message.payload ?? "");
                delivered.resolve();
              });
              yield* Effect.promise(() => client.query("listen krun_runs"));
              const m = yield* makeRunMaintenance;
              expect(yield* m.expireQueued("winner", now)).toHaveLength(1);
              yield* Effect.promise(() => delivered.promise);
              const visible = yield* Effect.promise(() =>
                client.query(
                  "select r.state,(select count(*)::int from run_events where run_id=r.id) as events,(select count(*)::int from deliveries where run_id=r.id) as deliveries from runs r where id=$1",
                  [id(1)],
                ),
              );
              expect(visible.rows[0]).toEqual({ state: "failed", events: 2, deliveries: 1 });
              yield* query(async (db) => {
                await sql`create function krun_test_p17_deferred_fail() returns trigger language plpgsql as $$ begin raise exception 'owned deferred expiry failure'; end $$`.execute(
                  db,
                );
                await sql`create constraint trigger krun_test_p17_deferred_fail after insert on deliveries deferrable initially deferred for each row execute function krun_test_p17_deferred_fail()`.execute(
                  db,
                );
              });
              expect(yield* Effect.flip(m.expireQueued("rollback", now))).toBeInstanceOf(
                DatabaseError,
              );
              expect((yield* stored(2)).state).toBe("queued");
              expect(yield* deliveries()).toHaveLength(1);
              yield* Effect.promise(() => client.query("select 1"));
              expect(notifications).toEqual([`${id(1)}:failed`]);
            }),
          ),
      );
    }
  });
}
