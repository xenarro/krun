import { expect, it } from "vitest";
import { ownedRecoveryResource } from "../e2e/lib/recovery.js";

const identity = {
  kind: "Pod" as const,
  name: "krun-test-owned-resource",
  namespace: "krun-test-embedded",
  owner: "a".repeat(16),
  invocation: "b".repeat(32),
};
const fixture = (kind: "Pod" | "Secret" = "Pod") => {
  let live: unknown;
  const deleted: string[] = [];
  const io = {
    create(value: unknown) {
      live = {
        ...(value as object),
        metadata: { ...(value as { metadata: object }).metadata, uid: "uid-one" },
      };
    },
    read(): unknown {
      return live;
    },
    delete(uid: string) {
      deleted.push(uid);
      live = undefined;
    },
  };
  const resource = ownedRecoveryResource({ ...identity, kind }, io);
  const object = {
    apiVersion: "v1",
    kind,
    metadata: { name: identity.name, namespace: identity.namespace },
  };
  return {
    io,
    resource,
    object,
    deleted,
    live: () => live,
    replace: (value: unknown) => {
      live = value;
    },
  };
};
it("does not inspect or delete a resource with no create intent", async () => {
  const f = fixture();
  f.io.read = () => {
    throw new Error("Unexpected read");
  };
  await f.resource.remove();
  expect(f.deleted).toEqual([]);
});
it("binds invocation/checkout ownership before create and fences deletion to observed UID", async () => {
  const f = fixture();
  f.resource.create(f.object);
  expect(f.live()).toMatchObject({
    metadata: {
      labels: {
        "krun.io/e2e-owner": identity.owner,
        "krun.io/e2e-recovery-invocation": identity.invocation,
      },
      uid: "uid-one",
    },
  });
  await f.resource.remove();
  expect(f.deleted).toEqual(["uid-one"]);
  expect(f.live()).toBeUndefined();
});
it.each(["Pod", "Secret"] as const)(
  "reconciles a committed %s whose create acknowledgement was lost",
  async (kind) => {
    const f = fixture(kind);
    const create = f.io.create;
    f.io.create = (value) => {
      create(value);
      throw new Error("Lost acknowledgement");
    };
    expect(() => f.resource.create(f.object)).toThrow();
    await f.resource.remove();
    expect(f.deleted).toEqual(["uid-one"]);
    expect(f.live()).toBeUndefined();
  },
);
it.each(["Pod", "Secret"] as const)(
  "does not treat absent reads as resolution of an unacknowledged %s create",
  async (kind) => {
    const f = fixture(kind);
    f.io.create = () => {
      throw new Error("Unknown outcome");
    };
    expect(() => f.resource.create(f.object)).toThrow();
    await expect(f.resource.remove()).rejects.toThrow();
    expect(f.deleted).toEqual([]);
  },
);
it.each(["Pod", "Secret"] as const)("never adopts/deletes a colliding foreign %s", async (kind) => {
  const f = fixture(kind);
  f.replace({
    ...f.object,
    metadata: {
      ...f.object.metadata,
      uid: "foreign",
      labels: {
        "krun.io/e2e-owner": identity.owner,
        "krun.io/e2e-recovery-invocation": "c".repeat(32),
      },
    },
  });
  f.io.create = () => {
    throw new Error("Already exists");
  };
  expect(() => f.resource.create(f.object)).toThrow();
  await expect(f.resource.remove()).rejects.toThrow();
  expect(f.deleted).toEqual([]);
});
it("rejects replacement UID even when the replacement copies invocation labels", async () => {
  const f = fixture();
  f.resource.create(f.object);
  const existing = f.live() as { metadata: object };
  f.replace({ ...existing, metadata: { ...existing.metadata, uid: "replacement" } });
  await expect(f.resource.remove()).rejects.toThrow();
  expect(f.deleted).toEqual([]);
});
it("does not qualify cleanup when deletion fails and the resource remains", async () => {
  const f = fixture();
  f.resource.create(f.object);
  f.io.delete = () => {
    throw new Error("Delete failed");
  };
  await expect(f.resource.remove()).rejects.toThrow();
  expect(f.live()).toBeDefined();
});
it("reconciles lost delete acknowledgement by positive absence", async () => {
  const f = fixture();
  f.resource.create(f.object);
  const remove = f.io.delete;
  f.io.delete = (uid) => {
    remove(uid);
    throw new Error("Lost delete acknowledgement");
  };
  await f.resource.remove();
  expect(f.live()).toBeUndefined();
});
it("never turns failed ownership/absence reads into successful cleanup", async () => {
  const f = fixture();
  f.resource.create(f.object);
  f.io.read = () => {
    throw new Error("Read unavailable");
  };
  await expect(f.resource.remove()).rejects.toThrow();
  expect(f.deleted).toEqual([]);
});
