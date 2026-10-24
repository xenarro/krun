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
import { toRunSummary } from "../mappers.js";
import { migrate } from "../migrations.js";
import type { NewRun, State } from "../model.js";
import { decodeRun } from "../rows.js";
import { makeRunLeasing } from "../run-leasing.js";
import { makeTransition } from "../transition.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p15-transition-${process.pid}`)
      .withDatabase("krun_test_p15")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned transition Postgres fixture failed");
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
      catch: () => new Error("Owned transition fixture query failed"),
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
      catch: () => new Error("Owned transition fixture decode failed"),
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

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`transition contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p15-transition-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned transition schema reset failed");
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
      "running CAS sets started_at exactly to event at, carries actor and preserves creation time",
      () =>
        run(
          Effect.gen(function* () {
            const original = yield* seed(1, {}, "scheduled");
            const transition = yield* makeTransition;
            yield* TestClock.adjust("1234 millis");
            expect(
              yield* transition(id(1), "scheduled", "running", null, {}, { actor: "owner-a" }),
            ).toBe(true);
            const row = yield* stored(1);
            const all = yield* events();
            const event = all[1];
            expect(row.state).toBe("running");
            expect(row.finished_at).toBeNull();
            expect(DateTime.formatIso(row.created_at)).toBe(
              DateTime.formatIso(original.created_at),
            );
            expect(stamp(row.started_at)).toBe("2026-10-24T00:00:01.234Z");
            expect(iso(event?.at)).toBe(stamp(row.started_at));
            expect(event).toMatchObject({
              from_state: "scheduled",
              to_state: "running",
              reason: null,
            });
            expect(json(event?.payload)).toEqual({ actor: "owner-a" });
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
    );

    it.effect(
      "stale and absent transitions return false without changing any row, event or delivery",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, { callback_url: "https://callback.invalid/terminal" }, "running");
            const transition = yield* makeTransition;
            const before = yield* stored(1);
            const history = yield* events();
            expect(
              yield* transition(id(1), "scheduled", "failed", "job_lost", {
                failure_reason: "job_lost",
                error: { source: "krun", message: "not applied" },
              }),
            ).toBe(false);
            expect(yield* transition(id(999), "running", "succeeded", null, {})).toBe(false);
            expect(yield* stored(1)).toEqual(before);
            expect(yield* events()).toEqual(history);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
    );

    for (const to of ["succeeded", "failed", "cancelled"] as const) {
      it.effect(
        `terminal ${to} atomically inserts exactly one pending BASIC updated-row delivery`,
        () =>
          run(
            Effect.gen(function* () {
              const from = to === "cancelled" ? "cancelling" : "running";
              yield* seed(1, { callback_url: "https://callback.invalid/terminal" }, from);
              const transition = yield* makeTransition;
              const started = DateTime.addDuration(yield* DateTime.now, "1 second");
              const observed = DateTime.addDuration(yield* DateTime.now, "2 seconds");
              yield* TestClock.adjust("5 seconds");
              const patch = {
                started_at: started,
                result: { secretResult: "not BASIC" },
                result_ref: "s3://test/result",
                log_tail: "not BASIC",
                failure_reason: to === "failed" ? ("exit_code" as const) : null,
                error: {
                  source: "function" as const,
                  message: "reported",
                  details: { privateDetails: "not BASIC" },
                },
                runtime_status: { message: "working", progress: 0.5, at: observed },
                job_status: { phase: "Succeeded", exitCode: 0, observedAt: observed },
              };
              expect(
                yield* transition(id(1), from, to, to === "failed" ? "exit_code" : null, patch),
              ).toBe(true);
              expect(yield* transition(id(1), from, to, null, {})).toBe(false);
              const row = yield* stored(1);
              const event = (yield* events())[1];
              const ds = yield* deliveries();
              expect(ds).toHaveLength(1);
              const d = ds[0] ?? {};
              expect(d).toMatchObject({
                run_id: id(1),
                url: "https://callback.invalid/terminal",
                state: "pending",
                attempt: 0,
                last_error: null,
              });
              expect(d.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
              );
              expect(iso(d.created_at)).toBe("2026-10-24T00:00:05.000Z");
              expect(iso(d.next_at)).toBe(iso(d.created_at));
              expect(stamp(row.finished_at)).toBe(iso(event?.at));
              expect(iso(d.created_at)).toBe(iso(event?.at));
              expect(stamp(row.started_at)).toBe(DateTime.formatIso(started));
              expect(row.result).toEqual(patch.result);
              expect(row.job_status).toEqual(patch.job_status);
              expect(row.runtime_status).toEqual(patch.runtime_status);
              expect(json(d.payload)).toEqual(toRunSummary(row));
              expect(json(event?.payload)).toBeNull();
              expect(json(d.payload)).toMatchObject({
                name: `functions/function-a/runs/${id(1)}`,
                state: to.toUpperCase(),
                createTime: "2026-10-24T00:00:00.000Z",
                resultUri: "s3://test/result",
              });
              const body = JSON.stringify(json(d.payload));
              for (const privateValue of [
                "secretResult",
                "privateDetails",
                "not BASIC",
                "opaque",
                "job_token_hash",
              ])
                expect(body).not.toContain(privateValue);
              expect(json(d.payload)).not.toHaveProperty("input");
              expect(json(d.payload)).not.toHaveProperty("result");
              expect(json(d.payload)).not.toHaveProperty("logTail");
              expect(json(d.payload)).not.toHaveProperty("error.details");
            }),
          ),
      );
      it.effect(`terminal ${to} without callback never creates a delivery`, () =>
        run(
          Effect.gen(function* () {
            const from = to === "cancelled" ? "cancelling" : "running";
            yield* seed(1, {}, from);
            const transition = yield* makeTransition;
            expect(yield* transition(id(1), from, to, null, {})).toBe(true);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
      );
    }
    it.effect(
      "20 concurrent terminal CAS attempts have one winner, one event and one delivery",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, { callback_url: "https://callback.invalid/race" }, "running");
            const transition = yield* makeTransition;
            const results = yield* Effect.all(
              Array.from({ length: 20 }, () => transition(id(1), "running", "succeeded", null, {})),
              { concurrency: "unbounded" },
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(yield* events()).toHaveLength(2);
            expect(yield* deliveries()).toHaveLength(1);
          }),
        ),
    );
    it.effect(
      "competing cancellation and terminal CAS cannot leak the losing patch or callback",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, { callback_url: "https://callback.invalid/race" }, "running");
            const transition = yield* makeTransition;
            const results = yield* Effect.all(
              [
                transition(
                  id(1),
                  "running",
                  "cancelling",
                  null,
                  { log_tail: "cancel-winner" },
                  { actor: "owner-b" },
                ),
                transition(id(1), "running", "failed", "job_lost", {
                  failure_reason: "job_lost",
                  log_tail: "terminal-winner",
                }),
              ],
              { concurrency: "unbounded" },
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            const row = yield* stored(1);
            const ds = yield* deliveries();
            expect(row.log_tail).toBe(results[0] ? "cancel-winner" : "terminal-winner");
            expect(ds).toHaveLength(results[0] ? 0 : 1);
            expect(yield* events()).toHaveLength(2);
          }),
        ),
    );
    it.effect(
      "coalesce preserves accepted FUNCTION error over KRUN, Kubernetes and explicit null",
      () =>
        run(
          Effect.gen(function* () {
            const transition = yield* makeTransition;
            const own = { source: "function", message: "owned report", details: { opaque: 1 } };
            for (const [index, replacement] of [
              { source: "krun" as const, message: "timeout" },
              { source: "kubernetes" as const, message: "evicted" },
              null,
            ].entries()) {
              const n = index + 1;
              yield* seed(n, {}, "running");
              yield* query((db) =>
                sql`update runs set error=${JSON.stringify(own)} where id=${id(n)}`.execute(db),
              );
              expect(
                yield* transition(id(n), "running", "failed", "job_lost", {
                  failure_reason: "job_lost",
                  error: replacement,
                }),
              ).toBe(true);
              const row = yield* stored(n);
              expect(row.error).toEqual(own);
              expect(row.failure_reason).toBe("job_lost");
            }
          }),
        ),
    );
    it.effect(
      "empty errors accept patch.error, omitted error preserves null, and JSON-null is SQL null",
      () =>
        run(
          Effect.gen(function* () {
            const transition = yield* makeTransition;
            for (const [index, error] of [
              { source: "krun" as const, message: "lost" },
              { source: "kubernetes" as const, message: "evicted" },
              null,
            ].entries()) {
              const n = index + 1;
              yield* seed(n, {}, "running");
              expect(yield* transition(id(n), "running", "failed", "job_lost", { error })).toBe(
                true,
              );
              expect((yield* stored(n)).error).toEqual(error);
            }
            yield* seed(4, {}, "running");
            expect(yield* transition(id(4), "running", "succeeded", null, {})).toBe(true);
            expect((yield* stored(4)).error).toBeNull();
          }),
        ),
    );
    it.effect("skipped-running terminal uses supplied start time without inventing one", () =>
      run(
        Effect.gen(function* () {
          const transition = yield* makeTransition;
          yield* seed(1, {}, "scheduled");
          yield* seed(2, {}, "scheduled");
          expect(yield* transition(id(1), "scheduled", "succeeded", null, {})).toBe(true);
          expect((yield* stored(1)).started_at).toBeNull();
          const at = yield* DateTime.now;
          yield* TestClock.adjust("1 second");
          expect(yield* transition(id(2), "scheduled", "succeeded", null, { started_at: at })).toBe(
            true,
          );
          expect((yield* stored(2)).started_at).toEqual(at);
        }),
      ),
    );
    for (const broken of ["run_events", "deliveries"] as const) {
      it.effect(
        `failure inserting ${broken} rolls back state, timestamps, patch and all dependent writes`,
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1, { callback_url: "https://callback.invalid/rollback" }, "running");
              const transition = yield* makeTransition;
              const before = yield* stored(1);
              yield* query((db) => sql`drop table ${sql.ref(broken)}`.execute(db));
              const error = yield* Effect.flip(
                transition(id(1), "running", "succeeded", null, { log_tail: "not committed" }),
              );
              expect(error).toBeInstanceOf(DatabaseError);
              expect(Object.keys(error).sort()).toEqual(["_tag", "operation"]);
              expect(error.operation).toBe("transition");
              expect(yield* stored(1)).toEqual(before);
              if (broken === "deliveries") expect(yield* events()).toHaveLength(1);
              else expect(yield* deliveries()).toHaveLength(0);
            }),
          ),
      );
    }
    it.effect(
      "P15-CONTRACT-1 preserves create/schedule event timestamps in the row and terminal BASIC",
      () =>
        run(
          Effect.gen(function* () {
            const original = yield* seed(1, { callback_url: "https://callback.invalid/lifecycle" });
            const leasing = yield* makeRunLeasing;
            yield* TestClock.adjust("1 second");
            expect(yield* leasing.markScheduled(id(1))).toBe(true);
            const scheduled = yield* stored(1);
            const history = yield* events();
            const transition = yield* makeTransition;
            yield* TestClock.adjust("1 second");
            const fake = DateTime.makeUnsafe("2000-01-01T00:00:00.000Z");
            expect(
              yield* transition(id(1), "scheduled", "succeeded", null, {
                created_at: fake,
                scheduled_at: fake,
              }),
            ).toBe(true);
            const row = yield* stored(1);
            const all = yield* events();
            expect(row.created_at).toEqual(original.created_at);
            expect(row.scheduled_at).toEqual(scheduled.scheduled_at);
            expect(all.slice(0, 2)).toEqual(history);
            expect(stamp(row.created_at)).toBe(iso(all[0]?.at));
            expect(stamp(row.scheduled_at)).toBe(iso(all[1]?.at));
            const ds = yield* deliveries();
            expect(ds).toHaveLength(1);
            expect(json(ds[0]?.payload)).toMatchObject({
              createTime: DateTime.formatIso(original.created_at),
              scheduleTime: stamp(scheduled.scheduled_at),
              state: "SUCCEEDED",
            });
          }),
        ),
    );
    it.effect(
      "P15-CONTRACT-1 queued cancellation cannot backfill start before a terminal transition",
      () =>
        run(
          Effect.gen(function* () {
            const original = yield* seed(1);
            const transition = yield* makeTransition;
            const fake = DateTime.makeUnsafe("2000-01-01T00:00:00.000Z");
            expect(
              yield* transition(
                id(1),
                "queued",
                "cancelling",
                null,
                { started_at: fake },
                { actor: "owner-b" },
              ),
            ).toBe(true);
            const cancelling = yield* stored(1);
            expect(cancelling.created_at).toEqual(original.created_at);
            expect(cancelling.scheduled_at).toBeNull();
            expect(cancelling.started_at).toBeNull();
            expect(cancelling.finished_at).toBeNull();
            expect(json((yield* events())[1]?.payload)).toEqual({ actor: "owner-b" });
            yield* TestClock.adjust("1 second");
            expect(
              yield* transition(id(1), "cancelling", "cancelled", null, {
                started_at: original.created_at,
              }),
            ).toBe(true);
            expect((yield* stored(1)).started_at).toEqual(original.created_at);
          }),
        ),
    );
    it.effect(
      "running and terminal timestamps override patch; existing start survives terminal enrichment",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, {}, "scheduled");
            const transition = yield* makeTransition;
            const fake = DateTime.makeUnsafe("2020-01-01T00:00:00.000Z");
            expect(
              yield* transition(id(1), "scheduled", "running", null, {
                started_at: fake,
                state: "failed",
                id: id(99),
              }),
            ).toBe(true);
            const start = (yield* stored(1)).started_at;
            expect(stamp(start)).toBe("2026-10-24T00:00:00.000Z");
            yield* TestClock.adjust("2 seconds");
            expect(
              yield* transition(id(1), "running", "succeeded", null, {
                started_at: fake,
                finished_at: fake,
              }),
            ).toBe(true);
            const row = yield* stored(1);
            expect(row.started_at).toEqual(start);
            expect(stamp(row.finished_at)).toBe("2026-10-24T00:00:02.000Z");
          }),
        ),
    );
    it.effect(
      "frozen-clock terminal callbacks have distinct UUIDv7 ids with the clock's timestamp",
      () =>
        run(
          Effect.gen(function* () {
            const transition = yield* makeTransition;
            for (let n = 1; n <= 10; n++)
              yield* seed(n, { callback_url: "https://callback.invalid/same-ms" }, "running");
            yield* Effect.all(
              Array.from({ length: 10 }, (_, n) =>
                transition(id(n + 1), "running", "succeeded", null, {}),
              ),
              { concurrency: "unbounded" },
            );
            const ds = yield* deliveries();
            expect(ds).toHaveLength(10);
            expect(new Set(ds.map((d) => d.id)).size).toBe(10);
            for (const d of ds)
              expect(Number.parseInt(String(d.id).replaceAll("-", "").slice(0, 12), 16)).toBe(
                DateTime.toEpochMillis(yield* DateTime.now),
              );
          }),
        ),
    );
    it.effect("invalid returned row decoding rolls the entire transaction back", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1, { callback_url: "https://callback.invalid/rollback" }, "running");
          const transition = yield* makeTransition;
          const before = yield* stored(1);
          expect(
            yield* Effect.flip(
              transition(id(1), "running", "succeeded", null, {
                error: { source: "krun", message: "bad" },
                failure_reason: "invalid" as never,
              }),
            ),
          ).toBeInstanceOf(DatabaseError);
          expect(yield* stored(1)).toEqual(before);
          expect(yield* events()).toHaveLength(1);
          expect(yield* deliveries()).toHaveLength(0);
        }),
      ),
    );
    it.effect("success, stale and failure spans contain only method/count/run id", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1, {}, "scheduled");
          const transition = yield* makeTransition;
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
            yield* transition(id(1), "scheduled", "running", null, {
              error: {
                source: "function",
                message: "private-message",
                details: { privateData: 1 },
              },
            });
            yield* transition(id(1), "scheduled", "running", null, {});
            yield* query((db) => sql`drop table run_events`.execute(db));
            yield* Effect.flip(transition(id(1), "running", "failed", null, {}));
          }).pipe(Effect.withTracer(tracer));
          expect(spans).toHaveLength(3);
          expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([
            1, 0, 0,
          ]);
          for (const span of spans) {
            expect(span.name).toBe("store.transition");
            expect(span.kind).toBe("client");
            expect(span.status._tag).toBe("Ended");
            expect([...span.attributes.keys()].sort()).toEqual([
              "db.operation.name",
              "db.response.returned_rows",
              "krun.run_id",
            ]);
            expect(span.attributes.get("krun.run_id")).toBe(id(1));
            expect(JSON.stringify([...span.attributes])).not.toContain("private");
          }
        }),
      ),
    );
    if (dialect === "postgres")
      it.effect(
        "Postgres notification sees committed run/event/delivery; stale and deferred commit failure never notify",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1, { callback_url: "https://callback.invalid/notify" }, "running");
              yield* seed(2, { callback_url: "https://callback.invalid/rollback" }, "running");
              const transition = yield* makeTransition;
              const client = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: async () => {
                    const c = new Client({ connectionString: dsn, query_timeout: 10000 });
                    await c.connect();
                    return c;
                  },
                  catch: () => new Error("Owned transition listener failed"),
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
                catch: () => new Error("Owned listen failed"),
              });
              expect(yield* transition(id(1), "running", "succeeded", null, {})).toBe(true);
              yield* Effect.promise(() => delivered);
              const visible = yield* Effect.tryPromise({
                try: () =>
                  client.query(
                    "select r.state,(select count(*)::int from run_events where run_id=r.id) as events,(select count(*)::int from deliveries where run_id=r.id) as deliveries from runs r where id=$1",
                    [id(1)],
                  ),
                catch: () => new Error("Owned commit visibility failed"),
              });
              expect(visible.rows[0]).toEqual({ state: "succeeded", events: 2, deliveries: 1 });
              expect(yield* transition(id(1), "running", "succeeded", null, {})).toBe(false);
              yield* query(async (db) => {
                await sql`create function krun_test_p15_deferred_fail() returns trigger language plpgsql as $$ begin raise exception 'owned deferred test failure'; end $$`.execute(
                  db,
                );
                await sql`create constraint trigger krun_test_p15_deferred_fail after insert on deliveries deferrable initially deferred for each row execute function krun_test_p15_deferred_fail()`.execute(
                  db,
                );
              });
              expect(
                yield* Effect.flip(transition(id(2), "running", "succeeded", null, {})),
              ).toBeInstanceOf(DatabaseError);
              expect((yield* stored(2)).state).toBe("running");
              expect(yield* deliveries()).toHaveLength(1);
              expect(yield* events()).toHaveLength(3);
              yield* Effect.tryPromise({
                try: () => client.query("select 1"),
                catch: () => new Error("Owned notify barrier failed"),
              });
              expect(notifications).toEqual([`${id(1)}:succeeded`]);
            }),
          ),
      );
  });
}
