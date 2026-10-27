import { createServer, type ServerResponse } from "node:http";

type Resource = "jobs" | "pods";
type Document = { readonly metadata?: { readonly name?: string } };

/** Owned loopback API, not Kubernetes admission. Bodies never enter diagnostics. */
export const startFailureKube = async (namespace: string) => {
  if (!namespace.startsWith("krun-test-")) throw new Error("Owned test namespace required");
  const objects = { jobs: new Map<string, Document>(), pods: new Map<string, Document>() };
  const watches = { jobs: new Set<ServerResponse>(), pods: new Set<ServerResponse>() };
  const requests: string[] = [];
  let resourceVersion = 0;
  let logOptions = { status: 200, text: "krun-test-p48-private-native-tail", hold: false };
  let logs = 0;
  let abortedLogs = 0;
  let readyResolve = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let enteredResolve = () => {};
  const logEntered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let closedResolve = () => {};
  const logClosed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://krun-test.invalid");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const jobsPath = `/apis/batch/v1/namespaces/${namespace}/jobs`;
    const podsPath = `/api/v1/namespaces/${namespace}/pods`;
    if (req.method === "GET" && [jobsPath, podsPath].includes(url.pathname)) {
      const resource = url.pathname === jobsPath ? "jobs" : "pods";
      if (url.searchParams.get("labelSelector") !== "krun.io/run-id") {
        res.writeHead(400).end();
        return;
      }
      if (url.searchParams.get("watch") === "true") {
        watches[resource].add(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.once("close", () => watches[resource].delete(res));
        if (watches.jobs.size && watches.pods.size) readyResolve();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            apiVersion: resource === "jobs" ? "batch/v1" : "v1",
            kind: resource === "jobs" ? "JobList" : "PodList",
            metadata: { resourceVersion: String(resourceVersion) },
            items: [...objects[resource].values()],
          }),
        );
      }
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith(`${podsPath}/`) &&
      url.pathname.endsWith("/log")
    ) {
      logs++;
      if (
        url.searchParams.get("container") !== "function" ||
        url.searchParams.get("tailLines") !== "100" ||
        url.searchParams.get("limitBytes") !== "16384"
      ) {
        res.writeHead(400).end();
        return;
      }
      if (logOptions.hold) {
        res.once("close", () => {
          abortedLogs++;
          closedResolve();
        });
        enteredResolve();
      } else if (logOptions.status === 200) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(logOptions.text);
        enteredResolve();
      } else {
        res.writeHead(logOptions.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ kind: "Status", code: logOptions.status, message: "Owned log failure" }),
        );
        enteredResolve();
      }
      return;
    }
    if (
      req.method === "DELETE" &&
      (url.pathname.startsWith(`${jobsPath}/`) ||
        url.pathname.startsWith(`/api/v1/namespaces/${namespace}/secrets/`))
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kind: "Status", status: "Success" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "Status", code: 404 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned failure API unavailable");
  return {
    address: `http://127.0.0.1:${address.port}`,
    ready,
    logEntered,
    logClosed,
    setLog: (options: Partial<typeof logOptions>) => {
      logOptions = { ...logOptions, ...options };
    },
    emit: (resource: Resource, type: "ADDED" | "MODIFIED" | "DELETED", object: Document) => {
      const name = object.metadata?.name;
      if (!name) throw new Error("Owned event requires a name");
      const observed = {
        ...object,
        metadata: { ...object.metadata, resourceVersion: String(++resourceVersion) },
      };
      if (type === "DELETED") objects[resource].delete(name);
      else objects[resource].set(name, observed);
      for (const watch of watches[resource])
        watch.write(`${JSON.stringify({ type, object: observed })}\n`);
    },
    snapshot: () => ({
      requests: [...requests],
      logs,
      abortedLogs,
      watches: watches.jobs.size + watches.pods.size,
    }),
    close: async () => {
      for (const watch of [...watches.jobs, ...watches.pods]) watch.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
