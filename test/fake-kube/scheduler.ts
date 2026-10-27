import { createServer, type ServerResponse } from "node:http";

/** Owned loopback process boundary, never a Kubernetes context or admission test. */
export const startSchedulerKube = async (
  namespace: string,
  standby = false,
  holdFunctions = false,
) => {
  const watches = new Map<string, Set<ServerResponse>>();
  const waiting = new Set<ServerResponse>();
  const events: string[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  let functionsReleased = !holdFunctions;
  let version = 1;
  let holder = standby ? "krun-test-other-scheduler" : "";
  let stolen = false;
  let holdJobs = false;
  const jobLists = new Set<ServerResponse>();
  const fn = {
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
      image: `example.invalid/function@sha256:${"a".repeat(64)}`,
      inputSchema: { type: "object" },
    },
  };
  const lease = () => ({
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: { name: "krun-scheduler", namespace, resourceVersion: String(version) },
    spec: {
      holderIdentity: holder,
      leaseDurationSeconds: 15,
      renewTime: new Date(1_700_000_000_000 + version).toISOString(),
    },
  });
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const list = (res: ServerResponse, resource: string) =>
    json(res, {
      apiVersion:
        resource === "functions" ? "krun.io/v1alpha1" : resource === "jobs" ? "batch/v1" : "v1",
      kind: `${resource === "functions" ? "Function" : resource === "jobs" ? "Job" : resource === "pods" ? "Pod" : "Secret"}List`,
      metadata: { resourceVersion: String(version) },
      items:
        resource === "functions"
          ? [fn]
          : resource === "jobs"
            ? [...jobs.values()]
            : resource === "secrets"
              ? [...secrets.values()]
              : [],
    });
  const emit = (resource: string, type: string, object: unknown) => {
    for (const res of watches.get(resource) ?? [])
      res.write(`${JSON.stringify({ type, object })}\n`);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://krun-test-p411.invalid");
    const parts = url.pathname.split("/");
    const index = parts.indexOf("namespaces");
    const resource = parts[index + 2] ?? "";
    const name = parts[index + 3];
    if (index < 0 || parts[index + 1] !== namespace) {
      json(res, {}, 404);
      return;
    }
    events.push(`${req.method} ${resource}${name ? `/${name}` : ""}`);
    if (resource === "leases") {
      if (req.method === "GET") {
        if (standby || stolen) version++;
        json(res, lease());
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as {
        metadata?: { resourceVersion?: string };
        spec?: { holderIdentity?: string };
      };
      if (req.method === "PUT" && body.metadata?.resourceVersion !== String(version)) {
        json(res, {}, 409);
        return;
      }
      holder = body.spec?.holderIdentity ?? "";
      version++;
      if (holder === "")
        events.push(
          `lease-cleared:watches=${[...watches.values()].reduce((n, set) => n + set.size, 0)}`,
        );
      json(res, lease());
      return;
    }
    if (req.method === "GET" && !name) {
      if (url.searchParams.get("watch") === "true") {
        const set = watches.get(resource) ?? new Set<ServerResponse>();
        watches.set(resource, set);
        set.add(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.once("close", () => {
          set.delete(res);
          events.push(`watch-closed:${resource}`);
        });
      } else if (resource === "functions" && !functionsReleased) {
        waiting.add(res);
        res.once("close", () => waiting.delete(res));
      } else if (holdJobs && (resource === "jobs" || resource === "pods")) {
        jobLists.add(res);
        res.once("close", () => jobLists.delete(res));
      } else list(res, resource);
      return;
    }
    if (resource === "functions" && req.method === "PATCH") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as { status: unknown };
      version++;
      Object.assign(fn, { status: body.status });
      fn.metadata.resourceVersion = String(version);
      json(res, fn);
      emit("functions", "MODIFIED", fn);
      return;
    }
    const map = resource === "jobs" ? jobs : secrets;
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as Record<string, unknown> & {
        metadata: { name: string; labels?: Record<string, string> };
      };
      if (map.has(body.metadata.name)) {
        json(res, { reason: "AlreadyExists" }, 409);
        return;
      }
      version++;
      body.metadata = {
        ...body.metadata,
        ...{
          namespace,
          uid: `krun-test-${version}`,
          resourceVersion: String(version),
          creationTimestamp: new Date().toISOString(),
        },
      };
      map.set(body.metadata.name, body);
      json(res, body, 201);
      emit(resource, "ADDED", body);
      return;
    }
    if (req.method === "DELETE" && name) {
      const item = map.get(name);
      map.delete(name);
      json(res, {});
      if (item) emit(resource, "DELETED", item);
      return;
    }
    json(res, {}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned scheduler fixture unavailable");
  return {
    address: `http://127.0.0.1:${address.port}`,
    events,
    releaseFunctions: () => {
      functionsReleased = true;
      for (const res of waiting) list(res, "functions");
      waiting.clear();
    },
    holdJobLists: () => {
      holdJobs = true;
    },
    releaseJobLists: () => {
      holdJobs = false;
      for (const res of jobLists) {
        const path = res.req.url ?? "";
        list(res, path.includes("/jobs") ? "jobs" : "pods");
      }
      jobLists.clear();
    },
    snapshot: () => ({
      holder,
      jobs: jobs.size,
      secrets: secrets.size,
      watches: [...watches.values()].reduce((n, set) => n + set.size, 0),
      events: [...events],
    }),
    complete: () => {
      for (const job of jobs.values()) {
        Object.assign(job.metadata as Record<string, unknown>, {
          resourceVersion: String(++version),
        });
        Object.assign(job, {
          status: {
            conditions: [{ type: "Complete", status: "True" }],
            startTime: new Date().toISOString(),
          },
        });
        emit("jobs", "MODIFIED", job);
      }
    },
    steal: () => {
      holder = "krun-test-other-scheduler";
      stolen = true;
      version++;
    },
    close: async () => {
      for (const res of [
        ...waiting,
        ...jobLists,
        ...[...watches.values()].flatMap((set) => [...set]),
      ])
        res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
