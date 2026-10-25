import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { sql } from "kysely";
import { Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { DatabaseError } from "../errors.js";
import { Store } from "../index.js";
import { StoreLive } from "../live.js";
import { failureReasons, type Run } from "../model.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn = "";
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-repair-p111-reasons-${process.pid}`)
      .withDatabase("krun_repair_p111")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned review fixture startup failed");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);
const base = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(base) + ms);
const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({ try: () => f(db), catch: () => new Error("Owned review query failed") }),
  );
const seed = (n: number, start: number, fn = "review") =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* TestClock.setTime(DateTime.toEpochMillis(at(start)));
    yield* store.createRun({
      id: id(n),
      idempotency_key: null,
      request_hash: "a".repeat(64),
      function_name: fn,
      input: {},
      priority: 0,
      callback_url: "https://callback.invalid/review",
      created_by: "review",
      created_at: base,
    });
    yield* store.setJobToken(id(n), "review-job", "b".repeat(64));
    expect(yield* store.markScheduled(id(n))).toBe(true);
    expect(yield* store.transition(id(n), "scheduled", "running", null, {})).toBe(true);
  });
for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`failed classification contract: ${dialect}`, () => {
    let directory = "";
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-repair-p111-reasons-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned review reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const layer = () =>
      dialect === "sqlite" ? DatabaseSqlite(join(directory, "runs.db")) : DatabasePostgres(dsn);
    for (const mode of ["omitted", "null", "mismatched"] as const) {
      it.effect(`does not commit an invalid FAILED row/event reason pair: ${mode}`, () =>
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          yield* seed(1, 0);
          const patch: Partial<Run> = {
            error: { source: "krun", message: "review" },
            ...(mode === "null"
              ? { failure_reason: null }
              : mode === "mismatched"
                ? { failure_reason: "heartbeat_timeout" as const }
                : {}),
          };
          const eventReason = mode === "mismatched" ? "job_lost" : "heartbeat_timeout";
          const outcome = yield* Effect.exit(
            store.transition(id(1), "running", "failed", eventReason, patch),
          );
          const row = yield* store.getRun(id(1));
          const events = yield* query(
            async (db) =>
              (
                await sql<{
                  reason: string | null;
                }>`select reason from run_events where run_id=${id(1)} order by at`.execute(db)
              ).rows,
          );
          const terminal = yield* query(
            async (db) =>
              (
                await sql<{
                  reason: string | null;
                }>`select reason from run_events where run_id=${id(1)} and to_state='failed'`.execute(
                  db,
                )
              ).rows,
          );
          const deliveries = yield* store.claimDeliveries(at(100), 10);
          expect(outcome._tag).toBe(mode === "mismatched" ? "Failure" : "Success");
          if (outcome._tag === "Failure") {
            expect(row.state).toBe("running");
            expect(events).toHaveLength(3);
            expect(deliveries).toHaveLength(0);
          } else {
            expect(outcome.value).toBe(true);
            expect(row.state).toBe("failed");
            expect(failureReasons).toContain(row.failure_reason);
            expect(terminal).toHaveLength(1);
            expect(terminal[0]?.reason).toBe(row.failure_reason);
            expect(deliveries[0]?.payload.failureReason).toBe(row.failure_reason?.toUpperCase());
          }
        }).pipe(Effect.provide(StoreLive), Effect.provide(layer())),
      );
    }
    it.effect(
      "derives a patch-only classification, preserves FUNCTION error and treats invalid stale CAS as false",
      () =>
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          yield* seed(1, 0);
          yield* store.setError(id(1), {
            source: "function",
            message: "preferred",
            details: { private: true },
          });
          expect(
            yield* store.transition(id(1), "running", "failed", null, {
              failure_reason: "exit_code",
              error: { source: "krun", message: "fallback" },
            }),
          ).toBe(true);
          const before = yield* store.getRun(id(1));
          expect(before.failure_reason).toBe("exit_code");
          expect(before.error?.source).toBe("function");
          expect(
            yield* query(
              async (db) =>
                (await sql`select reason from run_events where to_state='failed'`.execute(db)).rows,
            ),
          ).toEqual([{ reason: "exit_code" }]);
          expect(yield* store.transition(id(1), "running", "failed", null, {})).toBe(false);
          expect(
            yield* store.transition(id(99), "running", "failed", "bad-classification", {}),
          ).toBe(false);
          expect(yield* store.getRun(id(1))).toEqual(before);
          const deliveries = yield* store.claimDeliveries(at(100), 10);
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0]?.payload.failureReason).toBe("EXIT_CODE");
          expect(deliveries[0]?.payload.error?.source).toBe("FUNCTION");
          expect(deliveries[0]?.payload.error).not.toHaveProperty("details");
        }).pipe(Effect.provide(StoreLive), Effect.provide(layer())),
    );
    it.effect(
      "missing, unknown and contradictory classifications reject atomically with declared sanitized error",
      () =>
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          const cases: readonly [string | null, Partial<Run>][] = [
            [null, {}],
            [null, { failure_reason: null }],
            ["unsupported", {}],
            ["unsupported", { failure_reason: "exit_code" }],
            ["job_lost", { failure_reason: "heartbeat_timeout" }],
          ];
          for (const [i, [reason, patch]] of cases.entries()) {
            yield* seed(i + 1, 0);
            const before = yield* store.getRun(id(i + 1));
            const history = yield* query(
              async (db) => (await sql`select * from run_events`.execute(db)).rows,
            );
            const error = yield* Effect.flip(
              store.transition(id(i + 1), "running", "failed", reason, patch),
            );
            expect(error).toBeInstanceOf(DatabaseError);
            expect(error.operation).toBe("transition");
            expect(JSON.stringify(error)).not.toMatch(/unsupported|heartbeat_timeout|job_lost/);
            expect(yield* store.getRun(id(i + 1))).toEqual(before);
            expect(
              yield* query(async (db) => (await sql`select * from run_events`.execute(db)).rows),
            ).toEqual(history);
            expect(yield* store.claimDeliveries(at(100), 10)).toEqual([]);
          }
        }).pipe(Effect.provide(StoreLive), Effect.provide(layer())),
    );
    it.effect("matches an independent millisecond staleness oracle through assembled Store", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.migrate();
        const cases = [
          [0, null],
          [4, null],
          [5, null],
          [6, null],
          [4, 5],
          [5, 4],
          [4, 6],
          [6, 4],
          [5, 5],
        ] as const;
        for (const [n, [start, status]] of cases.entries()) {
          yield* seed(n + 1, start);
          if (status !== null)
            yield* store.setRuntimeStatus(id(n + 1), { message: "review", at: at(status) });
        }
        yield* seed(20, 0, "other");
        const outcomes = [];
        for (const cutoff of [0, 4, 5, 6, 7]) {
          const expected = cases
            .flatMap(([start, status], n) =>
              Math.max(start, status ?? start) < cutoff ? [id(n + 1)] : [],
            )
            .sort();
          const actual = (yield* store.listStale("review", at(cutoff))).map((r) => r.id).sort();
          expect(actual).toEqual(expected);
          outcomes.push({ cutoff, ids: actual });
        }
      }).pipe(Effect.provide(StoreLive), Effect.provide(layer())),
    );
  });
}
