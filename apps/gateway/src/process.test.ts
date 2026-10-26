import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Schedule } from "effect";
import { Wait } from "testcontainers";
import { startFakeKube } from "../../../test/fake-kube/server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "bin/krun.js");
const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};
const fixture = (holdList = false, overrides: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-p37-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const namespace = "krun-test-p37";
    const kube = yield* Effect.acquireRelease(
      Effect.promise(() => startFakeKube(namespace, holdList)),
      (server) => Effect.promise(() => server.close()),
    );
    const bearer = randomBytes(32).toString("hex");
    const keys = join(dir, "keys.yaml");
    const kubeconfig = join(dir, "kubeconfig");
    yield* Effect.promise(() =>
      writeFile(
        keys,
        JSON.stringify({
          keys: [
            {
              name: "owner",
              key: bearer,
              scopes: ["functions:read", "runs:read", "runs:write"],
              functions: ["echo"],
            },
          ],
        }),
        { mode: 0o600 },
      ),
    );
    yield* Effect.promise(() =>
      writeFile(
        kubeconfig,
        JSON.stringify({
          apiVersion: "v1",
          kind: "Config",
          clusters: [
            {
              name: "krun-test-p37",
              cluster: { server: kube.address, "insecure-skip-tls-verify": true },
            },
          ],
          users: [{ name: "krun-test-p37", user: {} }],
          contexts: [
            {
              name: "krun-test-p37",
              context: { cluster: "krun-test-p37", user: "krun-test-p37", namespace },
            },
          ],
          "current-context": "krun-test-p37",
        }),
        { mode: 0o600 },
      ),
    );
    const ports = yield* Effect.promise(() => Promise.all([freePort(), freePort(), freePort()]));
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      TMPDIR: dir,
      KRUN_DB_MODE: "embedded",
      KRUN_DB_PATH: join(dir, "krun.db"),
      KRUN_NAMESPACE: namespace,
      KRUN_API_KEYS_PATH: keys,
      KUBECONFIG: kubeconfig,
      KRUN_LISTEN_ADDR: `127.0.0.1:${ports[0]}`,
      KRUN_INTERNAL_LISTEN_ADDR: `127.0.0.1:${ports[1]}`,
      KRUN_ADMIN_LISTEN_ADDR: `127.0.0.1:${ports[2]}`,
      KRUN_SHUTDOWN_DELAY: "2s",
      ...overrides,
    };
    // SPEC13 owns migration in a separate init/hook command, not serving replicas.
    const migrated = spawnSync(process.execPath, [cli, "migrate"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
    expect(migrated.status).toBe(0);
    let stdout = "",
      stderr = "";
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [cli, "gateway"], {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      (process) =>
        Effect.gen(function* () {
          if (process.exitCode !== null || process.signalCode !== null) return;
          process.kill("SIGTERM");
          yield* Effect.promise(
            () => new Promise<void>((resolve) => process.once("exit", () => resolve())),
          ).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.andThen(() =>
              Effect.sync(() => {
                if (process.exitCode === null && process.signalCode === null)
                  process.kill("SIGKILL");
              }),
            ),
          );
        }),
    );
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    child.stdout?.on("data", (value) => {
      stdout += String(value);
    });
    child.stderr?.on("data", (value) => {
      stderr += String(value);
    });
    const request = async (path: string, listener = 0, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${ports[listener]}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { code: response.status, body: await response.json() };
    };
    const until = (path: string, listener: number, code: number) =>
      Effect.suspend(() => {
        if (child.exitCode !== null || child.signalCode !== null)
          return Effect.die(new Error("Gateway exited before acceptance state"));
        return Effect.tryPromise({
          try: () => request(path, listener),
          catch: () => new Error("Owned probe pending"),
        }).pipe(
          Effect.flatMap((response) =>
            response.code === code
              ? Effect.succeed(response)
              : Effect.fail(new Error("Owned probe pending")),
          ),
        );
      }).pipe(
        Effect.retry(Schedule.spaced("20 millis")),
        Effect.timeout("10 seconds"),
        Effect.tapError(() =>
          Effect.sync(() => {
            const diagnostics = (stdout + stderr)
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                try {
                  const entry = JSON.parse(line);
                  return { msg: entry.msg, reason: entry.reason, status: entry.status };
                } catch {
                  return { msg: "Non-JSON process output" };
                }
              });
            console.log(
              JSON.stringify({
                probe: path,
                listener,
                expected: code,
                kube: kube.snapshot(),
                diagnostics,
              }),
            );
          }),
        ),
      );
    return { dir, child, exited, until, request, kube, bearer, logs: () => stdout + stderr };
  });

it.live(
  "gateway process: real LIST/WATCH readiness, three-listener isolation, persistent Run and ordered two-second SIGTERM drain",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* f.until("/healthz", 2, 200);
        expect((yield* Effect.promise(() => f.request("/readyz", 2))).code).toBe(503);
        expect((yield* Effect.promise(() => f.request("/v1/functions", 0))).code).toBe(503);
        f.kube.releaseList();
        yield* f.until("/readyz", 2, 200);
        expect(f.kube.snapshot().lists).toBeGreaterThan(0);
        for (const [path, listener] of [
          ["/v1/functions", 2],
          ["/internal/v1/runs/anything/input", 0],
          ["/metrics", 0],
          ["/v1/functions", 1],
          ["/readyz", 1],
        ] as const) {
          expect((yield* Effect.promise(() => f.request(path, listener))).code).toBe(404);
        }
        const created = yield* Effect.promise(() =>
          f.request("/v1/functions/echo/runs", 0, { input: { opaque: "krun-test-private-input" } }),
        );
        expect(created.code).toBe(201);
        const path = `/v1/${created.body.name}`;
        expect((yield* Effect.promise(() => f.request(path))).code).toBe(200);
        const at = performance.now();
        f.child.kill("SIGTERM");
        yield* f.until("/readyz", 2, 503);
        expect((yield* Effect.promise(() => f.request("/healthz", 2))).code).toBe(200);
        expect((yield* Effect.promise(() => f.request("/v1/functions/echo"))).code).toBe(200);
        expect((yield* Effect.promise(() => f.request(path))).code).toBe(200);
        const end = yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"));
        expect(end).toEqual({ code: 0, signal: null });
        expect(performance.now() - at).toBeGreaterThanOrEqual(1900);
        expect(performance.now() - at).toBeLessThan(5000);
        expect(f.kube.snapshot().activeWatches).toBe(0);
        const db = new DatabaseSync(join(f.dir, "krun.db"));
        try {
          expect(db.prepare("select count(*) as n from runs").get()?.n).toBe(1);
        } finally {
          db.close();
        }
        expect(f.logs().includes(f.bearer)).toBe(false);
        expect(f.logs().includes("krun-test-private-input")).toBe(false);
      }),
    ),
  30000,
);

it.live(
  "gateway can terminate while the real initial Kubernetes LIST is still pending",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* f.until("/healthz", 2, 200);
        yield* Effect.promise(() => f.kube.listed).pipe(Effect.timeout("2 seconds"));
        expect(f.kube.snapshot().pendingLists).toBe(1);
        expect((yield* Effect.promise(() => f.request("/readyz", 2))).code).toBe(503);
        f.child.kill("SIGTERM");
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"))).toEqual({
          code: 0,
          signal: null,
        });
      }),
    ),
  20000,
);

it.live(
  "SIGTERM answers an in-flight CreateRun wait with its current201 Run, not INTERNAL",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.until("/readyz", 2, 200);
        const waiting = f.request("/v1/functions/echo/runs?wait=60s", 0, {
          input: { pending: true },
        });
        yield* Effect.tryPromise({
          try: () => f.request("/v1/functions/echo/runs"),
          catch: () => new Error("Owned admission pending"),
        }).pipe(
          Effect.flatMap((response) =>
            response.code === 200 && response.body.runs.length === 1
              ? Effect.void
              : Effect.fail(new Error("Owned admission pending")),
          ),
          Effect.retry(Schedule.spaced("20 millis")),
          Effect.timeout("5 seconds"),
        );
        f.child.kill("SIGTERM");
        yield* f.until("/readyz", 2, 503);
        const response = yield* Effect.promise(() => waiting).pipe(Effect.timeout("5 seconds"));
        expect(response.code).toBe(201);
        expect(response.body.state).toBe("QUEUED");
        expect(response.body.input).toEqual({ pending: true });
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"))).toEqual({
          code: 0,
          signal: null,
        });
      }),
    ),
  20000,
);

it.live(
  "partial listener startup failure closes acquired resources and exits1 without drain delay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(true, { KRUN_INTERNAL_LISTEN_ADDR: "invalid" });
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"))).toEqual({
          code: 1,
          signal: null,
        });
        expect(f.kube.snapshot().activeWatches).toBe(0);
        expect(f.logs().includes(f.bearer)).toBe(false);
      }),
    ),
  20000,
);

it.live(
  "PostgreSQL gateway process uses migrated Store and closes both pool and LISTEN sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const postgres = yield* Effect.acquireRelease(
          Effect.promise(() =>
            new PostgreSqlContainer(
              "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
            )
              .withName(`krun-test-p37-process-pg-${randomBytes(6).toString("hex")}`)
              .withDatabase("krun_test_p37_process")
              .withPassword(randomBytes(32).toString("hex"))
              .withWaitStrategy(
                Wait.forLogMessage(/database system is ready to accept connections/, 2),
              )
              .start(),
          ),
          (container) => Effect.promise(() => container.stop()),
        );
        const f = yield* fixture(false, {
          KRUN_DB_MODE: "postgres",
          KRUN_DB_DSN: postgres.getConnectionUri(),
        });
        yield* f.until("/readyz", 2, 200);
        const created = yield* Effect.promise(() =>
          f.request("/v1/functions/echo/runs", 0, { input: { postgres: true } }),
        );
        expect(created.code).toBe(201);
        expect(
          (yield* Effect.promise(() => f.request(`/v1/${created.body.name}`))).body.input,
        ).toEqual({ postgres: true });
        f.child.kill("SIGTERM");
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"))).toEqual({
          code: 0,
          signal: null,
        });
        const check = yield* Effect.promise(() =>
          postgres.exec([
            "psql",
            "-U",
            postgres.getUsername(),
            "-d",
            "krun_test_p37_process",
            "-Atc",
            "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'; select count(*) from runs;",
          ]),
        );
        expect(check.exitCode).toBe(0);
        expect(check.output.trim().split(/\s+/).map(Number)).toEqual([0, 1]);
      }),
    ),
  60000,
);

it.live(
  "SIGINT uses the same scoped drain and graceful exit0 policy",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.until("/readyz", 2, 200);
        f.child.kill("SIGINT");
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("5 seconds"))).toEqual({
          code: 0,
          signal: null,
        });
      }),
    ),
  20000,
);

it.live(
  "internal constructor framework errors use the canonical sanitized envelope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.until("/readyz", 2, 200);
        for (const path of ["/internal/v1/runs/%zz/input", "/internal/v1/runs/%E0%A4%A/input"]) {
          const response = yield* Effect.promise(() => f.request(path, 1));
          expect(response.code).toBe(400);
          expect(response.body.error).toMatchObject({
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Request is invalid",
            details: [{ reason: "REQUEST_INVALID", domain: "krun.io" }],
          });
          expect(JSON.stringify(response.body).includes(path)).toBe(false);
        }
        expect(
          (yield* Effect.promise(() => f.request("/v1/functions", 1))).body.error.details[0].reason,
        ).toBe("ROUTE_NOT_FOUND");
      }),
    ),
  20000,
);

it.live(
  "wait admission blocked before commit across drain still returns201 and rejects post-seal admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const postgres = yield* Effect.acquireRelease(
          Effect.promise(() =>
            new PostgreSqlContainer(
              "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
            )
              .withName(`krun-test-p37-admission-pg-${randomBytes(6).toString("hex")}`)
              .withDatabase("krun_test_p37_admission")
              .withPassword(randomBytes(32).toString("hex"))
              .withWaitStrategy(
                Wait.forLogMessage(/database system is ready to accept connections/, 2),
              )
              .start(),
          ),
          (container) => Effect.promise(() => container.stop()),
        );
        const f = yield* fixture(false, {
          KRUN_DB_MODE: "postgres",
          KRUN_DB_DSN: postgres.getConnectionUri(),
        });
        yield* f.until("/readyz", 2, 200);
        const query = (sql: string) =>
          Effect.promise(() =>
            postgres.exec([
              "psql",
              "-U",
              postgres.getUsername(),
              "-d",
              "krun_test_p37_admission",
              "-Atc",
              sql,
            ]),
          );
        const release = query(
          "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'krun-test-p37-locker' and datname = current_database()",
        );
        const hold = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const pending = postgres.exec([
              "psql",
              "-U",
              postgres.getUsername(),
              "-d",
              "krun_test_p37_admission",
              "-Atc",
              "set application_name = 'krun-test-p37-locker'; begin; lock table run_events in access exclusive mode; select pg_sleep(30); rollback;",
            ]);
            pending.catch(() => {});
            return pending;
          }),
          () => release.pipe(Effect.asVoid),
        );
        const observe = (sql: string) =>
          query(sql).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0 && Number(result.output.trim()) > 0
                ? Effect.void
                : Effect.fail(new Error("Owned lock pending")),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("5 seconds"),
          );
        yield* observe(
          "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='krun-test-p37-locker' and l.relation='run_events'::regclass and l.mode='AccessExclusiveLock' and l.granted",
        );
        const waiting = f.request("/v1/functions/echo/runs?wait=60s", 0, {
          input: { precommit: true },
        });
        waiting.catch(() => {});
        yield* observe(
          "select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%insert into%run_events%'",
        );
        f.child.kill("SIGTERM");
        yield* f.until("/readyz", 2, 503);
        // A deliberate native adversarial hold across the actual two-second grace,
        // not an application timer or a substitute for observing the real SQL lock.
        yield* Effect.sleep("2250 millis");
        const late = yield* Effect.promise(() =>
          f.request("/v1/functions/echo/runs?wait=60s", 0, { input: { late: true } }),
        ).pipe(Effect.timeout("500 millis"));
        expect(late.code).toBe(503);
        expect(late.body.error.details[0].reason).toBe("NOT_READY");
        yield* release;
        yield* Effect.promise(() => hold);
        const response = yield* Effect.promise(() => waiting).pipe(Effect.timeout("2 seconds"));
        expect(response.code).toBe(201);
        expect(response.body.state).toBe("QUEUED");
        expect(response.body.input).toEqual({ precommit: true });
        expect(yield* Effect.promise(() => f.exited).pipe(Effect.timeout("2 seconds"))).toEqual({
          code: 0,
          signal: null,
        });
        const stored = yield* query("select count(*) from runs");
        expect(stored.output.trim()).toBe("1");
      }),
    ),
  60000,
);
