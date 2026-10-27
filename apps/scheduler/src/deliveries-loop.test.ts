import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import { ConfigLive, parseSchedulerConfig } from "@krun/shared/dist/config/index.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { DatabaseError, type SqliteTables, Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Queue,
  References,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { z } from "zod";
import { makeDeliveriesLoop } from "./deliveries-loop.js";

const id = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const testStore = StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")));
const counter = (state: string) =>
  Metric.value(
    Metric.counter("krun_deliveries_total", { incremental: true }).pipe(
      Metric.withAttributes({ state }),
    ),
  ).pipe(Effect.map((value) => value.count));
const fixture = Effect.gen(function* () {
  const store = yield* Store;
  const database = yield* Database;
  yield* store.migrate();
  const requests = yield* Queue.unbounded<number>();
  const updates = yield* Queue.unbounded<void>();
  const observe = Effect.runSyncWith(yield* Effect.context());
  const hits: { body: Buffer; headers: IncomingHttpHeaders }[] = [];
  const held: ServerResponse[] = [];
  const statuses: number[] = [];
  let hold = false,
    active = 0,
    peak = 0,
    dnsCalls = 0;
  let addresses = [{ address: "127.0.0.1", family: 4 }];
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer((request, response) => {
        active++;
        peak = Math.max(peak, active);
        response.once("close", () => {
          active--;
        });
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          hits.push({ body: Buffer.concat(chunks), headers: request.headers });
          if (hold) held.push(response);
          else {
            const status = statuses.shift() ?? 204;
            if (status === 0) response.destroy();
            else {
              response.statusCode = status;
              response.setHeader("location", "/must-not-follow");
              response.end("krun-test-p53-private-response");
            }
          }
          observe(Queue.offer(requests, hits.length));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("Missing test receiver");
  const secrets = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const config = yield* parseSchedulerConfig({
    KRUN_DB_MODE: "embedded",
    KRUN_NAMESPACE: "krun-test-p53",
    KRUN_WEBHOOK_ALLOWED_HOSTS: "krun-test-p53.invalid",
    KRUN_WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8",
    KRUN_WEBHOOK_SECRET: secrets.join(","),
  });
  const claims: { now: number; limit: number }[] = [];
  let claim = store.claimDeliveries,
    update = store.updateDelivery;
  const wrapped: Store["Service"] = {
    ...store,
    claimDeliveries: (now, limit) =>
      Effect.suspend(() => {
        claims.push({ now: DateTime.toEpochMillis(now), limit });
        return claim(now, limit);
      }),
    updateDelivery: (...args) =>
      update(...args).pipe(Effect.tap(() => Queue.offer(updates, undefined))),
  };
  const owner = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const make = (overrides: Partial<typeof config> = {}) =>
    makeDeliveriesLoop({ ...config, ...overrides }).pipe(
      Effect.provideService(Store, wrapped),
      Effect.provideService(DnsLookup, {
        lookup: () =>
          Effect.sync(() => {
            dnsCalls++;
            return addresses;
          }),
      }),
      Effect.provideService(Scope.Scope, owner),
    );
  const loop = yield* make();
  const seed = (n: number) =>
    Effect.gen(function* () {
      yield* store.createRun({
        id: id(n),
        idempotency_key: null,
        request_hash: "test",
        function_name: "echo",
        input: { private: "krun-test-p53-private-input" },
        priority: 0,
        callback_url: `http://krun-test-p53.invalid:${address.port}/hook?private=krun-test-p53-private-query`,
        created_by: "test",
        created_at: yield* DateTime.now,
      });
      yield* store.transition(id(n), "queued", "failed", "queue_timeout", {
        result: { private: "krun-test-p53-private-result" },
        log_tail: "krun-test-p53-private-log",
        error: {
          source: "function",
          message: "failed",
          details: { private: "krun-test-p53-private-details" },
        },
      });
    });
  const rows = Effect.promise(() =>
    database.db
      .withTables<SqliteTables>()
      .selectFrom("deliveries")
      .selectAll()
      .orderBy("run_id")
      .execute(),
  );
  const first = rows.pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.die("Missing delivery"))),
  );
  return {
    store,
    config,
    loop,
    make,
    seed,
    rows,
    first,
    hits,
    held,
    statuses,
    claims,
    requests,
    updates,
    secrets,
    owner,
    setHold: (value: boolean) => {
      hold = value;
    },
    peak: () => peak,
    active: () => active,
    dnsCalls: () => dnsCalls,
    setAddresses: (value: typeof addresses) => {
      addresses = value;
    },
    setClaim: (value: typeof claim) => {
      claim = value;
    },
    setUpdate: (value: typeof update) => {
      update = value;
    },
  };
});
const run = <R>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, unknown, R>) =>
  fixture.pipe(
    Effect.flatMap(body),
    Effect.provide(testStore),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
const verify = (hit: { body: Buffer; headers: IncomingHttpHeaders }, secret: string) => {
  const signature = String(hit.headers["x-krun-signature"]);
  const timestamp = signature.split(",")[0]?.slice(2);
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(hit.body).digest();
  return signature
    .split(",")
    .slice(1)
    .some((part) => {
      const actual = Buffer.from(part.slice(3), "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
};

it.effect(
  "native500 then200 persists the retry and fresh rotated signatures over exact BASIC bytes",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.statuses.push(500, 200);
        yield* f.seed(1);
        yield* f.loop.iterate;
        const failed = yield* f.first;
        expect(failed.state).toBe("pending");
        expect(failed.attempt).toBe(1);
        expect(failed.last_error).toBe("status 500");
        expect(DateTime.toEpochMillis(DateTime.makeUnsafe(failed.next_at))).toBe(60000);
        yield* TestClock.adjust("59999 millis");
        yield* f.loop.iterate;
        expect(f.hits).toHaveLength(1);
        yield* TestClock.adjust("1 millis");
        yield* f.loop.iterate;
        expect((yield* f.first).state).toBe("delivered");
        expect((yield* f.first).last_error).toBeNull();
        expect(f.hits).toHaveLength(2);
        expect(f.dnsCalls()).toBe(2);
        const [a, b] = f.hits;
        if (!a || !b) return yield* Effect.die("Missing native attempts");
        expect(a.headers["x-krun-delivery"]).toBe(b.headers["x-krun-delivery"]);
        expect(a.headers["x-krun-run-id"]).toBe(id(1));
        expect(a.headers["content-type"]).toBe("application/json");
        expect(a.body.equals(b.body)).toBe(true);
        expect(String(a.headers["x-krun-signature"]).startsWith("t=0,")).toBe(true);
        expect(String(b.headers["x-krun-signature"]).startsWith("t=60,")).toBe(true);
        for (const hit of f.hits) {
          for (const secret of f.secrets) expect(verify(hit, secret)).toBe(true);
          expect(String(hit.headers.traceparent)).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
        }
        expect(a.headers.traceparent).not.toBe(b.headers.traceparent);
        const basic = JSON.parse(a.body.toString());
        expect(basic.state).toBe("FAILED");
        expect(basic).not.toHaveProperty("input");
        expect(basic).not.toHaveProperty("result");
        expect(basic).not.toHaveProperty("logTail");
        expect(basic.error).not.toHaveProperty("details");
        expect(yield* counter("pending")).toBe(1);
        expect(yield* counter("delivered")).toBe(1);
      }),
    ),
);

it.effect("native302 is a failed attempt, never a redirected POST or acknowledgement", () =>
  run((f) =>
    Effect.gen(function* () {
      f.statuses.push(302);
      yield* f.seed(1);
      yield* f.loop.iterate;
      expect(f.hits).toHaveLength(1);
      expect((yield* f.first).state).toBe("pending");
      expect((yield* f.first).last_error).toBe("status 302");
    }),
  ),
);

it.effect(
  "six native failures follow every persisted delay then mark dead with no seventh send",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.statuses.push(500, 500, 500, 500, 500, 500);
        yield* f.seed(1);
        for (const delay of [
          "1 minute",
          "5 minutes",
          "30 minutes",
          "2 hours",
          "12 hours",
        ] as const) {
          yield* f.loop.iterate;
          const row = yield* f.first;
          expect(row.state).toBe("pending");
          expect(row.attempt).toBe(f.hits.length);
          yield* TestClock.adjust(delay);
        }
        yield* f.loop.iterate;
        const row = yield* f.first;
        expect(row.state).toBe("dead");
        expect(row.attempt).toBe(6);
        expect(row.last_error).toBe("status 500");
        yield* TestClock.adjust("24 hours");
        yield* f.loop.iterate;
        expect(f.hits).toHaveLength(6);
        expect(yield* counter("pending")).toBe(5);
        expect(yield* counter("dead")).toBe(1);
      }),
    ),
);

it.effect(
  "forty native sends are awaited in waves of eight, then a full batch reclaims immediately",
  () =>
    run((f) =>
      Effect.gen(function* () {
        for (let n = 1; n <= 40; n++) yield* f.seed(n);
        f.setHold(true);
        const running = yield* Effect.forkChild(f.loop.iterate);
        for (let wave = 0; wave < 5; wave++) {
          for (let n = 0; n < 8; n++) yield* Queue.take(f.requests);
          expect(f.hits).toHaveLength((wave + 1) * 8);
          expect(f.claims).toHaveLength(1);
          expect(f.peak()).toBeLessThanOrEqual(8);
          for (const response of f.held.splice(0)) {
            response.statusCode = 204;
            response.end();
          }
        }
        yield* Fiber.join(running);
        expect(f.peak()).toBe(8);
        expect((yield* f.rows).every((row) => row.state === "delivered")).toBe(true);
        expect(f.claims).toEqual([
          { now: 0, limit: 40 },
          { now: 0, limit: 40 },
        ]);
        expect(yield* counter("delivered")).toBe(40);
      }),
    ),
);

it.effect("native never-answering receiver times out at ten seconds and aborts its socket", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.seed(1);
      f.setHold(true);
      const running = yield* Effect.forkChild(f.loop.iterate);
      yield* Queue.take(f.requests);
      const closed = yield* Deferred.make<void>();
      const observe = Effect.runSyncWith(yield* Effect.context());
      f.held[0]?.once("close", () => observe(Deferred.succeed(closed, undefined)));
      yield* TestClock.adjust("9999 millis");
      expect((yield* f.first).attempt).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(running);
      yield* Deferred.await(closed);
      expect((yield* f.first).last_error).toBe("timeout");
      expect((yield* f.first).attempt).toBe(1);
      expect(f.active()).toBe(0);
    }),
  ),
);

it.effect(
  "DNS is rechecked on retry and a newly private answer never reaches the native receiver",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.statuses.push(500);
        yield* f.seed(1);
        yield* f.loop.iterate;
        f.setAddresses([{ address: "169.254.169.254", family: 4 }]);
        yield* TestClock.adjust("1 minute");
        yield* f.loop.iterate;
        expect(f.hits).toHaveLength(1);
        expect(f.dnsCalls()).toBe(2);
        expect((yield* f.first).attempt).toBe(2);
        expect((yield* f.first).last_error).toBe("address rejected: address");
      }),
    ),
);

for (const mode of ["interrupt", "scope"] as const)
  it.effect(
    `native held attempt on ${mode} retains its lease without consuming an attempt or counter`,
    () =>
      run((f) =>
        Effect.gen(function* () {
          yield* f.seed(1);
          f.setHold(true);
          const running = yield* Effect.forkChild(f.loop.iterate);
          yield* Queue.take(f.requests);
          if (mode === "interrupt") yield* Fiber.interrupt(running);
          else {
            yield* Scope.close(f.owner, Exit.void);
            yield* Fiber.await(running);
          }
          const row = yield* f.first;
          expect(row.state).toBe("pending");
          expect(row.attempt).toBe(0);
          expect(row.last_error).toBeNull();
          expect(DateTime.toEpochMillis(DateTime.makeUnsafe(row.next_at))).toBe(60000);
          expect(yield* counter("pending")).toBe(0);
          expect(yield* counter("dead")).toBe(0);
          const before = f.claims.length;
          if (mode === "scope") {
            yield* f.loop.iterate;
            expect(f.claims).toHaveLength(before);
          }
        }),
      ),
  );

it.effect("empty host configuration neither claims nor consumes old pending callbacks", () =>
  run((f) =>
    Effect.gen(function* () {
      const disabled = yield* f.make({ KRUN_WEBHOOK_ALLOWED_HOSTS: [], KRUN_WEBHOOK_SECRET: [] });
      yield* f.seed(1);
      yield* disabled.iterate;
      const running = yield* Effect.forkChild(disabled.run);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.interrupt(running);
      expect(f.claims).toHaveLength(0);
      expect(f.hits).toHaveLength(0);
      expect((yield* f.first).attempt).toBe(0);
    }),
  ),
);

it.effect(
  "an outcome Store failure does not cancel other sends or publish an uncommitted metric",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.seed(1);
        yield* f.seed(2);
        f.setUpdate((...args) =>
          args[0] === f.hits[0]?.headers["x-krun-delivery"]
            ? Effect.fail(new DatabaseError({ operation: "updateDelivery" }))
            : f.store.updateDelivery(...args),
        );
        yield* f.loop.iterate;
        expect(f.hits).toHaveLength(2);
        expect((yield* f.rows).filter((row) => row.state === "delivered")).toHaveLength(1);
        expect(yield* counter("delivered")).toBe(1);
      }),
    ),
);

it.effect(
  "claim failure is sanitized and the five-second loop recovers without overlapping ticks",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.seed(1);
        let first = true;
        f.setClaim((...args) => {
          if (first) {
            first = false;
            return Effect.fail(new DatabaseError({ operation: "claimDeliveries" }));
          }
          return f.store.claimDeliveries(...args);
        });
        const running = yield* Effect.forkChild(f.loop.run);
        yield* TestClock.adjust("4999 millis");
        expect(f.hits).toHaveLength(0);
        yield* TestClock.adjust("1 millis");
        yield* Queue.take(f.updates);
        expect((yield* f.first).state).toBe("delivered");
        yield* Fiber.interrupt(running);
        expect(f.claims.map((call) => call.now)).toEqual([0, 5000]);
      }),
    ),
);

it.effect("forty ten-second native timeouts finish within the sixty-second claim lease", () =>
  run((f) =>
    Effect.gen(function* () {
      for (let n = 1; n <= 40; n++) yield* f.seed(n);
      f.setHold(true);
      const running = yield* Effect.forkChild(f.loop.iterate);
      for (let wave = 0; wave < 5; wave++) {
        for (let n = 0; n < 8; n++) yield* Queue.take(f.requests);
        yield* TestClock.adjust("10 seconds");
      }
      yield* Fiber.join(running);
      expect(f.hits).toHaveLength(40);
      expect(f.claims).toEqual([
        { now: 0, limit: 40 },
        { now: 50000, limit: 40 },
      ]);
      const rows = yield* f.rows;
      expect(
        rows.every(
          (row) => row.state === "pending" && row.attempt === 1 && row.last_error === "timeout",
        ),
      ).toBe(true);
      expect(yield* counter("pending")).toBe(40);
    }),
  ),
);

it.effect("a full batch immediately drains the next short batch in the same pass", () =>
  run((f) =>
    Effect.gen(function* () {
      for (let n = 1; n <= 41; n++) yield* f.seed(n);
      yield* f.loop.iterate;
      expect(f.hits).toHaveLength(41);
      expect(f.claims).toEqual([
        { now: 0, limit: 40 },
        { now: 0, limit: 40 },
      ]);
      expect((yield* f.rows).every((row) => row.state === "delivered")).toBe(true);
    }),
  ),
);

it.effect("concurrent pass callers cannot overlap claiming or sending", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.seed(1);
      f.setHold(true);
      const first = yield* Effect.forkChild(f.loop.iterate);
      yield* Queue.take(f.requests);
      const second = yield* Effect.forkChild(f.loop.iterate);
      yield* Effect.yieldNow;
      expect(f.claims).toHaveLength(1);
      for (const response of f.held.splice(0)) {
        response.statusCode = 204;
        response.end();
      }
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(f.claims).toHaveLength(2);
      expect(f.hits).toHaveLength(1);
    }),
  ),
);

it.effect(
  "a committed outcome settles before interruption and publishes exactly one committed metric",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.seed(1);
        const committed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setUpdate((...args) =>
          f.store.updateDelivery(...args).pipe(
            Effect.tap(() => Deferred.succeed(committed, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
        );
        const running = yield* Effect.forkChild(f.loop.iterate);
        yield* Deferred.await(committed);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(running));
        yield* Effect.yieldNow;
        expect((yield* f.first).state).toBe("delivered");
        expect(yield* counter("delivered")).toBe(0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
        expect(yield* counter("delivered")).toBe(1);
      }),
    ),
);

it.effect(
  "one native connection reset does not abort sibling deliveries or expose a native error",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.seed(1);
        yield* f.seed(2);
        f.statuses.push(0, 204);
        yield* f.loop.iterate;
        const rows = yield* f.rows;
        expect(rows.filter((row) => row.state === "delivered")).toHaveLength(1);
        expect(rows.filter((row) => row.last_error === "request")).toHaveLength(1);
        expect(f.hits).toHaveLength(2);
      }),
    ),
);

afterEach(() => vi.unstubAllEnvs());
it.effect(
  "actual OTLP attempt contexts match outbound traceparent; Prometheus states and logs stay private",
  () =>
    run((f) =>
      Effect.gen(function* () {
        for (const key of [
          "OTEL_RESOURCE_ATTRIBUTES",
          "OTEL_EXPORTER_OTLP_HEADERS",
          "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
        ])
          vi.stubEnv(key, "");
        const payloads: string[] = [];
        const logs: unknown[] = [];
        const collector = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () => {
                payloads.push(Buffer.concat(chunks).toString());
                response.setHeader("content-type", "application/json");
                response.end("{}");
              });
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = collector.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("Missing owned collector");
        const telemetry = TelemetryLive().pipe(
          Layer.provide(
            ConfigLive("scheduler", {
              env: {
                KRUN_DB_MODE: "embedded",
                KRUN_NAMESPACE: "krun-test-p53",
                OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
                OTEL_TRACES_SAMPLER: "always_on",
              },
            }),
          ),
        );
        const logger = Logger.make(({ message, fiber }) =>
          logs.push({ message, fields: fiber.getRef(References.CurrentLogAnnotations) }),
        );
        yield* Effect.gen(function* () {
          f.statuses.push(500, 200, 500);
          yield* f.seed(1);
          yield* f.loop.iterate;
          yield* TestClock.adjust("1 minute");
          yield* f.loop.iterate;
          yield* f.seed(2);
          const pending = (yield* f.rows).find((row) => row.state === "pending");
          if (!pending) return yield* Effect.die("Missing pending row");
          yield* f.store.updateDelivery(pending.id, "pending", 5, yield* DateTime.now, null);
          yield* f.loop.iterate;
          const metrics = (yield* (yield* MetricsReader).scrape).body;
          for (const state of ["pending", "delivered", "dead"])
            expect(metrics).toContain(`krun_deliveries_total{state="${state}"} 1`);
          expect(metrics).not.toContain("krun_deliveries_total_total");
        }).pipe(Effect.provide(telemetry), Effect.provide(Logger.layer([logger])));
        const schema = z.object({
          resourceSpans: z.array(
            z.object({
              scopeSpans: z.array(
                z.object({
                  spans: z.array(
                    z.looseObject({
                      name: z.string(),
                      traceId: z.string(),
                      spanId: z.string(),
                      parentSpanId: z.string().optional(),
                    }),
                  ),
                }),
              ),
            }),
          ),
        });
        const spans = payloads.flatMap((text) =>
          schema
            .parse(JSON.parse(text))
            .resourceSpans.flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans),
            ),
        );
        const attempts = spans.filter((span) => span.name === "webhook.deliver");
        expect(attempts).toHaveLength(3);
        for (const hit of f.hits) {
          const parts = String(hit.headers.traceparent).split("-");
          expect(
            attempts.some((span) => span.traceId === parts[1] && span.spanId === parts[2]),
          ).toBe(true);
        }
        for (const span of attempts)
          expect(spans.find((parent) => parent.spanId === span.parentSpanId)?.name).toBe(
            "scheduler.deliveries",
          );
        const observed = JSON.stringify({ payloads, logs });
        for (const marker of [
          "krun-test-p53-private-input",
          "krun-test-p53-private-result",
          "krun-test-p53-private-log",
          "krun-test-p53-private-details",
          "krun-test-p53-private-query",
          "krun-test-p53-private-response",
          ...f.secrets,
          ...f.hits.map((hit) => String(hit.headers["x-krun-signature"])),
        ])
          expect(observed.includes(marker)).toBe(false);
      }),
    ),
);

it.effect("retention deletion during a native POST does not publish an unpersisted outcome", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.seed(1);
      yield* TestClock.adjust("2 days");
      f.setHold(true);
      const sending = yield* Effect.forkChild(f.loop.iterate);
      yield* Queue.take(f.requests);
      expect(yield* f.store.sweep(DateTime.makeUnsafe(86400000), 1000)).toBe(1);
      expect(yield* f.rows).toHaveLength(0);
      for (const response of f.held.splice(0)) {
        response.statusCode = 204;
        response.end();
      }
      yield* Fiber.join(sending);
      expect(yield* counter("delivered")).toBe(0);
      expect(yield* f.rows).toHaveLength(0);
    }),
  ),
);

it.effect(
  "a delayed old outcome cannot regress a fresh acknowledgement or produce a third POST",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.seed(1);
        f.statuses.push(500, 200, 204);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setUpdate((...args) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(f.store.updateDelivery(...args)),
          ),
        );
        const old = yield* Effect.forkChild(f.loop.iterate);
        yield* Deferred.await(started);
        const closing = yield* Effect.forkChild(Scope.close(f.owner, Exit.void));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("61 seconds");
        const fresh = yield* makeDeliveriesLoop(f.config).pipe(
          Effect.provideService(Store, f.store),
          Effect.provideService(DnsLookup, {
            lookup: () => Effect.succeed([{ address: "127.0.0.1", family: 4 }]),
          }),
        );
        yield* fresh.iterate;
        const acknowledged = yield* f.first;
        expect(acknowledged.state).toBe("delivered");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(old);
        yield* Fiber.join(closing);
        expect(yield* f.first).toEqual(acknowledged);
        yield* fresh.iterate;
        expect(f.hits).toHaveLength(2);
        expect(yield* counter("delivered")).toBe(1);
        expect(yield* counter("pending")).toBe(0);
      }),
    ),
);
