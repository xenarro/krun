import { createServer, type ServerResponse } from "node:http";

// Owned HTTP boundary for process acceptance. No production context, kubectl,
// module mocks or Kubernetes credentials; the real client performs LIST/WATCH.
export const startFakeKube = async (namespace: string, holdList = false) => {
  const waiting = new Set<ServerResponse>();
  const watches = new Set<ServerResponse>();
  let listedResolve = () => {};
  const listed = new Promise<void>((resolve) => {
    listedResolve = resolve;
  });
  let released = !holdList;
  let lists = 0;
  let started = 0;
  let closed = 0;
  const resource = {
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: {
      name: "echo",
      namespace,
      uid: "krun-test-echo",
      generation: 1,
      resourceVersion: "1",
    },
    spec: {
      image: `example.invalid/job@sha256:${"a".repeat(64)}`,
      inputSchema: { type: "object" },
    },
  };
  const list = (response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        apiVersion: "krun.io/v1alpha1",
        kind: "FunctionList",
        metadata: { resourceVersion: "1" },
        items: [resource],
      }),
    );
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://krun-test.invalid");
    if (
      request.method !== "GET" ||
      url.pathname !== `/apis/krun.io/v1alpha1/namespaces/${namespace}/functions`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("watch") === "true") {
      started++;
      watches.add(response);
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.once("close", () => {
        watches.delete(response);
        closed++;
      });
    } else {
      lists++;
      listedResolve();
      if (released) list(response);
      else {
        waiting.add(response);
        response.once("close", () => waiting.delete(response));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Owned fake Kube unavailable");
  return {
    address: `http://127.0.0.1:${endpoint.port}`,
    listed,
    releaseList: () => {
      released = true;
      for (const response of waiting) list(response);
      waiting.clear();
    },
    snapshot: () => ({
      lists,
      started,
      closed,
      activeWatches: watches.size,
      pendingLists: waiting.size,
    }),
    close: async () => {
      for (const response of [...waiting, ...watches]) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
