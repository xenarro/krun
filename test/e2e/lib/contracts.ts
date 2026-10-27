import { isAbsolute } from "node:path";
import { z } from "zod";

export const contextArgs = (kubeconfig: string) => {
  if (!isAbsolute(kubeconfig)) throw new Error("E2E kubeconfig must be an absolute owned path");
  return ["--kubeconfig", kubeconfig, "--context", "kind-krun-test-e2e"];
};

export const parsePushDigest = (output: string) => {
  const matches = [...output.matchAll(/^e2e: digest: (sha256:[a-f0-9]{64}) size: \d+\s*$/gm)];
  if (matches.length !== 1 || !matches[0]?.[1])
    throw new Error("Missing unique local push digest acknowledgement");
  return matches[0][1];
};

export const probeVerdict = (result: { code: number | null; stdout: string }) => {
  if (result.code === 0 && result.stdout.trim() === "krun-probe-open") return "open";
  if (result.code === 28 && result.stdout.trim() === "krun-probe-blocked") return "blocked";
  throw new Error("Network probe failed without a valid connection outcome");
};

const registrySchema = z.object({
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  HostConfig: z.object({
    PortBindings: z.object({
      "5000/tcp": z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).length(1),
    }),
  }),
});
export const assertRegistryOwner = (value: unknown, owner: string) => {
  const parsed = registrySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.Config.Labels["krun.io/e2e-owner"] !== owner ||
    parsed.data.HostConfig.PortBindings["5000/tcp"][0]?.HostIp !== "127.0.0.1" ||
    parsed.data.HostConfig.PortBindings["5000/tcp"][0]?.HostPort !== "5001"
  )
    throw new Error("Refusing an unowned or differently bound kind-registry");
};
