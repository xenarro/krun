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
import { toRun, toRunSummary } from "../mappers.js";
import { migrate } from "../migrations.js";
import type { JobStatus, Run, State } from "../model.js";
import { decodeRun } from "../rows.js";
import { makeRunReports } from "../run-reports.js";
import { makeTransition } from "../transition.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p110-reports-${process.pid}`)
      .withDatabase("krun_test_p110")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned report Postgres fixture failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({ try: () => f(db), catch: () => new Error("Owned report query failed") }),
  );
const seed = (n: number, state: State = "running", token = false) =>
  Effect.gen(function* () {
    const create = yield* makeCreateRun;
    yield* create({
      id: id(n),
      idempotency_key: null,
      request_hash: "a".repeat(64),
      function_name: "function-a",
      input: { opaque: { b: 2, a: 1 } },
      priority: 0,
      callback_url: "https://callback.invalid/reports",
      created_by: "owner-a",
      created_at: yield* DateTime.now,
    });
    yield* query((db) =>
      sql`update runs set state=${state},job_token_hash=${token ? "fixture-hash" : null} where id=${id(n)}`.execute(
        db,
      ),
    );
  });
const stored = (n: number) =>
  Effect.flatMap(Database, ({ db, dialect }) =>
    Effect.tryPromise({
      try: async () =>
        decodeRun((await sql`select * from runs where id=${id(n)}`.execute(db)).rows[0], dialect),
      catch: () => new Error("Owned report decode failed"),
    }),
  );
const events = () =>
  query(
    async (db) => (await sql<Record<string, unknown>>`select * from run_events`.execute(db)).rows,
  );
const deliveries = () =>
  query(
    async (db) => (await sql<Record<string, unknown>>`select * from deliveries`.execute(db)).rows,
  );
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const immutable = (row: Run) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !["runtime_status", "result", "error", "job_status"].includes(key),
    ),
  );
const listener = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const client = new Client({ connectionString: dsn, query_timeout: 10000 });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.query("listen krun_runs");
        return client;
      } catch {
        await client.end();
        throw new Error("Owned report listener failed");
      }
    },
    catch: () => new Error("Owned report listener failed"),
  }),
  (client) => Effect.promise(() => client.end()),
);
// A committed marker shares PostgreSQL's ordered notification queue. Waiting for
// it proves absence of earlier notifications without a real sleep/timer race.
const notifyBarrier = (client: Client) =>
  Effect.gen(function* () {
    let resolve: () => void = () => {};
    const delivered = new Promise<void>((done) => {
      resolve = done;
    });
    const onMessage = (message: { payload?: string | undefined }) => {
      if (message.payload === "krun-test-p110:barrier") resolve();
    };
    client.on("notification", onMessage);
    yield* query((db) => sql`select pg_notify('krun_runs','krun-test-p110:barrier')`.execute(db));
    yield* Effect.promise(() => delivered).pipe(
      Effect.ensuring(Effect.sync(() => client.off("notification", onMessage))),
    );
  });

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`report contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p110-reports-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned report reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const run = <A, E>(program: Effect.Effect<A, E, Database | Scope.Scope>) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-25T00:00:00.000Z")),
        );
        yield* migrate;
        return yield* program;
      }).pipe(
        Effect.provide(
          dialect === "sqlite" ? DatabaseSqlite(join(directory, "runs.db")) : DatabasePostgres(dsn),
        ),
      );
    for (const [state, token] of [
      ["queued", false],
      ["queued", true],
      ["scheduled", false],
      ["running", false],
      ["cancelling", true],
      ["succeeded", true],
      ["failed", true],
      ["cancelled", true],
    ] as const) {
      it.effect(`enforces every writer state predicate in ${state}, token ${token}`, () =>
        run(
          Effect.gen(function* () {
            yield* seed(1, state, token);
            const before = yield* stored(1);
            const reports = yield* makeRunReports;
            const at = yield* DateTime.now;
            const reportAllowed =
              state === "scheduled" || state === "running" || (state === "queued" && token);
            const jobAllowed =
              state === "scheduled" || state === "running" || state === "cancelling";
            const runtime = { message: "progress", progress: 0, at };
            const error = { source: "function" as const, message: "failure" };
            const job = { phase: "Running", observedAt: at };
            expect(yield* reports.setRuntimeStatus(id(1), runtime)).toBe(reportAllowed);
            expect(yield* reports.setResult(id(1), false)).toBe(reportAllowed);
            expect(yield* reports.setError(id(1), error)).toBe(reportAllowed);
            expect(yield* reports.setJobStatus(id(1), job)).toBe(jobAllowed);
            const row = yield* stored(1);
            expect(row.runtime_status).toEqual(reportAllowed ? runtime : null);
            expect(row.result).toBe(reportAllowed ? false : null);
            expect(row.error).toEqual(reportAllowed ? error : null);
            expect(row.job_status).toEqual(jobAllowed ? job : null);
            expect(immutable(row)).toEqual(immutable(before));
            expect(yield* events()).toHaveLength(jobAllowed ? 2 : 1);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
      );
    }
    it.effect("missing ids are stale for all four writers and leave no history", () =>
      run(
        Effect.gen(function* () {
          const reports = yield* makeRunReports;
          const at = yield* DateTime.now;
          expect(yield* reports.setRuntimeStatus(id(1), { message: "missing", at })).toBe(false);
          expect(yield* reports.setResult(id(1), 0)).toBe(false);
          expect(yield* reports.setError(id(1), { source: "function", message: "missing" })).toBe(
            false,
          );
          expect(yield* reports.setJobStatus(id(1), { observedAt: at })).toBe(false);
          expect(yield* events()).toEqual([]);
          expect(yield* deliveries()).toEqual([]);
        }),
      ),
    );
    it.effect(
      "runtime replacement retains supplied receipt time/opaque data, not history or lifecycle",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const before = yield* stored(1);
            const { setRuntimeStatus } = yield* makeRunReports;
            const at = yield* DateTime.now;
            const data = JSON.parse(
              '{"__proto__":{"kept":1},"constructor":"kept","nested":{"null":null}}',
            );
            expect(
              yield* setRuntimeStatus(id(1), { message: "first", progress: 0, data, at }),
            ).toBe(true);
            expect((yield* stored(1)).runtime_status?.data).toEqual(data);
            yield* TestClock.adjust("2 seconds");
            const latest = { message: "last", at: yield* DateTime.now };
            expect(yield* setRuntimeStatus(id(1), latest)).toBe(true);
            expect(yield* setRuntimeStatus(id(1), latest)).toBe(true);
            const row = yield* stored(1);
            expect(row.runtime_status).toEqual(latest);
            expect(toRun(row).runtimeStatus).toEqual({
              message: "last",
              reportTime: "2026-10-25T00:00:02.000Z",
            });
            expect(immutable(row)).toEqual(immutable(before));
            expect(yield* events()).toHaveLength(1);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
    );
    it.effect(
      "inline results replace earlier JSON including falsy/scalar/array/opaque object values",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const { setResult } = yield* makeRunReports;
            const opaque = JSON.parse(
              '{"__proto__":{"kept":1},"constructor":"kept","items":[false,0,null]}',
            );
            for (const value of [false, 0, "", "scalar", [1, null, { a: 2 }], opaque]) {
              expect(yield* setResult(id(1), value)).toBe(true);
              expect((yield* stored(1)).result).toEqual(value);
            }
            expect(toRun(yield* stored(1)).result).toEqual(opaque);
            expect(yield* events()).toHaveLength(1);
            expect(yield* deliveries()).toEqual([]);
          }),
        ),
    );
    it.effect("non-JSON and null results fail sanitized without modifying an accepted value", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const { setResult } = yield* makeRunReports;
          yield* setResult(id(1), { accepted: 1 });
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          for (const value of [
            null,
            undefined,
            NaN,
            Infinity,
            1n,
            () => "private",
            cyclic,
            { bad: undefined },
          ]) {
            const error = yield* Effect.flip(setResult(id(1), value));
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("setResult");
            expect(JSON.stringify(error)).not.toMatch(/private|accepted|self|bad/);
            expect((yield* stored(1)).result).toEqual({ accepted: 1 });
          }
          expect(yield* events()).toHaveLength(1);
        }),
      ),
    );
    it.effect(
      "function errors replace earlier reports and retain priority in terminal BASIC callback snapshots",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const { setError, setResult } = yield* makeRunReports;
            const transition = yield* makeTransition;
            const details = JSON.parse(
              '{"__proto__":{"kept":1},"nested":{"trace":["private",null]}}',
            );
            expect(
              yield* setError(id(1), { source: "function", message: "first", type: "First" }),
            ).toBe(true);
            expect(yield* setError(id(1), { source: "krun", message: "last", details })).toBe(true);
            expect((yield* stored(1)).error).toEqual({
              source: "function",
              message: "last",
              details,
            });
            expect(yield* setResult(id(1), false)).toBe(true);
            expect(
              yield* transition(id(1), "running", "failed", "exit_code", {
                failure_reason: "exit_code",
                error: { source: "kubernetes", message: "exit" },
              }),
            ).toBe(true);
            const row = yield* stored(1);
            expect(row.error).toEqual({ source: "function", message: "last", details });
            expect(row.failure_reason).toBe("exit_code");
            expect(row.result).toBe(false);
            expect(yield* setError(id(1), { source: "function", message: "late" })).toBe(false);
            expect(yield* setResult(id(1), "late")).toBe(false);
            const all = yield* deliveries();
            expect(all).toHaveLength(1);
            expect(json(all[0]?.payload)).toEqual(toRunSummary(row));
            expect(toRunSummary(row).error).toEqual({ source: "FUNCTION", message: "last" });
          }),
        ),
    );
    it.effect(
      "an accepted error does not itself fail a run that subsequently exits successfully",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const { setError } = yield* makeRunReports;
            yield* setError(id(1), { source: "function", message: "reported" });
            expect((yield* stored(1)).state).toBe("running");
            const transition = yield* makeTransition;
            expect(yield* transition(id(1), "running", "succeeded", null, {})).toBe(true);
            expect((yield* stored(1)).error?.source).toBe("function");
          }),
        ),
    );
    it.effect(
      "job-status CAS ignores key order/observedAt, records each other field addition/removal and exact payload",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const before = yield* stored(1);
            const { setJobStatus } = yield* makeRunReports;
            const observedAt = yield* DateTime.now;
            const first = {
              podName: "pod-a",
              phase: "Running",
              reason: "",
              message: "",
              exitCode: 0,
              observedAt,
            };
            expect(yield* setJobStatus(id(1), first)).toBe(true);
            yield* TestClock.adjust("1 second");
            const later = yield* DateTime.now;
            expect(
              yield* setJobStatus(id(1), {
                observedAt: later,
                exitCode: 0,
                message: "",
                reason: "",
                phase: "Running",
                podName: "pod-a",
              }),
            ).toBe(false);
            expect((yield* stored(1)).job_status).toEqual(first);
            expect(yield* events()).toHaveLength(2);
            const changes: JobStatus[] = [
              { ...first, podName: "pod-b", observedAt: later },
              { ...first, phase: "Failed", observedAt: later },
              { ...first, reason: "Error", observedAt: later },
              { ...first, message: "changed", observedAt: later },
              { ...first, exitCode: 1, observedAt: later },
              { phase: "Running", observedAt: later },
              { observedAt: later },
            ];
            for (const status of changes) expect(yield* setJobStatus(id(1), status)).toBe(true);
            expect(yield* setJobStatus(id(1), { observedAt })).toBe(false);
            const all = yield* events();
            expect(all).toHaveLength(changes.length + 2);
            const latest = all.at(-1);
            expect(latest).toMatchObject({
              from_state: "running",
              to_state: "running",
              reason: "job_status",
            });
            expect(json(latest?.payload)).toEqual({ observedAt: DateTime.formatIso(later) });
            expect(DateTime.formatIso(DateTime.makeUnsafe(latest?.at as string | Date))).toBe(
              DateTime.formatIso(later),
            );
            expect(immutable(yield* stored(1))).toEqual(immutable(before));
            expect(yield* deliveries()).toEqual([]);
            expect(toRun(yield* stored(1)).jobStatus).toEqual({
              observeTime: DateTime.formatIso(later),
            });
          }),
        ),
    );
    it.effect(
      "job-status comparison is semantic for preexisting reordered/spaced JSON and numeric spelling",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const observedAt = yield* DateTime.now;
            const text =
              '{ "exitCode": 1.0, "phase": "Running", "observedAt": "2026-10-25T00:00:00.000Z" }';
            yield* query((db) =>
              sql`update runs set job_status=${text} where id=${id(1)}`.execute(db),
            );
            const { setJobStatus } = yield* makeRunReports;
            expect(
              yield* setJobStatus(id(1), {
                phase: "Running",
                exitCode: 1,
                observedAt: DateTime.addDuration(observedAt, "1 second"),
              }),
            ).toBe(false);
            expect(
              DateTime.formatIso((yield* stored(1)).job_status?.observedAt as DateTime.Utc),
            ).toBe(DateTime.formatIso(observedAt));
            expect(yield* events()).toHaveLength(1);
          }),
        ),
    );
    it.effect("concurrent identical job reports win exactly once inside the database CAS", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const { setJobStatus } = yield* makeRunReports;
          const observedAt = yield* DateTime.now;
          const outcomes = yield* Effect.all(
            Array.from({ length: 16 }, (_, n) =>
              setJobStatus(id(1), {
                phase: "Running",
                observedAt: DateTime.addDuration(observedAt, `${n} millis`),
              }),
            ),
            { concurrency: "unbounded" },
          );
          expect(outcomes.filter(Boolean)).toHaveLength(1);
          expect(yield* events()).toHaveLength(2);
          expect(yield* deliveries()).toEqual([]);
        }),
      ),
    );
    it.effect(
      "terminal-vs-report races never admit reports after terminal CAS or mutate its callback",
      () =>
        run(
          Effect.gen(function* () {
            const reports = yield* makeRunReports;
            const transition = yield* makeTransition;
            const at = yield* DateTime.now;
            for (let n = 1; n <= 8; n++) {
              yield* seed(n);
              const results = yield* Effect.all(
                [
                  reports.setRuntimeStatus(id(n), { message: "racing", at }),
                  reports.setResult(id(n), { n }),
                  reports.setError(id(n), { source: "function", message: "racing" }),
                  reports.setJobStatus(id(n), { phase: "Failed", observedAt: at }),
                  transition(id(n), "running", "failed", "exit_code", {
                    failure_reason: "exit_code",
                    error: { source: "kubernetes", message: "exit" },
                  }),
                ],
                { concurrency: "unbounded" },
              );
              expect(results[4]).toBe(true);
              const row = yield* stored(n);
              expect(row.runtime_status !== null).toBe(results[0]);
              expect(row.result !== null).toBe(results[1]);
              expect(row.error?.source === "function").toBe(results[2]);
              expect(row.job_status !== null).toBe(results[3]);
              const callback = (yield* deliveries()).find((d) => d.run_id === id(n));
              expect(json(callback?.payload)).toEqual(toRunSummary(row));
              expect(yield* reports.setJobStatus(id(n), { phase: "late", observedAt: at })).toBe(
                false,
              );
            }
          }),
        ),
    );
    it.effect("job event failure rolls back status and returns a sanitized typed error", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const { setJobStatus } = yield* makeRunReports;
          yield* query(async (db) => {
            if (dialect === "sqlite") {
              await sql`create trigger krun_test_p110_event_fail before insert on run_events when new.reason='job_status' begin select raise(abort,'private event fixture'); end`.execute(
                db,
              );
            } else {
              await sql`create function krun_test_p110_event_fail() returns trigger language plpgsql as $$ begin raise exception 'private event fixture'; end $$`.execute(
                db,
              );
              await sql`create trigger krun_test_p110_event_fail before insert on run_events for each row when (new.reason='job_status') execute function krun_test_p110_event_fail()`.execute(
                db,
              );
            }
          });
          const before = yield* stored(1);
          const error = yield* Effect.flip(
            setJobStatus(id(1), { phase: "Running", observedAt: yield* DateTime.now }),
          );
          expect(error).toBeInstanceOf(DatabaseError);
          expect(error.operation).toBe("setJobStatus");
          expect(JSON.stringify(error)).not.toContain("private");
          expect(yield* stored(1)).toEqual(before);
          expect(yield* events()).toHaveLength(1);
          expect(yield* deliveries()).toEqual([]);
        }),
      ),
    );
    it.effect("all writer failures are typed and all spans expose only operation/count/id", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const reports = yield* makeRunReports;
          const at = yield* DateTime.now;
          const calls = [
            () => reports.setRuntimeStatus(id(1), { message: "private", at }),
            () => reports.setResult(id(1), { private: 1 }),
            () =>
              reports.setError(id(1), {
                source: "function",
                message: "private",
                details: { private: 1 },
              }),
            () => reports.setJobStatus(id(1), { phase: "private", observedAt: at }),
          ];
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
            for (const call of calls) expect(yield* call()).toBe(true);
            yield* query((db) =>
              sql`update runs set state='cancelled' where id=${id(1)}`.execute(db),
            );
            for (const call of calls) expect(yield* call()).toBe(false);
            yield* query(async (db) => {
              await sql`drop table deliveries`.execute(db);
              await sql`drop table run_events`.execute(db);
              await sql`drop table runs`.execute(db);
            });
            for (const call of calls)
              expect(yield* Effect.flip(call())).toBeInstanceOf(DatabaseError);
          }).pipe(Effect.withTracer(tracer));
          expect(spans).toHaveLength(12);
          expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([
            1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
          ]);
          for (const span of spans) {
            expect(span.name).toMatch(/^store.set(RuntimeStatus|Result|Error|JobStatus)$/);
            expect(span.kind).toBe("client");
            expect(span.status._tag).toBe("Ended");
            expect([...span.attributes.keys()].sort()).toEqual([
              "db.operation.name",
              "db.response.returned_rows",
              "krun.run_id",
            ]);
            expect(span.attributes.get("krun.run_id")).toBe(id(1));
            expect(JSON.stringify([...span.attributes])).not.toMatch(/private|select |update |dsn/);
          }
        }),
      ),
    );
    if (dialect === "postgres") {
      it.effect(
        "runtime/job notifications see committed rows/history; stale and timestamp-only writes never notify",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              const client = yield* listener;
              const notifications: string[] = [];
              client.on("notification", (message) => {
                if (message.payload && !message.payload.endsWith(":barrier"))
                  notifications.push(message.payload);
              });
              const reports = yield* makeRunReports;
              const at = yield* DateTime.now;
              expect(yield* reports.setRuntimeStatus(id(1), { message: "visible", at })).toBe(true);
              yield* notifyBarrier(client);
              expect(notifications).toEqual([`${id(1)}:status`]);
              const visible = yield* Effect.tryPromise({
                try: () =>
                  client.query(
                    "select runtime_status,(select count(*)::int from run_events where run_id=r.id) as events from runs r where id=$1",
                    [id(1)],
                  ),
                catch: () => new Error("Owned report visibility failed"),
              });
              expect(visible.rows[0]).toEqual({
                runtime_status: { message: "visible", at: DateTime.formatIso(at) },
                events: 1,
              });
              expect(yield* reports.setResult(id(1), false)).toBe(true);
              expect(
                yield* reports.setError(id(1), { source: "function", message: "report" }),
              ).toBe(true);
              expect(yield* reports.setJobStatus(id(1), { phase: "Running", observedAt: at })).toBe(
                true,
              );
              yield* notifyBarrier(client);
              expect(notifications).toEqual([`${id(1)}:status`, `${id(1)}:job_status`]);
              expect((yield* stored(1)).job_status?.phase).toBe("Running");
              expect(yield* events()).toHaveLength(2);
              expect(
                yield* reports.setJobStatus(id(1), {
                  phase: "Running",
                  observedAt: DateTime.addDuration(at, "1 second"),
                }),
              ).toBe(false);
              yield* query((db) =>
                sql`update runs set state='cancelled' where id=${id(1)}`.execute(db),
              );
              expect(yield* reports.setRuntimeStatus(id(1), { message: "late", at })).toBe(false);
              expect(yield* reports.setJobStatus(id(1), { phase: "late", observedAt: at })).toBe(
                false,
              );
              yield* notifyBarrier(client);
              expect(notifications).toEqual([`${id(1)}:status`, `${id(1)}:job_status`]);
            }),
          ),
      );
      it.effect(
        "deferred commit failure suppresses both runtime and job notifications and rolls history back",
        () =>
          run(
            Effect.gen(function* () {
              yield* seed(1);
              const client = yield* listener;
              const notifications: string[] = [];
              client.on("notification", (message) => {
                if (message.payload && !message.payload.endsWith(":barrier"))
                  notifications.push(message.payload);
              });
              const reports = yield* makeRunReports;
              yield* query(async (db) => {
                await sql`create function krun_test_p110_commit_fail() returns trigger language plpgsql as $$ begin raise exception 'private deferred fixture'; end $$`.execute(
                  db,
                );
                await sql`create constraint trigger krun_test_p110_commit_fail after update on runs deferrable initially deferred for each row execute function krun_test_p110_commit_fail()`.execute(
                  db,
                );
              });
              const at = yield* DateTime.now;
              expect(
                yield* Effect.flip(reports.setRuntimeStatus(id(1), { message: "rollback", at })),
              ).toBeInstanceOf(DatabaseError);
              expect(
                yield* Effect.flip(
                  reports.setJobStatus(id(1), { phase: "rollback", observedAt: at }),
                ),
              ).toBeInstanceOf(DatabaseError);
              yield* notifyBarrier(client);
              expect(notifications).toEqual([]);
              const row = yield* stored(1);
              expect(row.runtime_status).toBeNull();
              expect(row.job_status).toBeNull();
              expect(yield* events()).toHaveLength(1);
              expect(yield* deliveries()).toEqual([]);
            }),
          ),
      );
    }
  });
}
