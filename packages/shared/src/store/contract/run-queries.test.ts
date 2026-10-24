import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, type Scope, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { sql } from "kysely";
import { Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../../runtime/database.js";
import { makeCreateRun } from "../create-run.js";
import { DatabaseError, NotFoundError } from "../errors.js";
import { toRunSummary } from "../mappers.js";
import { migrate } from "../migrations.js";
import type { NewRun, RunFilter, RunSummary, State } from "../model.js";
import { decodeRun } from "../rows.js";
import { runFilterSchema } from "../run-filter.js";
import { listRunsQuery, makeRunQueries } from "../run-queries.js";

let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(
      "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
    )
      .withName(`krun-test-p16-queries-${process.pid}`)
      .withDatabase("krun_test_p16")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Owned queries Postgres fixture failed");
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
      catch: () => new Error("Owned queries fixture query failed"),
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
      catch: () => new Error("Owned queries fixture decode failed"),
    }),
  );
const seedMany = (count: number) =>
  Effect.gen(function* () {
    const at = yield* DateTime.now;
    yield* query((db) =>
      sql`insert into runs(id,request_hash,function_name,input,state,created_by,created_at,result,log_tail,error)
    values ${sql.join(
      Array.from({ length: count }, (_, index) => {
        const n = index + 1;
        const time = DateTime.formatIso(DateTime.addDuration(at, `${Math.floor(n / 5)} seconds`));
        return sql`(${id(n)},${"a".repeat(64)},'function-a',${JSON.stringify({ privateInput: n })},'queued','owner-a',${time},${JSON.stringify({ privateResult: n })},'private log',${JSON.stringify({ source: "function", message: "reported", details: { privateDetails: n } })})`;
      }),
    )}`.execute(db),
    );
  });
for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`run queries contract: ${dialect}`, () => {
    let directory: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p16-queries-"));
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query("drop schema public cascade; create schema public");
        } catch {
          throw new Error("Owned queries schema reset failed");
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

    it.effect("getRun returns current FULL normalized row;missing id is NotFoundError", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const methods = yield* makeRunQueries;
          yield* query((db) =>
            sql`update runs set state='running',result=${JSON.stringify(false)},error=${JSON.stringify({ source: "function", message: "reported", details: { privateDetails: 1 } })},log_tail='private log' where id=${id(1)}`.execute(
              db,
            ),
          );
          const row = yield* methods.getRun(id(1));
          expect(row).toEqual(yield* stored(1));
          expect(row.result).toBe(false);
          expect(row.error?.details).toEqual({ privateDetails: 1 });
          expect(row.input).toEqual({ opaque: { b: 2, a: 1 } });
          const missing = yield* Effect.flip(methods.getRun(id(999)));
          expect(missing).toBeInstanceOf(NotFoundError);
          expect(missing).toMatchObject({ id: id(999) });
        }),
      ),
    );
    it.effect(
      "250 rows paginate100/100/50 in exact descending time/id order with canonical BASIC only",
      () =>
        run(
          Effect.gen(function* () {
            yield* seedMany(250);
            const m = yield* makeRunQueries;
            const pages = [];
            let cursor: string | null = null;
            do {
              const page: { runs: RunSummary[]; next: string | null } = yield* m.listRuns(
                {},
                cursor,
                100,
              );
              pages.push(page);
              cursor = page.next;
            } while (cursor !== null);
            expect(pages.map((p) => p.runs.length)).toEqual([100, 100, 50]);
            const rows = pages.flatMap((p) => p.runs);
            expect(new Set(rows.map((r) => r.name)).size).toBe(250);
            expect(rows.map((r) => r.name)).toEqual(
              Array.from({ length: 250 }, (_, i) => `functions/function-a/runs/${id(250 - i)}`),
            );
            expect(rows[0]).toEqual(toRunSummary(yield* stored(250)));
            for (const row of rows) {
              expect(row).not.toHaveProperty("input");
              expect(row).not.toHaveProperty("result");
              expect(row).not.toHaveProperty("logTail");
              expect(row).not.toHaveProperty("error.details");
              expect(JSON.stringify(row)).not.toContain("private");
            }
            const raw = Buffer.from(pages[0]?.next ?? "", "base64url").toString("utf8");
            expect(raw).toContain(rows[99]?.createTime);
            expect(raw).toContain(id(151));
          }),
        ),
    );
    it.effect(
      "page size defaults on0,caps at200,may change between pages;exact last page has no token",
      () =>
        run(
          Effect.gen(function* () {
            yield* seedMany(250);
            const m = yield* makeRunQueries;
            const first = yield* m.listRuns({}, null, 0);
            expect(first.runs).toHaveLength(50);
            const second = yield* m.listRuns({}, first.next, 500);
            expect(second.runs).toHaveLength(200);
            expect(second.next).toBeNull();
            expect((yield* m.listRuns({}, null, 500)).runs).toHaveLength(200);
            for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
              expect(yield* Effect.flip(m.listRuns({}, null, limit))).toBeInstanceOf(DatabaseError);
          }),
        ),
    );
    it.effect("owner/function scope and cursor binding prevent cross-scope reuse", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          yield* seed(2);
          yield* seed(3, { created_by: "owner-b" });
          yield* seed(4, { function_name: "function-b" });
          const m = yield* makeRunQueries;
          const filter = { function_name: "function-a", created_by: "owner-a" };
          const first = yield* m.listRuns(filter, null, 1);
          expect(first.runs.map((r) => r.name)).toEqual([`functions/function-a/runs/${id(2)}`]);
          expect((yield* m.listRuns(filter, first.next, 100)).runs.map((r) => r.name)).toEqual([
            `functions/function-a/runs/${id(1)}`,
          ]);
          for (const changed of [
            { ...filter, created_by: "owner-b" },
            { ...filter, function_name: "function-b" },
            {
              ...filter,
              terms: [
                { field: "state" as const, operator: "=" as const, value: "running" as const },
              ],
            },
          ])
            expect(yield* Effect.flip(m.listRuns(changed, first.next, 1))).toBeInstanceOf(
              DatabaseError,
            );
          expect((yield* m.listRuns({ created_by: "owner-a" }, null, 100)).runs).toHaveLength(3);
          expect((yield* m.listRuns({ created_by: "' OR 1=1 --" }, null, 100)).runs).toEqual([]);
        }),
      ),
    );
    it.effect("all filter operators compose with AND and normalized RFC3339 boundaries", () =>
      run(
        Effect.gen(function* () {
          for (let n = 1; n <= 4; n++) {
            yield* seed(n, {}, n <= 2 ? "failed" : n === 3 ? "running" : "succeeded");
            yield* query((db) =>
              sql`update runs set created_at=${`2026-10-24T00:00:0${n}.000Z`},failure_reason=${n <= 2 ? "job_lost" : null} where id=${id(n)}`.execute(
                db,
              ),
            );
          }
          const m = yield* makeRunQueries;
          const cases: [string, number[]][] = [
            ["state = FAILED", [2, 1]],
            ["state != FAILED", [4, 3]],
            ["failureReason = JOB_LOST", [2, 1]],
            ['state != SUCCEEDED AND createTime >= "2026-10-24T00:00:02Z"', [3, 2]],
            ['createTime > "2026-10-24T00:00:02Z"', [4, 3]],
            ['createTime <= "2026-10-24T00:00:02Z"', [2, 1]],
            ['createTime < "2026-10-24T00:00:02Z"', [1]],
            ['createTime >= "2026-10-24T03:00:02+03:00" AND failureReason = JOB_LOST', [2]],
          ];
          for (const [expression, expected] of cases) {
            const filter = runFilterSchema.parse(expression);
            expect(
              (yield* m.listRuns(filter, null, 100)).runs.map((r) => r.name.split("/").at(-1)),
            ).toEqual(expected.map(id));
          }
          expect(
            (yield* m.listRuns(
              runFilterSchema.parse("state = RUNNING AND state = FAILED"),
              null,
              100,
            )).runs,
          ).toEqual([]);
        }),
      ),
    );
    it.effect(
      "P16-C1 accepted fractional RFC3339 comparisons match an independent integer oracle",
      () =>
        run(
          Effect.gen(function* () {
            const m = yield* makeRunQueries;
            const bases = [
              "2026-10-24T00:00:00.000Z",
              "1969-12-31T23:59:59.000Z",
              "9999-12-31T23:59:59.000Z",
            ];
            const fractions = [
              "000000000",
              "000100000",
              "000500000",
              "000900000",
              "001000000",
              "001500000",
              "0000000000001",
              "9999999999999",
            ];
            for (const [baseIndex, baseText] of bases.entries()) {
              const base = DateTime.toEpochMillis(DateTime.makeUnsafe(baseText));
              const fn = `fraction-${baseIndex}`;
              for (let n = 0; n < 4; n++)
                yield* seed(baseIndex * 10 + n + 1, {
                  function_name: fn,
                  created_at: DateTime.makeUnsafe(base + n),
                });
              const second = baseText.slice(0, 19);
              for (const fraction of fractions)
                for (const op of [">=", "<", ">", "<="] as const) {
                  const expression = `createTime ${op} "${second}.${fraction}Z"`;
                  const parsed = runFilterSchema.parse(expression);
                  const actual = (yield* m.listRuns(
                    { ...parsed, function_name: fn },
                    null,
                    100,
                  )).runs.map((row) => row.name.split("/").at(-1));
                  const denominator = 10n ** BigInt(fraction.length);
                  const threshold = BigInt(fraction) * 1000n;
                  const expected = [3, 2, 1, 0]
                    .filter((n) => {
                      const value = BigInt(n) * denominator;
                      return op === ">="
                        ? value >= threshold
                        : op === "<"
                          ? value < threshold
                          : op === ">"
                            ? value > threshold
                            : value <= threshold;
                    })
                    .map((n) => id(baseIndex * 10 + n + 1));
                  expect(actual, expression).toEqual(expected);
                }
            }
          }),
        ),
    );
    it.effect(
      "P16-C1 distinct effective fractional filters cannot reuse each other's cursors",
      () =>
        run(
          Effect.gen(function* () {
            for (let n = 0; n < 4; n++)
              yield* seed(n + 1, {
                created_at: DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + n),
              });
            const m = yield* makeRunQueries;
            const fractional = runFilterSchema.parse(
              'createTime >= "2026-10-24T03:00:00.000100000+03:00"',
            );
            const aligned = runFilterSchema.parse('createTime >= "2026-10-24T00:00:00.000000000Z"');
            const first = yield* m.listRuns(fractional, null, 1);
            expect(first.next).not.toBeNull();
            expect(yield* Effect.flip(m.listRuns(aligned, first.next, 1))).toBeInstanceOf(
              DatabaseError,
            );
            expect(
              (yield* m.listRuns(fractional, first.next, 100)).runs.map((row) =>
                row.name.split("/").at(-1),
              ),
            ).toEqual([id(3), id(2)]);
            const equivalent = runFilterSchema.parse(
              'createTime >= "2026-10-24T00:00:00.000100000Z"',
            );
            expect(
              (yield* m.listRuns(equivalent, first.next, 100)).runs.map((row) =>
                row.name.split("/").at(-1),
              ),
            ).toEqual([id(3), id(2)]);
          }),
        ),
    );
    it.effect(
      "malformed,cross-filter or noncanonical tokens fail without empty-success fallback",
      () =>
        run(
          Effect.gen(function* () {
            yield* seedMany(5);
            const m = yield* makeRunQueries;
            const page = yield* m.listRuns({}, null, 2);
            const token = page.next ?? "";
            for (const bad of [
              "",
              "%%%%",
              `${token}=`,
              Buffer.from("bad|id|hash").toString("base64url"),
              Buffer.from(
                Buffer.from(token, "base64url").toString("utf8").replace(id(4), "not-a-uuid"),
              ).toString("base64url"),
            ])
              expect(yield* Effect.flip(m.listRuns({}, bad, 2))).toBeInstanceOf(DatabaseError);
            expect((yield* m.listRuns({}, token, 2)).runs).toHaveLength(2);
          }),
        ),
    );
    it.effect("BASIC list never fetches FULL-only columns;malformed FULL data is not decoded", () =>
      run(
        Effect.gen(function* () {
          yield* seed(1);
          const m = yield* makeRunQueries;
          yield* query((db) =>
            sql`update runs set input=${JSON.stringify([])} where id=${id(1)}`.execute(db),
          );
          expect(yield* Effect.flip(m.getRun(id(1)))).toBeInstanceOf(DatabaseError);
          const rows = yield* m.listRuns({}, null, 50);
          expect(rows.runs).toHaveLength(1);
          expect(rows.runs[0]).not.toHaveProperty("input");
          const { db } = yield* Database;
          const compiled = listRunsQuery({}, null, 50).compile(db);
          expect(compiled.sql).not.toMatch(/\b(input|result|log_tail)\b/);
        }),
      ),
    );
    it.effect(
      "stable keyset pagination ignores later inserts above the cursor and tolerates deletion",
      () =>
        run(
          Effect.gen(function* () {
            yield* seedMany(6);
            const m = yield* makeRunQueries;
            const first = yield* m.listRuns({}, null, 2);
            yield* seed(99, { created_at: DateTime.addDuration(yield* DateTime.now, "1 hour") });
            yield* query((db) => sql`delete from runs where id=${id(4)}`.execute(db));
            expect(
              (yield* m.listRuns({}, first.next, 50)).runs.map((r) => r.name.split("/").at(-1)),
            ).toEqual([3, 2, 1].map(id));
          }),
        ),
    );
    it.effect(
      "database failures remain sanitized and both methods have redacted client spans",
      () =>
        run(
          Effect.gen(function* () {
            yield* seed(1);
            const m = yield* makeRunQueries;
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
              yield* m.getRun(id(1));
              yield* m.listRuns({}, null, 1);
              yield* Effect.flip(m.getRun(id(999)));
              yield* query((db) =>
                (dialect === "postgres"
                  ? sql`drop table runs cascade`
                  : sql`drop table runs`
                ).execute(db),
              );
              for (const call of [
                m.getRun(id(1)).pipe(Effect.asVoid),
                m.listRuns({}, null, 1).pipe(Effect.asVoid),
              ]) {
                const error = yield* Effect.flip(call);
                expect(error).toBeInstanceOf(DatabaseError);
                expect(Object.keys(error).sort()).toEqual(["_tag", "operation"]);
              }
            }).pipe(Effect.withTracer(tracer));
            expect(spans).toHaveLength(5);
            for (const span of spans) {
              expect(span.kind).toBe("client");
              expect(span.status._tag).toBe("Ended");
              expect(
                [...span.attributes.keys()].every((k) =>
                  ["db.operation.name", "db.response.returned_rows", "krun.run_id"].includes(k),
                ),
              ).toBe(true);
            }
            expect(spans.map((s) => s.attributes.get("db.response.returned_rows"))).toEqual([
              1, 1, 0, 0, 0,
            ]);
          }),
        ),
    );
    if (dialect === "postgres")
      it.effect("actual unfiltered admin query planner names runs_created_idx", () =>
        run(
          Effect.gen(function* () {
            yield* seedMany(250);
            const plan = yield* query(async (db) => {
              await sql`analyze runs`.execute(db);
              return db.transaction().execute(async (tx) => {
                await sql`set local enable_seqscan=off`.execute(tx);
                return (await sql`explain ${listRunsQuery({}, null, 50)}`.execute(tx)).rows
                  .map((r) => (r as { "QUERY PLAN": string })["QUERY PLAN"])
                  .join("\n");
              });
            });
            expect(plan).toContain("runs_created_idx");
          }),
        ),
      );
  });
}
describe("public run filter grammar", () => {
  for (const expression of [
    "state = running",
    "state = STATE_UNSPECIFIED",
    "state > RUNNING",
    "failureReason != JOB_LOST",
    "input = 1",
    "state = RUNNING OR state = FAILED",
    'createTime = "2026-10-24T00:00:00Z"',
    "createTime > 2026-10-24T00:00:00Z",
    'createTime > "not-a-time"',
    "state = RUNNING AND",
    "AND state = RUNNING",
    "state = RUNNING; delete from runs",
  ])
    it(`rejects ${expression}`, () => {
      expect(runFilterSchema.safeParse(expression).success).toBe(false);
    });
  it("accepts empty filters and normalizes closed enums into existing RunFilter terms", () => {
    expect(runFilterSchema.parse("  ")).toEqual({ terms: [] });
    const filter: RunFilter = runFilterSchema.parse("state = RUNNING AND failureReason = JOB_LOST");
    expect(filter.terms).toEqual([
      { field: "state", operator: "=", value: "running" },
      { field: "failureReason", operator: "=", value: "job_lost" },
    ]);
  });
});
