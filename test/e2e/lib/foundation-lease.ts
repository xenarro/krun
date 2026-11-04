import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

// Reuse the stock command lock, outside the removable foundation directory.
// A whole workflow holds it before inventory through joined teardown. Child
// commands may borrow its private capability, but cannot release the owner.
// Never infer stale ownership or steal a busy lock from a peer.
export const acquireFoundationLease = async (path: string, inherited?: string) => {
  const ticket = `${path}/owner`;
  if (inherited !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(inherited) || (await readFile(ticket, "utf8")) !== inherited)
      throw new Error("E2E foundation lease is busy or invalid");
    return { token: inherited, release: async () => {} };
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    throw new Error("E2E foundation lease is busy or invalid");
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(ticket, token, { flag: "wx", mode: 0o600 });
  } catch {
    await rm(path, { recursive: true });
    throw new Error("E2E foundation lease initialization failed");
  }
  let released = false;
  return {
    token,
    release: async () => {
      if (released) return;
      if ((await readFile(ticket, "utf8")) !== token)
        throw new Error("Refusing to release a foreign foundation lease");
      await rm(path, { recursive: true });
      released = true;
    },
  };
};
