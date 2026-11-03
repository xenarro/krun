import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";

const manifest = parse(readFileSync(new URL("../e2e/minio-init.yaml", import.meta.url), "utf8"));
const source = manifest.spec.template.spec.containers[0].args[0].replace(/^\s*import .*;$/m, "");

it.each([true, false])(
  "requires positive client-side readiness before S3 calls (recovers=%s)",
  async (recovers) => {
    const calls: string[] = [];
    let attempts = 0;
    class S3Client {
      async send() {
        calls.push("head");
      }
      destroy() {
        calls.push("destroy");
      }
    }
    const process = {
      env: {},
      exitCode: 0,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };
    await runInNewContext(`(async () => {${source}})()`, {
      S3Client,
      HeadBucketCommand: class {},
      CreateBucketCommand: class {},
      process,
      AbortSignal,
      fetch: async () => {
        attempts++;
        calls.push("ready");
        if (attempts === 1) throw new Error("Private transport detail must not be logged");
        return {
          status: recovers && attempts === 3 ? 200 : 503,
          body: { cancel: async () => calls.push("drain") },
        };
      },
      setTimeout: (resolve: () => void) => resolve(),
    });
    expect(attempts).toBe(recovers ? 3 : 10);
    expect(calls.at(-1)).toBe("destroy");
    expect(calls.filter((call) => call === "head")).toHaveLength(recovers ? 1 : 0);
    expect(calls.filter((call) => call === "drain")).toHaveLength(attempts - 1);
    expect(process.exitCode).toBe(recovers ? 0 : 1);
  },
);

it.each(["existing", "missing", "denied", "unavailable"])(
  "runs the initializer script without treating %s as a missing bucket",
  async (mode) => {
    const calls: string[] = [];
    class HeadBucketCommand {
      operation = "head";
    }
    class CreateBucketCommand {
      operation = "create";
    }
    class S3Client {
      async send(command: { operation: string }) {
        calls.push(command.operation);
        if (command.operation === "head" && mode !== "existing")
          throw {
            $metadata: { httpStatusCode: mode === "missing" ? 404 : mode === "denied" ? 403 : 503 },
          };
        if (command.operation === "create" && mode === "existing")
          throw { $metadata: { httpStatusCode: 409 } };
      }
      destroy() {
        calls.push("destroy");
      }
    }
    const process = {
      env: {},
      exitCode: 0,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };
    await runInNewContext(`(async () => {${source}})()`, {
      S3Client,
      HeadBucketCommand,
      CreateBucketCommand,
      process,
      AbortSignal,
      fetch: async () => {
        calls.push("ready");
        return { status: 200, body: { cancel: async () => {} } };
      },
      setTimeout: (resolve: () => void) => resolve(),
    });
    expect(calls).toEqual(
      mode === "missing" ? ["ready", "head", "create", "destroy"] : ["ready", "head", "destroy"],
    );
    expect(process.exitCode).toBe(mode === "denied" || mode === "unavailable" ? 1 : 0);
    expect(manifest.spec.activeDeadlineSeconds).toBe(90);
  },
);
