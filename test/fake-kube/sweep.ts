import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Resource {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
}
/** Disposable loopback API boundary, not Kubernetes admission or garbage collection. */
export const startSweepKube = async (namespace: string) => {
  const secrets = new Map<string, Resource>();
  const jobs = new Map<string, Resource>();
  const watches = new Map<string, Set<ServerResponse>>();
  const requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    body?: unknown;
  }[] = [];
  const aborted: string[] = [];
  let pageSize = 1000;
  const continuations = new Map<string, { items: Resource[]; offset: number }>();
  let sequence = 0;
  let failure = 0;
  let hang: "list" | "delete" | undefined;
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const secretPath = `/api/v1/namespaces/${namespace}/secrets`;
  const jobPath = `/apis/batch/v1/namespaces/${namespace}/jobs`;
  const podPath = `/api/v1/namespaces/${namespace}/pods`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://krun-test-p410.invalid");
    const record: (typeof requests)[number] = {
      method: req.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    requests.push(record);
    if (req.method === "GET" && [jobPath, podPath].includes(url.pathname)) {
      const resource = url.pathname === jobPath ? "jobs" : "pods";
      if (url.searchParams.has("watch")) {
        res.writeHead(200, { "content-type": "application/json" });
        // Flush headers without injecting an invalid empty watch event.
        res.flushHeaders();
        let values = watches.get(resource);
        if (values === undefined) {
          values = new Set();
          watches.set(resource, values);
        }
        values.add(res);
        res.on("close", () => values.delete(res));
        if (["jobs", "pods"].every((key) => (watches.get(key)?.size ?? 0) > 0)) readyResolve();
        return;
      }
      json(res, {
        apiVersion: resource === "jobs" ? "batch/v1" : "v1",
        kind: resource === "jobs" ? "JobList" : "PodList",
        metadata: { resourceVersion: "1" },
        items: resource === "jobs" ? [...jobs.values()] : [],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === secretPath) {
      if (hang === "list") {
        res.on("close", () => aborted.push("list"));
        return;
      }
      // Kubernetes continuation pages read one consistent LIST snapshot even
      // when the client deletes objects while consuming it.
      const cursor = url.searchParams.get("continue");
      const snapshot =
        cursor === null
          ? {
              items: [...secrets.values()].filter(
                (s) => s.metadata?.labels?.["krun.io/run-id"] !== undefined,
              ),
              offset: 0,
            }
          : continuations.get(cursor);
      if (snapshot === undefined) {
        json(res, { code: 410 }, 410);
        return;
      }
      const items = snapshot.items.slice(snapshot.offset, snapshot.offset + pageSize);
      const more = snapshot.offset + pageSize < snapshot.items.length;
      const next = String(++sequence);
      if (more)
        continuations.set(next, { items: snapshot.items, offset: snapshot.offset + pageSize });
      json(res, {
        apiVersion: "v1",
        kind: "SecretList",
        metadata: {
          ...(more ? { continue: next } : {}),
        },
        items,
      });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith(secretPath + "/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks).toString("utf8");
      record.body = bytes.length ? JSON.parse(bytes) : {};
      if (hang === "delete") {
        res.on("close", () => aborted.push("delete"));
        return;
      }
      if (failure) {
        const status = failure;
        failure = 0;
        json(
          res,
          { kind: "Status", code: status, message: "krun-test-p410-private-status" },
          status,
        );
        return;
      }
      const name = decodeURIComponent(url.pathname.slice(secretPath.length + 1));
      const current = secrets.get(name);
      if (current === undefined) {
        json(res, { code: 404 }, 404);
        return;
      }
      const body = record.body as { preconditions?: { uid?: string; resourceVersion?: string } };
      if (
        body.preconditions?.uid !== current.metadata?.uid ||
        body.preconditions?.resourceVersion !== current.metadata?.resourceVersion
      ) {
        json(res, { code: 409 }, 409);
        return;
      }
      secrets.delete(name);
      json(res, { kind: "Status", status: "Success" });
      return;
    }
    json(res, { code: 404 }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ready,
    requests,
    secrets,
    jobs,
    aborted,
    setPageSize: (value: number) => {
      pageSize = value;
    },
    failNextDelete: (status: number) => {
      failure = status;
    },
    hang: (value: typeof hang) => {
      hang = value;
    },
    emitJob: (phase: "ADDED" | "MODIFIED" | "DELETED", job: Resource) => {
      const name = job.metadata?.name;
      if (name !== undefined) {
        if (phase === "DELETED") jobs.delete(name);
        else jobs.set(name, job);
      }
      for (const response of watches.get("jobs") ?? [])
        response.write(
          JSON.stringify({ type: phase, object: { apiVersion: "batch/v1", kind: "Job", ...job } }) +
            "\n",
        );
    },
    close: async () => {
      for (const values of watches.values()) for (const response of values) response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
