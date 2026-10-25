import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigLive } from "../config/index.js";
import { Functions, FunctionsLive } from "../functions/cache.js";
import { MetricsReader } from "../health/metrics.js";
import { ReadinessLive } from "../health/readiness.js";
import { TelemetryLive } from "../runtime/telemetry.js";
import { KubeConnection, KubeConnectionLive, makeKubeConnection } from "./config.js";
import { FunctionSourceLive, makeFunctionSource } from "./functions.js";

const namespace = "krun-test-p2-3";
const path = `/apis/krun.io/v1alpha1/namespaces/${namespace}/functions`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const app = createServer(handler);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        app.close((error) => (error ? reject(error) : resolve()));
        app.closeAllConnections();
      }),
  );
  const address = app.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected owned TCP test listener");
  return `http://127.0.0.1:${address.port}`;
};
const load = (server: string) => (config: KubeConfig) =>
  config.loadFromClusterAndUser(
    { name: namespace, server, skipTLSVerify: true },
    { name: namespace },
  );
const native = (server: string) =>
  Effect.gen(function* () {
    const connection = yield* makeKubeConnection({ load: load(server) });
    return yield* makeFunctionSource.pipe(
      Effect.provide(Layer.succeed(KubeConnection, connection)),
    );
  });
const list = { metadata: { resourceVersion: "42" }, items: [] };

it("native initial LIST and add/update/delete watch use the configured namespace and resourceVersion", async () => {
  const requests: URL[] = [];
  let closed = false;
  const url = await server((request, response) => {
    const location = new URL(request.url ?? "/", "http://krun-test.invalid");
    requests.push(location);
    expect(location.pathname).toBe(path);
    response.setHeader("content-type", "application/json");
    if (location.searchParams.get("watch") !== "true") {
      response.end(JSON.stringify(list));
      return;
    }
    request.on("close", () => {
      closed = true;
    });
    response.flushHeaders();
    for (const type of ["ADDED", "MODIFIED", "DELETED"])
      response.write(
        `${JSON.stringify({ type, object: { metadata: { name: "echo", namespace, uid: "test", generation: 1, resourceVersion: "43" } } })}\n`,
      );
  });
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        return yield* Stream.runCollect(source.watch(namespace).pipe(Stream.take(4)));
      }),
    ),
  );
  expect(events.map((event) => event.type)).toEqual(["sync", "add", "update", "delete"]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.searchParams.get("resourceVersion")).toBe("42");
  await vi.waitFor(() => expect(closed).toBe(true));
});

it.each([404, 403, 503])(
  "initial LIST HTTP %s is typed, redacted and never emits a sync",
  async (status) => {
    const url = await server((_request, response) => {
      response.writeHead(status);
      response.end(JSON.stringify({ message: "krun-test-private-diagnostic" }));
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* native(url);
          return yield* Effect.exit(Stream.runCollect(source.watch(namespace)));
        }),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain(`"status":${status}`);
    expect(JSON.stringify(result)).not.toContain("krun-test-private-diagnostic");
  },
);

it.each(["ERROR", "invalid-json", "close"])(
  "watch %s ends the attempt for a fresh LIST on retry",
  async (type) => {
    const url = await server((request, response) => {
      response.setHeader("content-type", "application/json");
      if (!request.url?.includes("watch=true")) {
        response.end(JSON.stringify(list));
        return;
      }
      if (type === "invalid-json") response.end("not-json\n");
      else if (type === "close") response.end();
      else
        response.end(
          `${JSON.stringify({ type: "ERROR", object: { code: 410, message: "krun-test-private-diagnostic" } })}\n`,
        );
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* native(url);
          return yield* Effect.exit(Stream.runCollect(source.watch(namespace)));
        }),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("krun-test-private-diagnostic");
    if (type === "ERROR") expect(JSON.stringify(result)).toContain('"status":410');
  },
);

it("scope interruption while LIST is pending aborts its request and never opens a late watch", async () => {
  let requests = 0;
  let closed = false;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const url = await server((request) => {
    requests++;
    request.on("close", () => {
      closed = true;
    });
    started();
  });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* Stream.runDrain(source.watch(namespace));
      }),
    ),
  );
  await pending;
  fiber.interruptUnsafe();
  await Effect.runPromise(Fiber.await(fiber));
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(requests).toBe(1);
});

it("scope interruption while watch headers are pending aborts that socket", async () => {
  let closed = false;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const url = await server((request, response) => {
    if (!request.url?.includes("watch=true")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(list));
      return;
    }
    request.on("close", () => {
      closed = true;
    });
    started();
  });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* native(url);
        yield* Stream.runDrain(source.watch(namespace));
      }),
    ),
  );
  await pending;
  fiber.interruptUnsafe();
  await Effect.runPromise(Fiber.await(fiber));
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("late authentication after cancellation cannot start a watch and closes its owned dispatcher", async () => {
  let requests = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { Agent } = await import("undici");
  const agent = new Agent();
  let calls = 0;
  const url = await server((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(list));
  });
  const connection = await Effect.runPromise(makeKubeConnection({ load: load(url) }));
  const original = connection.config.applySecurityAuthentication.bind(connection.config);
  const spy = vi
    .spyOn(connection.config, "applySecurityAuthentication")
    .mockImplementation(async (context) => {
      if (++calls === 1) return original(context);
      started();
      await gate;
      context.setDispatcher(agent);
    });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* makeFunctionSource.pipe(
          Effect.provide(Layer.succeed(KubeConnection, connection)),
        );
        yield* Stream.runDrain(source.watch(namespace));
      }),
    ),
  );
  try {
    await pending;
    fiber.interruptUnsafe();
    await Effect.runPromise(Fiber.await(fiber));
    release();
    await vi.waitFor(() => expect(agent.destroyed).toBe(true));
    expect(requests).toBe(1);
  } finally {
    release();
    spy.mockRestore();
    fiber.interruptUnsafe();
    await agent.destroy();
  }
});

it("KUBECONFIG defaults load an owned credential-free fixture; loading errors remain bounded", async () => {
  const scratch = process.env.TMPDIR;
  if (!scratch) throw new Error("TMPDIR must point to the agent scratch directory");
  const dir = await mkdtemp(join(scratch, "krun-test-p2-3-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const fixture = new KubeConfig();
  load("https://krun-test.invalid")(fixture);
  const file = join(dir, "config.json");
  await writeFile(file, fixture.exportConfig());
  vi.stubEnv("KUBECONFIG", file);
  const connection = await Effect.runPromise(Effect.scoped(makeKubeConnection()));
  expect(connection.config.getCurrentCluster()?.name).toBe(namespace);
  const error = await Effect.runPromise(
    Effect.exit(
      Effect.scoped(
        makeKubeConnection({
          load: () => {
            throw new Error("krun-test-private-diagnostic");
          },
        }),
      ),
    ),
  );
  expect(Exit.isFailure(error)).toBe(true);
  expect(JSON.stringify(error)).not.toContain("krun-test-private-diagnostic");
});

it.each(["gateway", "scheduler"] as const)(
  "%s production layers synchronize native events and export actual Prometheus ready gauges",
  async (role) => {
    const object = {
      apiVersion: "krun.io/v1alpha1",
      kind: "Function",
      metadata: { name: "echo", namespace, uid: "test-echo", generation: 1, resourceVersion: "41" },
      spec: {
        image: `ghcr.io/acme/worker@sha256:${"a".repeat(64)}`,
        inputSchema: { type: "object" },
      },
    };
    const bad = {
      ...object,
      metadata: { ...object.metadata, name: "invalid", uid: "test-invalid" },
      spec: { ...object.spec, image: "un-pinned" },
    };
    const url = await server((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("watch=true")) {
        response.flushHeaders();
        return;
      }
      response.end(JSON.stringify({ metadata: { resourceVersion: "42" }, items: [object, bad] }));
    });
    const scratch = process.env.TMPDIR;
    if (!scratch) throw new Error("Owned scratch directory required");
    const dir = await mkdtemp(join(scratch, "krun-test-p2-3-layers-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fixture = new KubeConfig();
    load(url)(fixture);
    const file = join(dir, "config.json");
    await writeFile(file, fixture.exportConfig());
    vi.stubEnv("KUBECONFIG", file);
    const config = ConfigLive(role, {
      env: { KRUN_NAMESPACE: namespace, KRUN_DB_MODE: "embedded", KRUN_K8S_CONCURRENCY: "2" },
    });
    const source = FunctionSourceLive.pipe(
      Layer.provide(KubeConnectionLive.pipe(Layer.provide(config))),
    );
    const services = FunctionsLive.pipe(
      Layer.provide(source),
      Layer.provideMerge(TelemetryLive()),
      Layer.provide(config),
      Layer.provide(ReadinessLive(Effect.void)),
    );
    const scrape = await Effect.runPromise(
      Effect.gen(function* () {
        const functions = yield* Functions;
        yield* functions.synced;
        expect((yield* functions.list).map((entry) => entry.name)).toEqual(["echo"]);
        expect(yield* functions.get("invalid")).toBeUndefined();
        return yield* (yield* MetricsReader).scrape;
      }).pipe(Effect.provide(services)),
    );
    expect(scrape.body).toMatch(/krun_functions_synced(?:\{[^\n]*\})? 1/);
    const gauges = scrape.body.split("\n").filter((line) => line.startsWith("krun_functions{"));
    expect(gauges).toHaveLength(2);
    expect(gauges.some((line) => line.includes('ready="true"') && line.endsWith(" 1"))).toBe(true);
    expect(gauges.some((line) => line.includes('ready="false"') && line.endsWith(" 1"))).toBe(true);
    expect(gauges.join("\n")).not.toMatch(/function=|uid=|name=|generation=/);
  },
);
