import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Database, DatabasePostgres, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, Layer, Schedule } from "effect";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { makeInternalApp } from "./internal-app.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer(
    "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
  )
    .withName(`krun-test-p38-native-${randomBytes(6).toString("hex")}`)
    .withDatabase("krun_test_p38")
    .withPassword(randomBytes(32).toString("hex"))
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}, 120000);
afterAll(async () => {
  await postgres?.stop();
}, 120000);
const fixture = (n: number, maxResultBytes = 64) =>
  Effect.gen(function* () {
    const id = `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
    const store = yield* Store;
    yield* store.migrate();
    const token = randomBytes(32).toString("base64url");
    yield* store.createRun({
      id,
      function_name: "echo",
      input: JSON.parse('{"n":1,"__proto__":{"opaque":true},"nul":"\\u0000"}'),
      priority: 0,
      created_by: "test",
      request_hash: "a".repeat(64),
      idempotency_key: null,
      callback_url: null,
      created_at: yield* DateTime.now,
    });
    yield* store.setJobToken(
      id,
      "krun-test-p38-job",
      createHash("sha256").update(token).digest("hex"),
    );
    const logs: string[] = [];
    const app = yield* makeInternalApp({ maxResultBytes }).pipe(
      Effect.provideService(LogDestination, {
        write: (line) => {
          logs.push(line);
        },
      }),
    );
    const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
    const call = async (op: string, payload?: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${address}/internal/v1/runs/${id}/${op}`, {
        method: op === "input" ? "GET" : op === "status" ? "POST" : "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          ...headers,
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(7000),
      });
      const text = await r.text();
      return {
        code: r.status,
        headers: r.headers,
        text,
        body: text ? JSON.parse(text) : undefined,
      };
    };
    const raw = (
      op: string,
      framing: Record<string, string>,
      chunks: string[],
      auth: string | string[] = token,
    ) =>
      new Promise<{ code: number; headers: import("node:http").IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            `${address}/internal/v1/runs/${id}/${op}`,
            {
              method: op === "status" ? "POST" : "PUT",
              headers: {
                authorization: `Bearer ${auth}`,
                "content-type": "application/json",
                ...framing,
              },
            },
            (res) => {
              let body = "";
              res.on("data", (v) => {
                body += String(v);
              });
              res.once("end", () =>
                resolve({ code: res.statusCode ?? 0, headers: res.headers, body }),
              );
            },
          );
          req.once("error", reject);
          req.setTimeout(7000, () => req.destroy(new Error("Owned native request timed out")));
          req.flushHeaders();
          for (const chunk of chunks) req.write(chunk);
          if (chunks.length) req.end();
        },
      );
    return { id, token, store, app, address, call, raw, logs };
  });
const use = <A, E>(
  dialect: "sqlite" | "postgres",
  program: Effect.Effect<A, E, Store | Database | import("effect").Scope.Scope>,
) =>
  Effect.scoped(program).pipe(
    Effect.provide(
      StoreLive.pipe(
        Layer.provideMerge(
          dialect === "sqlite"
            ? DatabaseSqlite(":memory:")
            : DatabasePostgres(postgres.getConnectionUri()),
        ),
      ),
    ),
  );
for (const [n, dialect] of [
  [1, "sqlite"],
  [2, "postgres"],
] as const)
  it.live(
    `native internal four operations/caps/check-order/JSON/guarded race on real ${dialect}`,
    () =>
      use(
        dialect,
        Effect.gen(function* () {
          const f = yield* fixture(n);
          const input = yield* Effect.promise(() => f.call("input"));
          expect(input.code).toBe(200);
          expect(input.body).toEqual((yield* f.store.getRun(f.id)).input);
          expect(Number(input.headers.get("content-length"))).toBe(Buffer.byteLength(input.text));
          expect(
            (yield* Effect.promise(() =>
              f.call(
                "status",
                '{"message":"started","data":{"__proto__":{"opaque":true},"n":[null]}}',
              ),
            )).code,
          ).toBe(204);
          expect(
            (yield* Effect.promise(() => f.call("status", '{"message":"too soon"}'))).code,
          ).toBe(429);
          for (const result of [
            "false",
            "0",
            '""',
            '{"__proto__":{"opaque":true},"nul":"\\u0000"}',
          ])
            expect((yield* Effect.promise(() => f.call("result", result))).code).toBe(204);
          expect(
            (yield* Effect.promise(() =>
              f.call("error", '{"message":"failed","details":{"__proto__":{"opaque":true}}}'),
            )).code,
          ).toBe(204);
          const row = yield* f.store.getRun(f.id);
          expect(row.state).toBe("queued");
          expect(row.error?.source).toBe("function");
          expect(row.runtime_status?.data).toEqual(
            JSON.parse('{"__proto__":{"opaque":true},"n":[null]}'),
          );
          const headersOnly = yield* Effect.promise(() =>
            f.raw("result", { "content-length": "65" }, []),
          );
          expect(headersOnly.code).toBe(413);
          expect(headersOnly.headers.connection).toBe("close");
          expect(JSON.parse(headersOnly.body).error.details[0].reason).toBe("RESULT_TOO_LARGE");
          const wrong = yield* Effect.promise(() =>
            f.raw(
              "result",
              { "content-length": "65", "content-type": "text/plain" },
              [],
              "invalid",
            ),
          );
          expect(wrong.code).toBe(401);
          const duplicate = yield* Effect.promise(() =>
            f.raw("result", { "content-length": "5" }, ["false"], [f.token, f.token]),
          );
          expect(duplicate.code).toBe(401);
          for (const [op, cap, reason] of [
            ["result", 64, "RESULT_TOO_LARGE"],
            ["status", 16384, "REQUEST_TOO_LARGE"],
            ["error", 32768, "REQUEST_TOO_LARGE"],
          ] as const) {
            const large = yield* Effect.promise(() =>
              f.raw(op, { "transfer-encoding": "chunked" }, [" ".repeat(cap), " "]),
            );
            expect(large.code).toBe(413);
            expect(large.headers.connection).toBe("close");
            expect(JSON.parse(large.body).error.details[0].reason).toBe(reason);
          }
          yield* f.store.transition(f.id, "queued", "cancelling", null, {});
          expect((yield* Effect.promise(() => f.call("result", "false"))).code).toBe(401);
          expect(f.logs.join("")).not.toContain(f.token);
          expect(f.logs.join("")).not.toContain("opaque");
        }),
      ),
    20000,
  );
it.live(
  "native internal PostgreSQL5s deadline cancels blocked UPDATE,rolls back and never commits after503",
  () =>
    use(
      "postgres",
      Effect.gen(function* () {
        const f = yield* fixture(3);
        const query = (sql: string) =>
          Effect.promise(() =>
            postgres.exec([
              "psql",
              "-U",
              postgres.getUsername(),
              "-d",
              "krun_test_p38",
              "-Atc",
              sql,
            ]),
          );
        const release = query(
          "select pg_terminate_backend(pid) from pg_stat_activity where application_name='krun-test-p38-locker' and datname=current_database()",
        );
        const hold = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const pending = postgres.exec([
              "psql",
              "-U",
              postgres.getUsername(),
              "-d",
              "krun_test_p38",
              "-Atc",
              "set application_name='krun-test-p38-locker';begin;lock table runs in share mode;select pg_sleep(30);rollback;",
            ]);
            pending.catch(() => {});
            return pending;
          }),
          () => release.pipe(Effect.asVoid),
        );
        const observe = (sql: string) =>
          query(sql).pipe(
            Effect.flatMap((r) =>
              r.exitCode === 0 && Number(r.output.trim()) > 0
                ? Effect.void
                : Effect.fail(new Error("Owned SQL state pending")),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("3 seconds"),
          );
        yield* observe(
          "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='krun-test-p38-locker' and l.mode='ShareLock' and l.granted",
        );
        const started = performance.now();
        const pending = f.call("result", '{"mustNotCommit":true}');
        pending.catch(() => {});
        yield* observe(
          "select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%update runs set%'",
        );
        const response = yield* Effect.promise(() => pending);
        expect(response.code).toBe(503);
        expect(response.body.error.details[0].reason).toBe("NOT_READY");
        expect(response.headers.get("retry-after")).toBe("1");
        expect(performance.now() - started).toBeLessThan(6000);
        const active = yield* query(
          "select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%update runs set%'",
        );
        expect(active.output.trim()).toBe("0");
        yield* release;
        yield* Effect.promise(() => hold);
        expect((yield* f.store.getRun(f.id)).result).toBeNull();
        expect((yield* Effect.promise(() => f.call("result", "false"))).code).toBe(204);
        expect((yield* f.store.getRun(f.id)).result).toBe(false);
      }),
    ),
  20000,
);
for (const [n, dialect] of [
  [4, "sqlite"],
  [5, "postgres"],
] as const)
  it.live(
    `internal opaque Unicode status/error remains valid on ${dialect}`,
    () =>
      use(
        dialect,
        Effect.gen(function* () {
          const f = yield* fixture(n);
          const status = yield* Effect.promise(() =>
            f.call("status", '{"message":"nul\\u0000","data":{"text":"\\ud800"}}'),
          );
          expect(status.code).toBe(204);
          const error = yield* Effect.promise(() =>
            f.call("error", '{"message":"nul\\u0000","details":{"text":"\\ud800"}}'),
          );
          expect(error.code).toBe(204);
          expect((yield* f.store.getRun(f.id)).runtime_status?.message).toBe("nul\0");
          yield* f.store.markScheduled(f.id);
          yield* f.store.transition(f.id, "scheduled", "running", null, {});
          expect(
            (yield* f.store.listStale(
              "echo",
              DateTime.add(yield* DateTime.now, { seconds: 1 }),
            )).map((row) => row.id),
          ).toContain(f.id);
        }),
      ),
    20000,
  );

it.live(
  "native internal PostgreSQL exhausted pool times out without a late query and recovers",
  () =>
    use(
      "postgres",
      Effect.gen(function* () {
        const f = yield* fixture(6);
        const database = yield* Database;
        const held = Promise.withResolvers<void>();
        const ready = Promise.withResolvers<void>();
        let acquired = 0;
        const pending = Array.from({ length: 5 }, () =>
          database.db.connection().execute(async () => {
            if (++acquired === 5) ready.resolve();
            await held.promise;
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            held.resolve();
            await Promise.all(pending);
          }),
        );
        yield* Effect.promise(() => ready.promise);
        const at = performance.now();
        const response = yield* Effect.promise(() => f.call("input"));
        expect(response.code).toBe(503);
        expect(performance.now() - at).toBeLessThan(6000);
        held.resolve();
        yield* Effect.promise(() => Promise.all(pending));
        expect((yield* Effect.promise(() => f.call("input"))).code).toBe(200);
      }),
    ),
  20000,
);

for (const [n, dialect] of [
  [7, "sqlite"],
  [8, "postgres"],
] as const) {
  it.live(
    `internal rejects nested nonfinite JSON before Store and preserves opaque controls on ${dialect}`,
    () =>
      use(
        dialect,
        Effect.gen(function* () {
          const f = yield* fixture(n);
          for (const [op, field] of [
            ["status", "data"],
            ["error", "details"],
          ] as const) {
            for (const value of ["1e400", "-1e400", '[1,{"n":1e400}]']) {
              const r = yield* Effect.promise(() =>
                f.call(op, `{"message":"valid","${field}":{"n":${value}}}`),
              );
              expect(r.code).toBe(400);
              expect(r.body.error.details[0].reason).toBe("REQUEST_INVALID");
              expect(r.headers.get("retry-after")).toBeNull();
            }
            const r = yield* Effect.promise(() =>
              f.call(
                op,
                `{"message":"valid","${field}":{"__proto__":{"n":null},"constructor":{"prototype":false},"nul":"\\u0000","surrogate":"\\ud800","n":[0,1.5]}}`,
              ),
            );
            expect(r.code).toBe(204);
          }
          const row = yield* f.store.getRun(f.id);
          expect(row.runtime_status?.data).toEqual(row.error?.details);
          expect(Object.hasOwn(row.runtime_status?.data ?? {}, "__proto__")).toBe(true);
          expect((yield* Effect.promise(() => f.call("result", '{"n":1e400}'))).code).toBe(400);
          expect(row.state).toBe("queued");
        }),
      ),
    20000,
  );
  it.live(
    `internal zero/one-byte result caps agree for both native framings on ${dialect}`,
    () =>
      use(
        dialect,
        Effect.gen(function* () {
          for (const cap of [0, 1, 64]) {
            const f = yield* fixture(n * 10 + cap, cap);
            for (const framing of ["content-length", "chunked"]) {
              for (const body of cap === 64
                ? [JSON.stringify("a".repeat(62)), JSON.stringify("a".repeat(63))]
                : ["0", " 0"]) {
                const before = (yield* f.store.getRun(f.id)).result;
                const r = yield* Effect.promise(() =>
                  f.raw(
                    "result",
                    framing === "chunked"
                      ? { "transfer-encoding": "chunked" }
                      : { "content-length": String(Buffer.byteLength(body)) },
                    [body],
                  ),
                );
                expect(r.code).toBe(Buffer.byteLength(body) > cap ? 413 : 204);
                if (r.code === 413) {
                  expect(JSON.parse(r.body).error.details[0].reason).toBe("RESULT_TOO_LARGE");
                  expect(r.headers.connection).toBe("close");
                  expect((yield* f.store.getRun(f.id)).result).toEqual(before);
                }
              }
            }
          }
        }),
      ),
    20000,
  );
}

it.live(
  "internal shutdown destroys unfinished bodies but settles a validated PostgreSQL write before release",
  () =>
    use(
      "postgres",
      Effect.gen(function* () {
        const f = yield* fixture(90);
        const { db } = yield* Database;
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const hold = db.transaction().execute(async (tx) => {
          await tx
            .withTables<{ runs: { id: string } }>()
            .selectFrom("runs")
            .select("id")
            .where("id", "=", f.id)
            .forUpdate()
            .execute();
          locked.resolve();
          await release.promise;
        });
        hold.catch(() => {});
        const clients: ReturnType<typeof httpRequest>[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            release.resolve();
            for (const client of clients) client.destroy();
            await hold;
          }),
        );
        yield* Effect.promise(() => locked.promise);
        let writeDone = false;
        const write = f.call("result", '{"settled":true}').then((r) => {
          writeDone = true;
          return r;
        });
        write.catch(() => {});
        yield* Effect.promise(() =>
          postgres.exec([
            "psql",
            "-U",
            postgres.getUsername(),
            "-d",
            "krun_test_p38",
            "-Atc",
            "select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%update runs set%'",
          ]),
        ).pipe(
          Effect.flatMap((r) =>
            r.exitCode === 0 && Number(r.output.trim()) > 0
              ? Effect.void
              : Effect.fail(new Error("Owned write not blocked yet")),
          ),
          Effect.retry(Schedule.spaced("20 millis")),
          Effect.timeout("3 seconds"),
        );
        const disconnected: Promise<void>[] = [];
        for (const framing of [{ "content-length": "10" }, { "transfer-encoding": "chunked" }]) {
          const arrived = Promise.withResolvers<void>();
          f.app.server.once("request", () => arrived.resolve());
          const client = httpRequest(
            `${f.address}/internal/v1/runs/${f.id}/result`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${f.token}`,
                "content-type": "application/json",
                ...framing,
              },
            },
            (res) => res.resume(),
          );
          clients.push(client);
          client.on("error", () => {});
          disconnected.push(new Promise<void>((resolve) => client.once("close", resolve)));
          client.flushHeaders();
          client.write("{");
          yield* Effect.promise(() => arrived.promise);
        }
        let closeDone = false;
        const started = performance.now();
        const closing = f.app.close().then(() => {
          closeDone = true;
        });
        closing.catch(() => {});
        yield* Effect.promise(() => Promise.all(disconnected)).pipe(Effect.timeout("2 seconds"));
        expect(writeDone).toBe(false);
        expect(closeDone).toBe(false);
        release.resolve();
        yield* Effect.promise(() => hold);
        expect((yield* Effect.promise(() => write)).code).toBe(204);
        yield* Effect.promise(() => closing).pipe(Effect.timeout("6 seconds"));
        expect(performance.now() - started).toBeLessThan(6000);
        expect((yield* f.store.getRun(f.id)).result).toEqual({ settled: true });
      }),
    ),
  20000,
);
