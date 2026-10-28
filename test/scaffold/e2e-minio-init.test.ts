import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";

const manifest = parse(readFileSync(new URL("../e2e/minio-init.yaml", import.meta.url), "utf8"));
const source = manifest.spec.template.spec.containers[0].args[0].replace(/^\s*import .*;$/m, "");

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
    });
    expect(calls).toEqual(mode === "missing" ? ["head", "create", "destroy"] : ["head", "destroy"]);
    expect(process.exitCode).toBe(mode === "denied" || mode === "unavailable" ? 1 : 0);
    expect(manifest.spec.activeDeadlineSeconds).toBe(90);
  },
);
