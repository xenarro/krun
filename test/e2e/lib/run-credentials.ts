import { z } from "zod";

const runId = z.uuidv7().refine((value) => value === value.toLowerCase());
const ownedSecret = (namespace: string) =>
  z.object({
    metadata: z.object({
      name: z.string(),
      namespace: z.literal(namespace),
      uid: z.string().min(1),
      resourceVersion: z.string().min(1),
      labels: z.object({
        "krun.io/function": z.string(),
        "krun.io/run-id": runId,
        "krun.io/created-by": z.literal("e2e"),
        "app.kubernetes.io/managed-by": z.literal("krun"),
      }),
    }),
    immutable: z.literal(true),
    type: z.literal("Opaque"),
    data: z.object({ token: z.string() }),
  });

// These values must never leave this test process,including error diagnostics.
// WATCH can precede the CreateRun response;bind only that actual response's ID.
export const runCredentials = (
  functionName: string,
  forbidden: Set<string>,
  namespace = "krun-jobs",
) => {
  const schema = ownedSecret(namespace);
  const observed = new Map<string, { uid: string; token: string }>();
  const bound = new Set<string>();
  const identity = (resource: string) => {
    const prefix = `functions/${functionName}/runs/`;
    const id = resource.slice(prefix.length);
    if (!resource.startsWith(prefix) || !runId.safeParse(id).success)
      throw new Error("Foreign Run credential binding");
    return id;
  };
  return {
    observe(value: unknown) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new Error("Invalid owned Run credential witness");
      const secret = parsed.data;
      const id = secret.metadata.labels["krun.io/run-id"];
      if (
        secret.metadata.labels["krun.io/function"] !== functionName ||
        secret.metadata.name !== `krun-${id}`
      )
        throw new Error("Invalid owned Run credential witness");
      const bytes = Buffer.from(secret.data.token, "base64");
      const token = bytes.toString("utf8");
      if (
        bytes.toString("base64") !== secret.data.token ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        Buffer.from(token, "base64url").length !== 32 ||
        Buffer.from(token, "base64url").toString("base64url") !== token
      )
        throw new Error("Invalid owned Run credential witness");
      const previous = observed.get(id);
      if (previous && (previous.uid !== secret.metadata.uid || previous.token !== token))
        throw new Error("Changed owned Run credential identity");
      observed.set(id, { uid: secret.metadata.uid, token });
      if (bound.has(id)) forbidden.add(token);
    },
    bind(resource: string) {
      const id = identity(resource);
      bound.add(id);
      const secret = observed.get(id);
      if (secret) forbidden.add(secret.token);
    },
    ready(resource: string) {
      const id = identity(resource);
      return bound.has(id) && observed.has(id);
    },
    clear() {
      for (const secret of observed.values()) forbidden.delete(secret.token);
      observed.clear();
      bound.clear();
    },
  };
};
