import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Queue,
  type Scope,
  Stream,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { type KyselyPlugin, sql } from "kysely";
import { Client, Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { DatabaseError } from "../errors.js";
import { migrate } from "../migrations.js";
import { makeRunMaintenance } from "../run-maintenance.js";
import { makeRunSubscriptions } from "../run-subscriptions.js";
import { makeTransition } from "../transition.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p18-subscriptions-${process.pid}`)
      .withDatabase("krun_test_p18")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned subscription Postgres fixture failed");
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
      catch: () => new Error("Owned subscription query failed"),
    }),
  );
const seed = (n: number) =>
  Effect.gen(function* () {
    const create = yield* makeCreateRun;
    yield* create({
      id: id(n),
      function_name: "function-a",
      input: {},
      priority: 0,
      callback_url: null,
      created_by: "owner-a",
      created_at: yield* DateTime.now,
      idempotency_key: null,
      request_hash: "a".repeat(64),
    });
  });
const listeners = () =>
  query(
    async (db) =>
      (
        await sql<{
          pid: number;
        }>`select pid from pg_stat_activity where datname=current_database() and query='LISTEN krun_runs' and state='idle' order by pid`.execute(
          db,
        )
      ).rows,
  );
const waitListeners = (count: number, previous?: number) =>
  listeners().pipe(
    Effect.repeat({
      until: (rows) =>
        rows.length === count && (previous === undefined || rows.every((r) => r.pid !== previous)),
    }),
    Effect.timeout("2 seconds"),
  );
const notify = (payload: string, channel = "krun_runs") =>
  query((db) => sql`select pg_notify(${channel},${payload})`.execute(db));

const trace = Effect.gen(function* () {
  const native = yield* Effect.tracer;
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = native.span(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
});
const assertSpans = (spans: Tracer.Span[]) => {
  expect(spans.map((s) => s.name)).toEqual(["store.subscribe", "store.subscribe"]);
  expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([1, 0]);
  for (const span of spans) {
    expect(span.kind).toBe("client");
    expect(span.status._tag).toBe("Ended");
    expect([...span.attributes.keys()].sort()).toEqual([
      "db.operation.name",
      "db.response.returned_rows",
    ]);
    expect(JSON.stringify([...span.attributes])).not.toMatch(
      /private|select |update |dsn|input|result/,
    );
  }
};
for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`subscription contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p18-subscriptions-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned subscription reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const run = <A, E>(program: Effect.Effect<A, E, Database | Scope.Scope>) =>
      Effect.gen(function* () {
        yield* migrate;
        return yield* program;
      }).pipe(
        Effect.provide(
          dialect === "sqlite" ? DatabaseSqlite(join(directory, "runs.db")) : DatabasePostgres(dsn),
        ),
      );

    if (dialect === "sqlite") {
      const observed = (ready: Deferred.Deferred<void>, counted?: () => void) =>
        Effect.gen(function* () {
          const database = yield* Database;
          const snapshots = new Set<unknown>();
          const plugin: KyselyPlugin = {
            transformQuery(args) {
              counted?.();
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
          return yield* makeRunSubscriptions.pipe(
            Effect.provideService(Database, { ...database, db: database.db.withPlugin(plugin) }),
          );
        });
      it.effect(
        "starts at subscription max(rowid), observes within one second and never replays rows",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              const ready = yield* Deferred.make<void>();
              const { subscribe } = yield* observed(ready);
              const events = yield* Queue.unbounded<{ id: string; kind: string }>();
              const fiber = yield* subscribe().pipe(
                Stream.runForEach((e) => Queue.offer(events, e)),
                Effect.forkScoped,
              );
              yield* Deferred.await(ready);
              yield* seed(2);
              yield* TestClock.adjust("999 millis");
              expect(yield* Queue.size(events)).toBe(0);
              yield* TestClock.adjust("1 millis");
              expect(yield* Queue.take(events)).toEqual({ id: id(2), kind: "state" });
              yield* TestClock.adjust("3 seconds");
              yield* seed(3);
              yield* TestClock.adjust("1 second");
              expect(yield* Queue.take(events)).toEqual({ id: id(3), kind: "state" });
              yield* Fiber.interrupt(fiber);
            }),
          ),
      );
      it.effect(
        "classifies same-state rows as job_status and emits committed batches in rowid order",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              const ready = yield* Deferred.make<void>();
              const { subscribe } = yield* observed(ready);
              const fiber = yield* subscribe().pipe(
                Stream.take(3),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* Deferred.await(ready);
              const at = DateTime.formatIso(yield* DateTime.now);
              yield* query((db) =>
                db.transaction().execute(async (tx) => {
                  for (const [from, to] of [
                    ["queued", "cancelling"],
                    ["cancelling", "cancelling"],
                    ["cancelling", "cancelled"],
                  ] as const)
                    await sql`insert into run_events(run_id,at,from_state,to_state,reason) values(${id(1)},${at},${from},${to},'test')`.execute(
                      tx,
                    );
                }),
              );
              yield* TestClock.adjust("1 second");
              expect(yield* Fiber.join(fiber)).toEqual([
                { id: id(1), kind: "state" },
                { id: id(1), kind: "job_status" },
                { id: id(1), kind: "state" },
              ]);
            }),
          ),
      );
      it.effect("each subscriber owns its initial cursor and cancellation stops polling", () =>
        run(
          Effect.gen(function* () {
            let calls = 0;
            const readyA = yield* Deferred.make<void>();
            const a = yield* observed(readyA, () => {
              calls++;
            });
            const eventsA: string[] = [];
            const fa = yield* a.subscribe().pipe(
              Stream.runForEach((e) =>
                Effect.sync(() => {
                  eventsA.push(e.id);
                }),
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(readyA);
            yield* seed(1);
            const readyB = yield* Deferred.make<void>();
            const b = yield* observed(readyB);
            const fb = yield* b
              .subscribe()
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
            yield* Deferred.await(readyB);
            yield* seed(2);
            yield* TestClock.adjust("1 second");
            expect(yield* Fiber.join(fb)).toEqual([{ id: id(2), kind: "state" }]);
            expect(eventsA).toEqual([id(1), id(2)]);
            yield* Fiber.interrupt(fa);
            const stoppedAt = calls;
            yield* TestClock.adjust("5 seconds");
            expect(calls).toBe(stoppedAt);
          }),
        ),
      );
      it.effect("poll failure is typed rather than an empty batch", () =>
        run(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const { subscribe } = yield* observed(ready);
            const fiber = yield* subscribe().pipe(
              Stream.runCollect,
              Effect.flip,
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            yield* query((db) => sql`drop table run_events`.execute(db));
            yield* TestClock.adjust("1 second");
            const error = yield* Fiber.join(fiber);
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("subscribe");
            expect(JSON.stringify(error)).not.toContain("run_events");
          }),
        ),
      );
      it.effect("corrupt rows fail the batch without leaking data or pretending to progress", () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const ready = yield* Deferred.make<void>();
            const { subscribe } = yield* observed(ready);
            const fiber = yield* subscribe().pipe(
              Stream.runCollect,
              Effect.flip,
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            yield* query((db) =>
              sql`insert into run_events(run_id,at,from_state,to_state) values(${id(1)},'2026-10-24T00:00:00.000Z','queued','private-corruption')`.execute(
                db,
              ),
            );
            yield* TestClock.adjust("1 second");
            const error = yield* Fiber.join(fiber);
            expect(error).toBeInstanceOf(DatabaseError);
            expect(JSON.stringify(error)).not.toContain("private-corruption");
          }),
        ),
      );
      it.effect(
        "subscription cursor initializes at consumption, not factory or stream creation",
        () =>
          run(
            Effect.gen(function* () {
              const ready = yield* Deferred.make<void>();
              const { subscribe } = yield* observed(ready);
              const stream = subscribe();
              yield* seed(1);
              const fiber = yield* stream.pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* Deferred.await(ready);
              yield* seed(2);
              yield* TestClock.adjust("1 second");
              expect(yield* Fiber.join(fiber)).toEqual([{ id: id(2), kind: "state" }]);
            }),
          ),
      );
      it.effect("observes the production transition and ends redacted success/failure spans", () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const ready = yield* Deferred.make<void>();
            const { subscribe } = yield* observed(ready);
            const { spans, tracer } = yield* trace;
            const fiber = yield* subscribe().pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.withTracer(tracer),
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            const transition = yield* makeTransition;
            expect(yield* transition(id(1), "queued", "cancelling", null, {})).toBe(true);
            yield* TestClock.adjust("1 second");
            expect(yield* Fiber.join(fiber)).toEqual([{ id: id(1), kind: "state" }]);
            yield* query((db) => sql`drop table run_events`.execute(db));
            expect(
              yield* subscribe().pipe(Stream.runCollect, Effect.flip, Effect.withTracer(tracer)),
            ).toBeInstanceOf(DatabaseError);
            assertSpans(spans);
          }),
        ),
      );
      for (const preserveOlderRow of [false, true]) {
        it.effect(
          `retention cannot reuse a live cursor after ${preserveOlderRow ? "highest-row deletion" : "emptying events"}`,
          () =>
            run(
              Effect.gen(function* () {
                yield* TestClock.setTime(
                  DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T00:00:00.000Z")),
                );
                if (preserveOlderRow) yield* seed(0);
                yield* seed(1);
                const transition = yield* makeTransition;
                yield* transition(id(1), "queued", "failed", "job_create_failed", {
                  failure_reason: "job_create_failed",
                });
                const initial = yield* query(
                  async (db) =>
                    (
                      await sql<{
                        rowid: number;
                      }>`select max(rowid) as rowid from run_events`.execute(db)
                    ).rows[0]?.rowid ?? 0,
                );
                yield* TestClock.adjust("720 hours");
                yield* TestClock.adjust("1 millis");
                const ready = yield* Deferred.make<void>();
                const { subscribe } = yield* observed(ready);
                const events = yield* Queue.unbounded<{ id: string; kind: string }>();
                const consumer = yield* subscribe().pipe(
                  Stream.runForEach((e) => Queue.offer(events, e)),
                  Effect.forkScoped,
                );
                yield* Deferred.await(ready);
                const maintenance = yield* makeRunMaintenance;
                expect(
                  yield* maintenance.sweep(
                    DateTime.subtractDuration(yield* DateTime.now, "720 hours"),
                    10,
                  ),
                ).toBe(1);
                yield* seed(2);
                yield* transition(id(2), "queued", "cancelling", null, {});
                const fresh = yield* query(
                  async (db) =>
                    (
                      await sql<{
                        rowid: number;
                      }>`select rowid from run_events where run_id=${id(2)} order by rowid`.execute(
                        db,
                      )
                    ).rows,
                );
                expect(fresh.every((row) => row.rowid > initial)).toBe(true);
                yield* TestClock.adjust("1 second");
                expect(yield* Queue.take(events)).toEqual({ id: id(2), kind: "state" });
                expect(yield* Queue.take(events)).toEqual({ id: id(2), kind: "state" });
                yield* TestClock.adjust("2 seconds");
                yield* seed(3);
                yield* TestClock.adjust("1 second");
                expect(yield* Queue.take(events)).toEqual({ id: id(3), kind: "state" });
                expect(yield* Queue.size(events)).toBe(0);
                yield* Fiber.interrupt(consumer);
              }),
            ),
        );
      }
      it.effect("snapshot failures are typed and do not expose driver data", () =>
        run(
          Effect.gen(function* () {
            yield* query((db) => sql`drop table run_events`.execute(db));
            const { subscribe } = yield* makeRunSubscriptions;
            const error = yield* Effect.flip(Stream.runCollect(subscribe()));
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("subscribe");
            expect(JSON.stringify(error)).not.toContain("run_events");
          }),
        ),
      );
    } else {
      it.live(
        "observes a real committed transition within two seconds and closes LISTEN on completion",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              const { subscribe } = yield* makeRunSubscriptions;
              const fiber = yield* subscribe().pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* waitListeners(1);
              const transition = yield* makeTransition;
              const start = yield* Clock.currentTimeMillis;
              yield* transition(id(1), "queued", "cancelling", null, {});
              expect(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(1), kind: "state" },
              ]);
              expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
              yield* waitListeners(0);
            }),
          ),
      );
      it.live(
        "routes all notification kinds and ignores malformed,unknown and wrong-channel payloads",
        () =>
          run(
            Effect.gen(function* () {
              const { subscribe } = yield* makeRunSubscriptions;
              const fiber = yield* subscribe().pipe(
                Stream.take(3),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* waitListeners(1);
              for (const payload of [
                "",
                "private:not-a-kind",
                `${id(1)}:unknown`,
                `${id(1)}:queued:extra`,
                `not-a-uuid:status`,
              ])
                yield* notify(payload);
              yield* notify(`${id(1)}:queued`, "krun_other");
              for (const suffix of ["queued", "status", "job_status"])
                yield* notify(`${id(1)}:${suffix}`);
              expect(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(1), kind: "state" },
                { id: id(1), kind: "status" },
                { id: id(1), kind: "job_status" },
              ]);
            }),
          ),
      );
      it.live("reconnects a terminated dedicated client once and continues delivering", () =>
        run(
          Effect.gen(function* () {
            const { subscribe } = yield* makeRunSubscriptions;
            const events = yield* Queue.unbounded<{ id: string; kind: string }>();
            const fiber = yield* subscribe().pipe(
              Stream.runForEach((e) => Queue.offer(events, e)),
              Effect.forkScoped,
            );
            const [first] = yield* waitListeners(1);
            expect(first).toBeDefined();
            yield* notify(`${id(1)}:status`);
            expect(yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))).toEqual({
              id: id(1),
              kind: "status",
            });
            yield* query((db) => sql`select pg_terminate_backend(${first?.pid})`.execute(db));
            const [second] = yield* waitListeners(1, first?.pid);
            expect(second?.pid).not.toBe(first?.pid);
            yield* notify(`${id(2)}:job_status`);
            expect(yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))).toEqual({
              id: id(2),
              kind: "job_status",
            });
            yield* Fiber.interrupt(fiber);
            yield* waitListeners(0);
          }),
        ),
      );
      it.live(
        "shares exactly one dedicated connection and keeps it until the last consumer exits",
        () =>
          run(
            Effect.gen(function* () {
              const a = yield* makeRunSubscriptions;
              const b = yield* makeRunSubscriptions;
              const fa = yield* a
                .subscribe()
                .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
              const fb = yield* b
                .subscribe()
                .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
              yield* waitListeners(1);
              yield* notify(`${id(1)}:status`);
              expect(yield* Fiber.join(fa).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(1), kind: "status" },
              ]);
              expect(yield* listeners()).toHaveLength(1);
              yield* notify(`${id(2)}:status`);
              expect(yield* Fiber.join(fb).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(1), kind: "status" },
                { id: id(2), kind: "status" },
              ]);
              yield* waitListeners(0);
            }),
          ),
      );
      it.live("LISTEN remains responsive with all five query-pool connections held", () =>
        run(
          Effect.gen(function* () {
            const control = yield* Effect.acquireRelease(
              Effect.sync(() => new Client({ connectionString: dsn, query_timeout: 10000 })),
              (client) => Effect.promise(() => client.end()),
            );
            const external = <A>(f: () => Promise<A>) =>
              Effect.tryPromise({
                try: f,
                catch: () => new Error("Owned subscription control failed"),
              });
            yield* external(() => control.connect());
            const release = Promise.withResolvers<void>();
            yield* Effect.gen(function* () {
              const held = yield* Queue.unbounded<number>();
              const workers = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
                query((db) =>
                  db.connection().execute(async (connection) => {
                    const row = (
                      await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection)
                    ).rows[0];
                    Queue.offerUnsafe(held, row?.pid ?? 0);
                    await release.promise;
                  }),
                ).pipe(Effect.forkScoped),
              );
              const pids = yield* Effect.forEach([1, 2, 3, 4, 5], () => Queue.take(held));
              expect(new Set(pids).size).toBe(5);
              const { subscribe } = yield* makeRunSubscriptions;
              const consumer = yield* subscribe().pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.forkScoped,
              );
              const rows = yield* external(
                async () =>
                  (
                    await control.query<{ pid: number }>(
                      "select pid from pg_stat_activity where datname=current_database() and query='LISTEN krun_runs' and state='idle'",
                    )
                  ).rows,
              ).pipe(
                Effect.repeat({ until: (rows) => rows.length === 1 }),
                Effect.timeout("2 seconds"),
              );
              expect(pids).not.toContain(rows[0]?.pid);
              const start = yield* Clock.currentTimeMillis;
              yield* external(() =>
                control.query("select pg_notify('krun_runs',$1)", [`${id(1)}:status`]),
              );
              expect(yield* Fiber.join(consumer).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(1), kind: "status" },
              ]);
              expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
              release.resolve();
              yield* Effect.forEach(workers, (worker) => Fiber.join(worker));
            }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
          }),
        ),
      );
      it.effect("cancelling during reconnect backoff prevents later client acquisition", () =>
        run(
          Effect.gen(function* () {
            const { subscribe } = yield* makeRunSubscriptions;
            const consumer = yield* subscribe().pipe(Stream.runCollect, Effect.forkScoped);
            const [first] = yield* waitListeners(1);
            yield* query((db) => sql`select pg_terminate_backend(${first?.pid})`.execute(db));
            yield* waitListeners(0);
            yield* Fiber.interrupt(consumer);
            yield* TestClock.adjust("10 seconds");
            expect(yield* listeners()).toEqual([]);
          }),
        ),
      );
      it.live(
        "transaction rollback sends no notification and a committed barrier stays ordered",
        () =>
          run(
            Effect.gen(function* () {
              const { subscribe } = yield* makeRunSubscriptions;
              const consumer = yield* subscribe().pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.forkScoped,
              );
              yield* waitListeners(1);
              const failed = yield* query((db) =>
                db.transaction().execute(async (tx) => {
                  await sql`select pg_notify('krun_runs',${`${id(1)}:queued`})`.execute(tx);
                  await sql`select * from krun_test_p18_missing_table`.execute(tx);
                }),
              ).pipe(Effect.exit);
              expect(failed._tag).toBe("Failure");
              yield* notify(`${id(2)}:status`);
              expect(yield* Fiber.join(consumer).pipe(Effect.timeout("2 seconds"))).toEqual([
                { id: id(2), kind: "status" },
              ]);
            }),
          ),
      );
      it.live("ends redacted consumer spans and fails closed without a Postgres transport", () =>
        run(
          Effect.gen(function* () {
            const { subscribe } = yield* makeRunSubscriptions;
            const { spans, tracer } = yield* trace;
            const consumer = yield* subscribe().pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.withTracer(tracer),
              Effect.forkScoped,
            );
            yield* waitListeners(1);
            yield* notify(`${id(1)}:status`);
            expect(yield* Fiber.join(consumer).pipe(Effect.timeout("2 seconds"))).toEqual([
              { id: id(1), kind: "status" },
            ]);
            const { db } = yield* Database;
            const missing = yield* makeRunSubscriptions.pipe(
              Effect.provideService(Database, { db, dialect: "postgres" }),
            );
            const error = yield* missing
              .subscribe()
              .pipe(Stream.runCollect, Effect.flip, Effect.withTracer(tracer));
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("subscribe");
            assertSpans(spans);
          }),
        ),
      );
      it.live("does not open a dedicated listener until a stream is consumed", () =>
        run(
          Effect.gen(function* () {
            const { subscribe } = yield* makeRunSubscriptions;
            subscribe();
            expect(yield* listeners()).toEqual([]);
          }),
        ),
      );
    }
  });
}
