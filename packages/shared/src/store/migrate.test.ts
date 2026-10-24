import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect } from "effect";
import { type Kysely, sql } from "kysely";
import { Pool } from "pg";
import { Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "../runtime/database.js";

const dispatcher = fileURLToPath(new URL("../../../../bin/krun.js", import.meta.url));
const image = "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6";
let container: StartedPostgreSqlContainer | undefined;
let dsn: string;
beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer(image)
      .withName(`krun-test-p12-migrations-${process.pid}`)
      .withDatabase("krun_test_p12")
      .withPassword(randomBytes(32).toString("hex"))
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    dsn = container.getConnectionUri();
  } catch {
    throw new Error("Disposable Postgres migration fixture could not start");
  }
}, 120_000);
afterAll(async () => {
  await container?.stop();
}, 120_000);

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`real migrate CLI: ${dialect}`, () => {
    let directory: string;
    let path: string;
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "krun-test-p12-cli-"));
      path = join(directory, "krun.db");
      if (dialect === "postgres") {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        try {
          await pool.query(
            "drop schema public cascade; create schema public; drop schema if exists unrelated cascade",
          );
        } catch {
          throw new Error("Disposable migration schema reset failed");
        } finally {
          await pool.end();
        }
      }
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const useDatabase = <A, E>(program: Effect.Effect<A, E, Database>) =>
      program.pipe(
        Effect.provide(dialect === "sqlite" ? DatabaseSqlite(path) : DatabasePostgres(dsn)),
      );
    const query = <A>(run: (db: Kysely<unknown>) => Promise<A>) =>
      Effect.flatMap(Database, ({ db }) =>
        Effect.tryPromise({
          try: () => run(db),
          catch: () => new Error("Migration fixture query failed"),
        }),
      );
    const cli = (extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [dispatcher, "migrate"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          KRUN_DB_MODE: dialect === "sqlite" ? "embedded" : "postgres",
          KRUN_DB_PATH: path,
          KRUN_DB_DSN: dialect === "postgres" ? dsn : "",
          KRUN_NAMESPACE: "",
          KRUN_LOG_LEVEL: "invalid-unused",
          ...extra,
        },
      });
    const history = query(
      async (db) =>
        (
          await sql<{
            name: string;
            timestamp: string;
          }>`select * from kysely_migration order by name`.execute(db)
        ).rows,
    );
    const unknown = query((db) =>
      sql`insert into kysely_migration (name, timestamp) values (${"9999_future"}, ${"2026-10-24T00:00:00.000Z"})`.execute(
        db,
      ),
    );

    it.effect("migrates twice idempotently with only DB configuration", () =>
      useDatabase(
        Effect.gen(function* () {
          const first = cli();
          expect(first.error).toBeUndefined();
          expect(first.status).toBe(0);
          expect(first.stdout.trim()).not.toBe("migrate");
          const before = yield* history;
          expect(before.map((row) => row.name)).toEqual(["0001_init"]);
          expect(cli().status).toBe(0);
          expect(yield* history).toEqual(before);
          const tables = yield* query((db) => db.introspection.getTables());
          expect(
            Object.fromEntries(tables.map((table) => [table.name, table.columns.length])),
          ).toEqual({ runs: 25, run_events: 6, deliveries: 9 });
        }),
      ),
    );

    it.effect("warns and exits zero for unknown history without pending migrations", () =>
      useDatabase(
        Effect.gen(function* () {
          expect(cli().status).toBe(0);
          yield* unknown;
          const before = yield* history;
          const result = cli();
          expect(result.status).toBe(0);
          expect(`${result.stdout}${result.stderr}`).toMatch(/unknown migrations/i);
          expect(yield* history).toEqual(before);
        }),
      ),
    );

    it.effect("exits one for unknown plus pending and changes no schema/history", () =>
      useDatabase(
        Effect.gen(function* () {
          yield* query(async (db) => {
            await sql`create table kysely_migration (name varchar(255) primary key not null, timestamp varchar(255) not null)`.execute(
              db,
            );
          });
          yield* unknown;
          const before = yield* history;
          const result = cli();
          expect(result.status).toBe(1);
          expect(`${result.stdout}${result.stderr}`).toMatch(
            /unknown migrations.*pending migrations/i,
          );
          expect(yield* history).toEqual(before);
          expect(yield* query((db) => db.introspection.getTables())).toEqual([]);
        }),
      ),
    );

    it.effect("rolls back failed DDL and emits no raw driver/configuration values", () =>
      useDatabase(
        Effect.gen(function* () {
          yield* query((db) => sql`create table deliveries (sentinel text)`.execute(db));
          const result = cli();
          expect(result.status).toBe(1);
          const output = `${result.stdout}${result.stderr}`;
          expect(output).toContain("Database operation failed");
          expect(output.includes("sentinel")).toBe(false);
          expect(output.includes(dsn)).toBe(false);
          expect(
            (yield* query((db) => db.introspection.getTables())).map((table) => table.name),
          ).toEqual(["deliveries"]);
          expect(yield* history).toEqual([]);
        }),
      ),
    );

    it.effect("releases the scoped database before returning to its caller", () =>
      Effect.gen(function* () {
        const db = yield* useDatabase(Effect.map(Database, (value) => value.db));
        const closed = yield* Effect.promise(() =>
          sql`select 1`.execute(db).then(
            () => false,
            () => true,
          ),
        );
        expect(closed).toBe(true);
      }),
    );

    if (dialect === "postgres") {
      it("sanitizes Postgres acquisition failures", () => {
        const invalid = new URL(dsn);
        invalid.pathname = "/krun_test_missing_database";
        const result = cli({ KRUN_DB_DSN: invalid.toString() });
        expect(result.status).toBe(1);
        const output = `${result.stdout}${result.stderr}`;
        expect(output).toContain("Database operation failed");
        expect(output.includes(invalid.toString())).toBe(false);
        expect(output.includes("krun_test_missing_database")).toBe(false);
      });
      it.effect("ignores unrelated-schema history and qualifies its own bookkeeping", () =>
        useDatabase(
          Effect.gen(function* () {
            yield* query(async (db) => {
              await sql`create schema unrelated`.execute(db);
              await sql`create table unrelated.kysely_migration (name text, timestamp text)`.execute(
                db,
              );
            });
            expect(cli().status).toBe(0);
            expect((yield* history).map((row) => row.name)).toEqual(["0001_init"]);
          }),
        ),
      );
    }
  });
}

it.each([
  ["--help", 0],
  ["--rollback", 1],
] as const)("handles migrate argument %s without opening a database", (argument, status) => {
  const result = spawnSync(process.execPath, [dispatcher, "migrate", argument], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  expect(result.status).toBe(status);
  expect(`${result.stdout}${result.stderr}`).toContain("Usage: krun migrate");
  expect(`${result.stdout}${result.stderr}`).not.toContain("KRUN_DB_DSN");
});

it("rejects missing postgres configuration without acquiring namespace credentials", () => {
  const result = spawnSync(process.execPath, [dispatcher, "migrate"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, KRUN_DB_MODE: "postgres", KRUN_DB_DSN: "", KRUN_NAMESPACE: "" },
  });
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain("KRUN_DB_DSN");
  expect(`${result.stdout}${result.stderr}`).not.toContain("KRUN_NAMESPACE");
});
