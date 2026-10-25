import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Deferred, Effect, Fiber, type Scope, Stream, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { type KyselyPlugin, sql } from "kysely";
import { Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { DatabaseError, NotFoundError } from "../errors.js";
import { Store } from "../index.js";
import { StoreLive, StorePostgres, StoreSqlite } from "../live.js";
import { toRunSummary } from "../mappers.js";
import { migrate } from "../migrations.js";
import type { NewRun, State } from "../model.js";
import { makeRunLeasing } from "../run-leasing.js";
import { makeRunQueries } from "../run-queries.js";
import { makeRunReports } from "../run-reports.js";
import { makeListStale } from "../run-stale.js";
import { makeTransition } from "../transition.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p111-stale-${process.pid}`)
      .withDatabase("krun_test_p111")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned stale Postgres fixture failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const base = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
const at = (minutes: number) => DateTime.addDuration(base, `${minutes} minutes`);
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({ try: () => f(db), catch: () => new Error("Owned stale query failed") }),
  );
const input = (n: number, created_at: DateTime.Utc, function_name = "function-a"): NewRun => ({
  id: id(n),
  idempotency_key: null,
  request_hash: "a".repeat(64),
  function_name,
  input: { opaque: { b: 2, a: 1 } },
  priority: 0,
  callback_url: "https://callback.invalid/stale",
  created_by: "owner-a",
  created_at,
});
const seed = (n: number, start: DateTime.Utc, fn = "function-a", state: State = "running") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(start));
    const create = yield* makeCreateRun;
    yield* create(input(n, start, fn));
    const leasing = yield* makeRunLeasing;
    const transition = yield* makeTransition;
    if (state === "queued") return;
    yield* leasing.setJobToken(id(n), `krun-test-job-${n}`, "b".repeat(64));
    expect(yield* leasing.markScheduled(id(n))).toBe(true);
    if (state === "scheduled") return;
    expect(yield* transition(id(n), "scheduled", "running", null, {})).toBe(true);
    if (state !== "running")
      expect(
        yield* transition(id(n), "running", state, state === "failed" ? "exit_code" : null, {}),
      ).toBe(true);
  });
const methods = [
  "findRunByRequestId",
  "createRun",
  "getRun",
  "listRuns",
  "listByState",
  "countByState",
  "countQueued",
  "countQueuedBy",
  "claimQueued",
  "releaseLease",
  "setJobToken",
  "markScheduled",
  "transition",
  "setRuntimeStatus",
  "setResult",
  "setError",
  "setJobStatus",
  "expireQueued",
  "listStale",
  "subscribe",
  "claimDeliveries",
  "updateDelivery",
  "sweep",
  "migrate",
].sort();

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`stale and complete Store contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p111-stale-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned stale reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const database = () =>
      dialect === "sqlite" ? DatabaseSqlite(join(directory, "runs.db")) : DatabasePostgres(dsn);
    const run = <A, E>(program: Effect.Effect<A, E, Database | Scope.Scope>) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(base));
        yield* migrate;
        return yield* program;
      }).pipe(Effect.provide(database()));
    it.effect(
      "uses the later of status/start, null-status fallback and a strict cutoff, returning FULL rows",
      () =>
        run(
          Effect.gen(function* () {
            const reports = yield* makeRunReports;
            for (const [n, start, status] of [
              [1, 0, 30],
              [2, 0, 60],
              [3, 0, 120],
              [4, 120, 30],
              [5, 0, null],
              [6, 60, null],
              [7, 0, 0],
            ] as const) {
              yield* seed(n, at(start));
              if (status !== null)
                yield* reports.setRuntimeStatus(id(n), {
                  message: "private",
                  data: { private: true },
                  at: at(status),
                });
            }
            yield* reports.setResult(id(1), false);
            yield* reports.setError(id(1), {
              source: "function",
              message: "private",
              details: { private: true },
            });
            const listStale = yield* makeListStale;
            const rows = yield* listStale("function-a", at(60));
            expect(rows.map((r) => r.id).sort()).toEqual([id(1), id(5), id(7)].sort());
            const get = (yield* makeRunQueries).getRun;
            expect(rows.find((r) => r.id === id(1))).toEqual(yield* get(id(1)));
            expect(rows.find((r) => r.id === id(1))).toMatchObject({
              input: { opaque: { b: 2, a: 1 } },
              result: false,
              error: { details: { private: true } },
              job_name: "krun-test-job-1",
              job_token_hash: "b".repeat(64),
            });
            const before = yield* query(
              async (db) => (await sql`select * from run_events`.execute(db)).rows,
            );
            yield* TestClock.adjust("720 hours");
            expect((yield* listStale("function-a", at(60))).map((r) => r.id).sort()).toEqual(
              rows.map((r) => r.id).sort(),
            );
            expect(
              yield* query(async (db) => (await sql`select * from run_events`.execute(db)).rows),
            ).toEqual(before);
            expect(
              yield* query(async (db) => (await sql`select * from deliveries`.execute(db)).rows),
            ).toEqual([]);
          }),
        ),
    );
    it.effect(
      "strict millisecond boundary follows latest accepted status, not prior report or job observation time",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, at(0));
            const reports = yield* makeRunReports;
            const stale = yield* makeListStale;
            yield* reports.setRuntimeStatus(id(1), { message: "old", at: at(1) });
            expect((yield* stale("function-a", at(2))).map((r) => r.id)).toEqual([id(1)]);
            yield* reports.setRuntimeStatus(id(1), { message: "latest", at: at(2) });
            expect(yield* stale("function-a", at(2))).toEqual([]);
            expect(
              (yield* stale("function-a", DateTime.addDuration(at(2), "1 millis"))).map(
                (r) => r.id,
              ),
            ).toEqual([id(1)]);
            yield* reports.setJobStatus(id(1), { phase: "Running", observedAt: at(120) });
            expect(
              (yield* stale("function-a", DateTime.addDuration(at(2), "1 millis"))).map(
                (r) => r.id,
              ),
            ).toEqual([id(1)]);
          }),
        ),
    );
    it.effect(
      "scopes by function and running state, binds hostile names, and returns an honest empty result",
      () =>
        run(
          Effect.gen(function* () {
            for (const [n, state] of [
              "queued",
              "scheduled",
              "running",
              "cancelling",
              "succeeded",
              "failed",
              "cancelled",
            ].entries())
              yield* seed(n + 1, base, "function-a", state as State);
            yield* seed(20, base, "function-b");
            const stale = yield* makeListStale;
            expect((yield* stale("function-a", at(1))).map((r) => r.id)).toEqual([id(3)]);
            expect((yield* stale("function-b", at(1))).map((r) => r.id)).toEqual([id(20)]);
            expect(yield* stale("missing", at(1))).toEqual([]);
            expect(yield* stale("function-a' OR 1=1 --", at(1))).toEqual([]);
          }),
        ),
    );
    it.effect(
      "heartbeat failure_reason travels through transition, FULL/BASIC queries and atomic callback",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, base);
            const stale = yield* makeListStale;
            const transition = yield* makeTransition;
            const [candidate] = yield* stale("function-a", at(1));
            expect(candidate?.id).toBe(id(1));
            expect(
              yield* transition(id(1), "running", "failed", "heartbeat_timeout", {
                failure_reason: "heartbeat_timeout",
                error: { source: "krun", message: "Heartbeat timed out" },
              }),
            ).toBe(true);
            const q = yield* makeRunQueries;
            const row = yield* q.getRun(id(1));
            expect(row.failure_reason).toBe("heartbeat_timeout");
            const listed = yield* q.listRuns(
              { terms: [{ field: "failureReason", operator: "=", value: "heartbeat_timeout" }] },
              null,
              50,
            );
            expect(listed.runs).toEqual([toRunSummary(row)]);
            expect(listed.runs[0]?.failureReason).toBe("HEARTBEAT_TIMEOUT");
            const delivery = yield* query(
              async (db) =>
                (await sql<Record<string, unknown>>`select * from deliveries`.execute(db)).rows[0],
            );
            expect(
              typeof delivery?.payload === "string"
                ? JSON.parse(delivery.payload)
                : delivery?.payload,
            ).toEqual(toRunSummary(row));
            expect(yield* stale("function-a", at(2))).toEqual([]);
          }),
        ),
    );
    it.effect(
      "read and whole-batch decode failures are sanitized DatabaseError, never partial rows or empty success",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, base);
            yield* seed(2, base);
            const stale = yield* makeListStale;
            yield* query((db) =>
              sql`update runs set error=${JSON.stringify({ private: "bad-shape" })} where id=${id(2)}`.execute(
                db,
              ),
            );
            const error = yield* Effect.flip(stale("function-a", at(1)));
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("listStale");
            expect(JSON.stringify(error)).not.toMatch(/private|bad-shape/);
            yield* query((db) => sql`drop table deliveries`.execute(db));
            yield* query((db) => sql`drop table run_events`.execute(db));
            yield* query((db) => sql`drop table runs`.execute(db));
            expect(yield* Effect.flip(stale("function-a", at(1)))).toBeInstanceOf(DatabaseError);
          }),
        ),
    );
    it.effect(
      "uses the prescribed dialect expression and exposes only ended operation/row-count span attributes",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, base);
            const service = yield* Database;
            const statements: string[] = [];
            const plugin: KyselyPlugin = {
              transformQuery(args) {
                if (args.node.kind === "RawNode")
                  statements.push(
                    service.db.getExecutor().compileQuery(args.node, args.queryId).sql,
                  );
                return args.node;
              },
              async transformResult(args) {
                return args.result;
              },
            };
            const stale = yield* makeListStale.pipe(
              Effect.provideService(Database, { ...service, db: service.db.withPlugin(plugin) }),
            );
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
              yield* stale("function-a", at(1));
              yield* stale("missing", at(1));
              yield* query((db) => sql`update runs set error='{}' where id=${id(1)}`.execute(db));
              yield* Effect.flip(stale("function-a", at(1)));
            }).pipe(Effect.withTracer(tracer));
            expect(statements).toHaveLength(3);
            expect(statements[0]).toContain(
              dialect === "postgres"
                ? "greatest((runtime_status->>'at')::timestamptz, started_at)"
                : "max(coalesce(json_extract(runtime_status,'$.at'), started_at), started_at)",
            );
            expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([
              1, 0, 0,
            ]);
            for (const span of spans) {
              expect(span.name).toBe("store.listStale");
              expect(span.kind).toBe("client");
              expect(span.status._tag).toBe("Ended");
              expect([...span.attributes.keys()].sort()).toEqual([
                "db.operation.name",
                "db.response.returned_rows",
              ]);
              expect(JSON.stringify([...span.attributes])).not.toMatch(
                /private|select |function-a|dsn/,
              );
            }
          }),
        ),
    );
    it.effect(
      "complete dialect Store layers execute all 24 declared methods without placeholders",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(base));
          const store = yield* Store;
          expect(Object.keys(store).sort()).toEqual(methods);
          yield* store.migrate();
          yield* store.migrate();
          expect(
            (yield* store.createRun({ ...input(1, base), idempotency_key: "krun-test-p33" }))
              .created,
          ).toBe(true);
          expect(
            (yield* store.findRunByRequestId("function-a", "owner-a", "krun-test-p33"))?.id,
          ).toBe(id(1));
          expect(
            yield* store.findRunByRequestId("function-a", "other", "krun-test-p33"),
          ).toBeUndefined();
          expect(
            yield* store.findRunByRequestId("other", "owner-a", "krun-test-p33"),
          ).toBeUndefined();
          expect(yield* store.countQueued("function-a")).toBe(1);
          expect(yield* store.countQueuedBy("function-a", "owner-a")).toBe(1);
          expect((yield* store.countByState()).get("function-a")?.get("queued")).toBe(1);
          expect((yield* store.listByState(["queued"], 10)).map((r) => r.id)).toEqual([id(1)]);
          expect(
            (yield* store.claimQueued("function-a", "scheduler-a", at(10), 1)).map((r) => r.id),
          ).toEqual([id(1)]);
          yield* store.releaseLease(id(1));
          yield* store.setJobToken(id(1), "krun-test-job", "b".repeat(64));
          expect(yield* store.markScheduled(id(1))).toBe(true);
          expect(yield* store.setRuntimeStatus(id(1), { message: "waiting", at: base })).toBe(true);
          expect(yield* store.setResult(id(1), false)).toBe(true);
          expect(yield* store.setError(id(1), { source: "function", message: "reported" })).toBe(
            true,
          );
          expect(yield* store.setJobStatus(id(1), { phase: "Running", observedAt: base })).toBe(
            true,
          );
          expect(yield* store.transition(id(1), "scheduled", "running", null, {})).toBe(true);
          expect((yield* store.listStale("function-a", at(1))).map((r) => r.id)).toEqual([id(1)]);
          expect(
            yield* store.transition(id(1), "running", "failed", "heartbeat_timeout", {
              failure_reason: "heartbeat_timeout",
            }),
          ).toBe(true);
          const row = yield* store.getRun(id(1));
          expect(row.result).toBe(false);
          expect(row.failure_reason).toBe("heartbeat_timeout");
          expect(row.error?.source).toBe("function");
          expect((yield* store.listRuns({}, null, 50)).runs).toEqual([toRunSummary(row)]);
          const [delivery] = yield* store.claimDeliveries(base, 10);
          expect(delivery?.payload).toEqual(toRunSummary(row));
          expect(delivery).toBeDefined();
          if (delivery) yield* store.updateDelivery(delivery.id, "delivered", 1, null, null);
          yield* store.createRun(input(2, base));
          expect((yield* store.expireQueued("function-a", at(1))).map((r) => r.id)).toEqual([
            id(2),
          ]);
          expect((yield* store.getRun(id(2))).failure_reason).toBe("queue_timeout");
          expect(yield* store.sweep(at(1), 10)).toBe(2);
          expect(yield* Effect.flip(store.getRun(id(1)))).toBeInstanceOf(NotFoundError);
          expect(yield* store.listStale("function-a", at(1))).toEqual([]);
        }).pipe(
          Effect.provide(
            dialect === "sqlite" ? StoreSqlite(join(directory, "complete.db")) : StorePostgres(dsn),
          ),
        ),
    );
    it.effect(
      "StoreLive composes the provided Database and translates unknown-pending migration failure into its declared error",
      () =>
        Effect.gen(function* () {
          const service = yield* Database;
          yield* Effect.gen(function* () {
            const store = yield* Store;
            yield* store.migrate();
            yield* store.createRun(input(1, base));
            expect(
              yield* query(
                async (db) =>
                  (
                    await sql<{
                      n: number;
                    }>`select cast(count(*) as integer) as n from runs`.execute(db)
                  ).rows[0]?.n,
              ),
            ).toBe(1);
            const pending = dialect === "sqlite" ? "0002_event_rowid" : "0002_opaque_unicode";
            yield* query(async (db) => {
              await sql`delete from kysely_migration where name=${pending}`.execute(db);
              await sql`insert into kysely_migration(name,timestamp) values('9999_future','2026-10-25T00:00:00.000Z')`.execute(
                db,
              );
            });
            const error = yield* Effect.flip(store.migrate());
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("migrate");
            expect(
              yield* query(async (db) => (await sql`select * from runs`.execute(db)).rows),
            ).toHaveLength(1);
          }).pipe(Effect.provide(StoreLive), Effect.provideService(Database, service));
        }).pipe(Effect.provide(database())),
    );
    it.live(
      "assembled Store subscription observes its real transition within two seconds and closes with scope",
      () =>
        Effect.gen(function* () {
          const service = yield* Database;
          const ready = yield* Deferred.make<void>();
          const snapshots = new Set<unknown>();
          const plugin: KyselyPlugin = {
            transformQuery(args) {
              if (
                args.node.kind === "RawNode" &&
                args.node.sqlFragments.join("").includes("max(rowid)")
              )
                snapshots.add(args.queryId);
              return args.node;
            },
            async transformResult(args) {
              if (snapshots.has(args.queryId)) Deferred.doneUnsafe(ready, Effect.void);
              return args.result;
            },
          };
          yield* Effect.gen(function* () {
            const store = yield* Store;
            yield* store.migrate();
            yield* store.createRun(input(1, yield* DateTime.now));
            const fiber = yield* store
              .subscribe()
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
            if (dialect === "sqlite") yield* Deferred.await(ready);
            else
              yield* query(
                async (db) =>
                  (
                    await sql<{
                      n: number;
                    }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and query='LISTEN krun_runs' and state='idle'`.execute(
                      db,
                    )
                  ).rows[0]?.n,
              ).pipe(Effect.repeat({ until: (n) => n === 1 }), Effect.timeout("2 seconds"));
            expect(
              yield* store.transition(
                id(1),
                "queued",
                "cancelling",
                null,
                {},
                { actor: "owner-a" },
              ),
            ).toBe(true);
            expect(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))).toEqual([
              { id: id(1), kind: "state" },
            ]);
          }).pipe(
            Effect.provide(StoreLive),
            Effect.provideService(Database, { ...service, db: service.db.withPlugin(plugin) }),
          );
        }).pipe(Effect.provide(database())),
    );
  });
}
