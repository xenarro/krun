import { createServer, type ServerResponse } from "node:http";

export interface StatusFunction {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid: string;
    readonly generation: number;
    readonly resourceVersion: string;
  };
  readonly spec: Record<string, unknown>;
  readonly status?: unknown;
}

// Explicit owned namespace only. This server enforces status-only Merge Patch
// and UID/resourceVersion preconditions; it is not Kubernetes admission.
export const startFunctionStatusKube = async (
  namespace: string,
  initial: readonly StatusFunction[],
) => {
  const objects = new Map(initial.map((object) => [object.metadata.name, structuredClone(object)]));
  const watchers = new Set<ServerResponse>();
  const patches: { name: string; contentType: string | undefined; body: unknown; code: number }[] =
    [];
  const waiting = new Map<number, (() => void)[]>();
  let version = 100;
  let resolveWatching = () => {};
  const watching = new Promise<void>((resolve) => {
    resolveWatching = resolve;
  });
  let fail = 0;
  let hold: { received: () => void; closed: () => void; release: Promise<void> } | undefined;
  const emit = (object: StatusFunction, type = "MODIFIED") => {
    for (const response of watchers) response.write(`${JSON.stringify({ type, object })}\n`);
  };
  const notify = () => {
    for (const [count, callbacks] of waiting)
      if (patches.length >= count) {
        waiting.delete(count);
        for (const callback of callbacks) callback();
      }
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://krun-test.invalid");
    const path = `/apis/krun.io/v1alpha1/namespaces/${namespace}/functions`;
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === path) {
      if (url.searchParams.get("watch") === "true") {
        watchers.add(response);
        response.flushHeaders();
        resolveWatching();
        response.once("close", () => watchers.delete(response));
      } else
        response.end(
          JSON.stringify({
            metadata: { resourceVersion: String(version) },
            items: [...objects.values()],
          }),
        );
      return;
    }
    if (
      request.method !== "PATCH" ||
      !url.pathname.startsWith(`${path}/`) ||
      !url.pathname.endsWith("/status")
    ) {
      response.writeHead(404).end();
      return;
    }
    const name = url.pathname.slice(path.length + 1, -"/status".length);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const paused = hold;
    hold = undefined;
    if (paused) {
      response.once("close", paused.closed);
      paused.received();
      await paused.release;
      if (response.destroyed) return;
    }
    const current = objects.get(name);
    const contentType = request.headers["content-type"];
    const code =
      fail ||
      (contentType !== "application/merge-patch+json" ||
      Object.keys(body).sort().join(",") !== "metadata,status"
        ? 422
        : !current
          ? 404
          : current.metadata.uid !== body.metadata?.uid ||
              current.metadata.resourceVersion !== body.metadata?.resourceVersion
            ? 409
            : 200);
    fail = 0;
    patches.push({ name, contentType, body: structuredClone(body), code });
    if (code !== 200 || current === undefined) {
      response
        .writeHead(code)
        .end(JSON.stringify({ kind: "Status", code, message: "krun-test-private-status-canary" }));
    } else {
      const updated = {
        ...current,
        metadata: { ...current.metadata, resourceVersion: String(++version) },
        status: body.status,
      };
      objects.set(name, updated);
      response.end(JSON.stringify(updated));
      emit(updated);
    }
    notify();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned status server unavailable");
  return {
    address: `http://127.0.0.1:${address.port}`,
    patches,
    watching,
    snapshot: (name: string) => structuredClone(objects.get(name)),
    failNext: (code: number) => {
      fail = code;
    },
    observe: (object: StatusFunction) => {
      objects.set(object.metadata.name, structuredClone(object));
      emit(object);
    },
    holdNext: () => {
      let received = () => {};
      let closed = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        received = resolve;
      });
      const aborted = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { received, closed, release: pending };
      return { started, aborted, release };
    },
    waitForPatches: (count: number) =>
      patches.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const callbacks = waiting.get(count) ?? [];
            callbacks.push(resolve);
            waiting.set(count, callbacks);
          }),
    close: async () => {
      for (const watcher of watchers) watcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
