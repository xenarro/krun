import { createServer, type ServerResponse } from "node:http";

interface WireObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  status?: { phase?: string; conditions?: Array<{ type: string; status: string }> };
}

// Native HTTP boundary, not a mocked Kube service. Only owned namespaces exist.
export const startJobKube = async (namespace: string) => {
  const jobs = new Map<string, WireObject>();
  const pods = new Map<string, WireObject>();
  const secrets = new Map<string, unknown>();
  const watches = new Map<string, Set<ServerResponse>>();
  const calls: string[] = [];
  let revision = 1;
  let resolveWatching = () => {};
  const watching = new Promise<void>((resolve) => {
    resolveWatching = resolve;
  });
  const emit = (resource: string, type: string, object: WireObject | WireObject) => {
    const event = {
      ...object,
      metadata: { ...object.metadata, resourceVersion: String(++revision) },
    };
    for (const response of watches.get(resource) ?? [])
      response.write(`${JSON.stringify({ type, object: event })}\n`);
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://krun-test.invalid");
    const prefix = url.pathname.startsWith("/apis/batch/v1/") ? "/apis/batch/v1" : "/api/v1";
    const path = url.pathname.slice(`${prefix}/namespaces/${namespace}/`.length).split("/");
    const resource = path[0] ?? "";
    const name = path[1];
    if (
      !url.pathname.startsWith(`${prefix}/namespaces/${namespace}/`) ||
      !["jobs", "pods", "secrets"].includes(resource)
    ) {
      response.writeHead(404).end();
      return;
    }
    calls.push(`${request.method} ${resource}`);
    response.setHeader("content-type", "application/json");
    const objects = resource === "jobs" ? jobs : resource === "pods" ? pods : secrets;
    if (request.method === "GET" && url.searchParams.get("watch") === "true") {
      let group = watches.get(resource);
      if (group === undefined) {
        group = new Set();
        watches.set(resource, group);
      }
      group.add(response);
      response.writeHead(200);
      response.flushHeaders();
      response.once("close", () => group.delete(response));
      if (watches.get("jobs")?.size && watches.get("pods")?.size) resolveWatching();
    } else if (request.method === "GET" && name === undefined) {
      response.end(
        JSON.stringify({
          apiVersion: resource === "jobs" ? "batch/v1" : "v1",
          kind: resource === "jobs" ? "JobList" : "PodList",
          metadata: { resourceVersion: String(revision) },
          items: [...objects.values()],
        }),
      );
    } else if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const object = JSON.parse(Buffer.concat(chunks).toString());
      objects.set(object.metadata.name, object);
      if (resource === "jobs") emit(resource, "ADDED", object);
      response.writeHead(201).end(JSON.stringify(object));
    } else if (request.method === "DELETE" && name !== undefined) {
      objects.delete(name);
      response.end(JSON.stringify({ kind: "Status", status: "Success", code: 200 }));
    } else {
      response
        .writeHead(404)
        .end(JSON.stringify({ kind: "Status", reason: "NotFound", code: 404 }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned Job fake unavailable");
  return {
    address: `http://127.0.0.1:${address.port}`,
    watching,
    calls,
    running: (id: string) => {
      const pod: WireObject = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: `krun-${id}-pod`, namespace, labels: { "krun.io/run-id": id } },
        status: { phase: "Running" },
      };
      pods.set(pod.metadata?.name ?? "", pod);
      emit("pods", "ADDED", pod);
    },
    complete: (id: string) => {
      const job = jobs.get(`krun-${id}`);
      if (!job) throw new Error("Owned Job was not created");
      job.status = { conditions: [{ type: "Complete", status: "True" }] };
      emit("jobs", "MODIFIED", job);
    },
    close: async () => {
      for (const group of watches.values()) for (const response of group) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
