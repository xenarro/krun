import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, type Scope } from "effect";
import { sql } from "kysely";
import { Client, Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { ConflictError, DatabaseError } from "../errors.js";
import { migrate } from "../migrations.js";
import type { NewRun } from "../model.js";
import { requestHash } from "../request-hash.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p13-create-${process.pid}`)
      .withDatabase("krun_test_p13")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Disposable createRun fixture failed to start");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);

const fresh = (n: number, changes: Partial<NewRun> = {}) =>
  Effect.gen(function* () {
    const created_at = yield* DateTime.now;
    const input = changes.input ?? { message: "test", nested: { b: 2, a: 1 } };
    const priority = changes.priority ?? 3;
    const callback_url = changes.callback_url ?? null;
    const request_hash = yield* requestHash({
      input,
      priority,
      ...(callback_url === null ? {} : { callback: { url: callback_url } }),
    });
    return {
      id: `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
      idempotency_key: "same-key",
      function_name: "test-function",
      input,
      priority,
      callback_url,
      created_by: "test-owner",
      created_at,
      request_hash,
      ...changes,
    } satisfies NewRun;
  });
const query = <A>(f: (db: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) =>
    Effect.tryPromise({
      try: () => f(db),
      catch: () => new Error("Owned createRun test query failed"),
    }),
  );

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`createRun contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p13-create-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned Postgres schema reset failed");
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
    const counts = query(async (db) => {
      const rows = (await sql`select id from runs`.execute(db)).rows;
      const events = (
        await sql<{
          payload: unknown;
          at: unknown;
          from_state: string | null;
          to_state: string;
        }>`select payload, at, from_state, to_state from run_events`.execute(db)
      ).rows;
      return { rows, events };
    });
    it.effect(
      "API defaults replay and mixed omitted/zero concurrent creates produce one row/event",
      () =>
        run(
          Effect.gen(function* () {
            const create = yield* makeCreateRun;
            const base = yield* fresh(1, { input: {}, priority: 0 });
            const omitted = yield* requestHash({ input: {} });
            const explicit = yield* requestHash({ input: {}, priority: 0 });
            const first = yield* create({ ...base, request_hash: omitted });
            const replay = yield* create({
              ...base,
              id: "0192f000-0000-7000-8000-000000000002",
              request_hash: explicit,
            });
            expect(replay.created).toBe(false);
            expect(replay.run).toEqual(first.run);
            const results = yield* Effect.all(
              Array.from({ length: 20 }, (_, n) =>
                create({
                  ...base,
                  id: `0192f000-0000-7000-8000-${(n + 3).toString(16).padStart(12, "0")}`,
                  idempotency_key: "mixed-default-race",
                  request_hash: n % 2 === 0 ? omitted : explicit,
                }),
              ),
              { concurrency: "unbounded" },
            );
            expect(results.filter((value) => value.created)).toHaveLength(1);
            expect(new Set(results.map((value) => value.run.id)).size).toBe(1);
            const actual = yield* counts;
            expect(actual.rows).toHaveLength(2);
            expect(actual.events).toHaveLength(2);
          }),
        ),
    );
    it.effect("concurrent duplicates produce one row and one actor event", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          const request = yield* fresh(1);
          const results = yield* Effect.all(
            Array.from({ length: 20 }, (_, n) =>
              create({
                ...request,
                id: `0192f000-0000-7000-8000-${(n + 1).toString(16).padStart(12, "0")}`,
              }),
            ),
            { concurrency: "unbounded" },
          );
          expect(results.filter((value) => value.created)).toHaveLength(1);
          expect(new Set(results.map((value) => value.run.id)).size).toBe(1);
          expect(
            results.every(
              (value) =>
                DateTime.formatIso(value.run.created_at) === DateTime.formatIso(request.created_at),
            ),
          ).toBe(true);
          const actual = yield* counts;
          expect(actual.rows).toHaveLength(1);
          expect(actual.events).toHaveLength(1);
          const event = actual.events[0];
          expect(event?.from_state).toBeNull();
          expect(event?.to_state).toBe("queued");
          expect(
            dialect === "sqlite" ? JSON.parse(String(event?.payload)) : event?.payload,
          ).toEqual({ actor: "test-owner" });
          expect(DateTime.formatIso(DateTime.makeUnsafe(event?.at as string))).toBe(
            DateTime.formatIso(request.created_at),
          );
        }),
      ),
    );
    it.effect("reordered nested JSON returns the original normalized run", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          const a = yield* fresh(1, { input: { z: [{ b: 2, a: 1 }], a: "value" } });
          const b = yield* fresh(2, { input: { a: "value", z: [{ a: 1, b: 2 }] } });
          expect(a.request_hash).toBe(b.request_hash);
          const first = yield* create(a);
          const again = yield* create(b);
          expect(again.created).toBe(false);
          expect(again.run).toEqual(first.run);
          expect((yield* counts).events).toHaveLength(1);
        }),
      ),
    );
    it.effect("different input, priority or callback conflicts without extra writes", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          yield* create(yield* fresh(1));
          for (const changes of [
            { input: { changed: true } },
            { priority: 4 },
            { callback_url: "https://callback.example.test/done" },
          ]) {
            expect(yield* Effect.flip(create(yield* fresh(2, changes)))).toBeInstanceOf(
              ConflictError,
            );
          }
          const actual = yield* counts;
          expect(actual.rows).toHaveLength(1);
          expect(actual.events).toHaveLength(1);
        }),
      ),
    );
    it.effect(
      "keys are scoped to owner and function; null never dedupes and empty string does",
      () =>
        run(
          Effect.gen(function* () {
            const create = yield* makeCreateRun;
            for (const [n, changes] of [
              [1, {}],
              [2, { created_by: "other-owner" }],
              [3, { function_name: "other-function" }],
              [4, { idempotency_key: null }],
              [5, { idempotency_key: null }],
              [6, { idempotency_key: "" }],
            ] as const)
              expect((yield* create(yield* fresh(n, changes))).created).toBe(true);
            expect((yield* create(yield* fresh(7, { idempotency_key: "" }))).created).toBe(false);
            const actual = yield* counts;
            expect(actual.rows).toHaveLength(6);
            expect(actual.events).toHaveLength(6);
          }),
        ),
    );
    it.effect("preserves opaque JSON keys and fails closed on a corrupt stored input", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          const input = JSON.parse(
            '{"__proto__":{"opaque":true},"constructor":"data","nested":{"prototype":0}}',
          );
          const request = yield* fresh(1, { input });
          const first = yield* create(request);
          expect(Object.hasOwn(first.run.input, "__proto__")).toBe(true);
          expect(first.run.input).toEqual(input);
          yield* query((db) => sql`update runs set input=${"1"}`.execute(db));
          expect(yield* Effect.flip(create(yield* fresh(2, { input })))).toBeInstanceOf(
            DatabaseError,
          );
          const actual = yield* counts;
          expect(actual.rows).toHaveLength(1);
          expect(actual.events).toHaveLength(1);
        }),
      ),
    );
    it.effect("an event failure rolls back the inserted run and returns a sanitized error", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          yield* query((db) => sql`drop table run_events`.execute(db));
          const error = yield* Effect.flip(create(yield* fresh(1)));
          expect(error).toBeInstanceOf(DatabaseError);
          expect(error.message).toBe("Database operation failed");
          expect((yield* query((db) => sql`select id from runs`.execute(db))).rows).toHaveLength(0);
        }),
      ),
    );
    it.effect("unrelated primary-key conflicts are database errors, not idempotent success", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          const request = yield* fresh(1);
          yield* create(request);
          expect(
            yield* Effect.flip(create({ ...request, idempotency_key: "different-key" })),
          ).toBeInstanceOf(DatabaseError);
          const actual = yield* counts;
          expect(actual.rows).toHaveLength(1);
          expect(actual.events).toHaveLength(1);
        }),
      ),
    );
    it.effect("duplicates return current stored state, JSON and timestamps", () =>
      run(
        Effect.gen(function* () {
          const create = yield* makeCreateRun;
          const request = yield* fresh(1);
          yield* create(request);
          const time = DateTime.formatIso(request.created_at);
          yield* query((db) =>
            sql`update runs set state='running', started_at=${time}, result=${"false"}, runtime_status=${JSON.stringify({ message: "active", at: time })}`.execute(
              db,
            ),
          );
          const result = yield* create(yield* fresh(2));
          expect(result.created).toBe(false);
          expect(result.run.state).toBe("running");
          expect(result.run.result).toBe(false);
          expect(result.run.runtime_status?.message).toBe("active");
          expect(result.run.started_at && DateTime.formatIso(result.run.started_at)).toBe(time);
        }),
      ),
    );
    if (dialect === "postgres")
      it.effect("publishes once after commit, never on duplicate/conflict", () =>
        run(
          Effect.gen(function* () {
            const client = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: async () => {
                  const c = new Client({ connectionString: dsn });
                  await c.connect();
                  return c;
                },
                catch: () => new Error("Owned listener open failed"),
              }),
              (c) => Effect.promise(() => c.end()),
            );
            const notifications: string[] = [];
            let observed: (() => void) | undefined;
            const delivered = new Promise<void>((resolve) => {
              observed = resolve;
            });
            client.on("notification", (message) => {
              notifications.push(message.payload ?? "");
              observed?.();
            });
            yield* Effect.tryPromise({
              try: () => client.query("listen krun_runs"),
              catch: () => new Error("Owned listener failed"),
            });
            const create = yield* makeCreateRun;
            const first = yield* create(yield* fresh(1));
            yield* Effect.promise(() => delivered);
            const visible = yield* counts;
            expect(visible.rows).toHaveLength(1);
            expect(visible.events).toHaveLength(1);
            yield* create(yield* fresh(2));
            yield* Effect.flip(create(yield* fresh(3, { priority: 9 })));
            yield* Effect.tryPromise({
              try: () => client.query("select 1"),
              catch: () => new Error("Owned listener barrier failed"),
            });
            expect(notifications).toEqual([`${first.run.id}:queued`]);
          }),
        ),
      );
  });
}
