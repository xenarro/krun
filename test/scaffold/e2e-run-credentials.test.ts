import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { runCredentials } from "../e2e/lib/run-credentials.js";

const fn = "krun-test-privacy";
const id = "0192f000-0000-7000-8000-000000000001";
const resource = `functions/${fn}/runs/${id}`;
const token = () => randomBytes(32).toString("base64url");
const secret = (value: string) => ({
  metadata: {
    name: `krun-${id}`,
    namespace: "krun-jobs",
    uid: "owned-uid",
    resourceVersion: "opaque-version",
    labels: {
      "krun.io/function": fn,
      "krun.io/run-id": id,
      "krun.io/created-by": "e2e",
      "app.kubernetes.io/managed-by": "krun",
    },
  },
  immutable: true,
  type: "Opaque",
  data: { token: Buffer.from(value).toString("base64") },
});
it("retains a pre-response Secret event and binds only the actual submitted Run", () => {
  const value = token();
  const forbidden = new Set<string>();
  const witness = runCredentials(fn, forbidden);
  witness.observe(secret(value));
  expect(witness.ready(resource)).toBe(false);
  expect(forbidden.has(value)).toBe(false);
  witness.bind(resource);
  expect(witness.ready(resource)).toBe(true);
  expect(forbidden.has(value)).toBe(true);
});
it("requires a positive credential observation after binding", () => {
  const value = token();
  const forbidden = new Set<string>();
  const witness = runCredentials(fn, forbidden);
  witness.bind(resource);
  expect(witness.ready(resource)).toBe(false);
  witness.observe(secret(value));
  expect(witness.ready(resource)).toBe(true);
  expect(forbidden.has(value)).toBe(true);
});
it("keeps captured values until explicit teardown and clears only its own entries", () => {
  const value = token();
  const marker = randomBytes(24).toString("hex");
  const forbidden = new Set([marker]);
  const witness = runCredentials(fn, forbidden);
  witness.bind(resource);
  witness.observe(secret(value));
  witness.clear();
  expect(witness.ready(resource)).toBe(false);
  expect(forbidden.has(value)).toBe(false);
  expect(forbidden.has(marker)).toBe(true);
});
it("rejects foreign or unfenced Secret metadata without echoing private values", () => {
  for (const change of [
    { namespace: "foreign" },
    { name: "foreign" },
    { uid: "" },
    { resourceVersion: "" },
    { labels: { "krun.io/function": "foreign" } },
    { labels: { ...secret("").metadata.labels, "krun.io/created-by": "foreign" } },
  ]) {
    const value = token();
    const forbidden = new Set<string>();
    const witness = runCredentials(fn, forbidden);
    witness.bind(resource);
    const original = secret(value);
    const object = { ...original, metadata: { ...original.metadata, ...change } };
    const message = (() => {
      try {
        witness.observe(object);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).not.toBe("accepted");
    expect(message.includes(value)).toBe(false);
    expect(forbidden.size).toBe(0);
  }
});
it("rejects noncanonical or malformed encoded credentials", () => {
  for (const value of ["bad@base64", Buffer.from("short").toString("base64")]) {
    const witness = runCredentials(fn, new Set());
    const object = secret(token());
    object.data.token = value;
    expect(() => witness.observe(object)).toThrow("Invalid owned Run credential witness");
  }
});
it("rejects a replaced Secret identity rather than accepting a different credential", () => {
  const witness = runCredentials(fn, new Set());
  witness.bind(resource);
  const value = token();
  witness.observe(secret(value));
  const replacement = secret(value);
  replacement.metadata.uid = "different-uid";
  expect(() => witness.observe(replacement)).toThrow("Changed owned Run credential identity");
});
it("rejects another function's Run resource without normalizing its identifier", () => {
  const witness = runCredentials(fn, new Set());
  expect(() => witness.bind(`functions/foreign/runs/${id}`)).toThrow(
    "Foreign Run credential binding",
  );
  expect(() => witness.bind(resource.toUpperCase())).toThrow("Foreign Run credential binding");
});
