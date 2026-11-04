import { z } from "zod";

const modeSchema = z.enum(["embedded", "postgres"]);
const text = z.string().min(1);
export const quickstartSettings = (mode: string, env: NodeJS.ProcessEnv) => {
  const database = modeSchema.parse(mode);
  const cli = text.parse(env.KRUN_CLI ?? "npx @krun/cli");
  // An executable plus whitespace-separated arguments, never a shell program.
  // Use an executable wrapper for paths/arguments containing spaces.
  if (!/^[\w@./:+-]+(?: +[\w@./:+-]+)*$/.test(cli))
    throw new Error("KRUN_CLI must be an executable and plain arguments, not shell syntax");
  const reference = env.KRUN_IMAGE;
  let image: { repository: string; tag: string } | undefined;
  if (reference !== undefined) {
    const cut = reference.lastIndexOf(":");
    if (
      !/^[\w./:-]+$/.test(reference) ||
      cut <= reference.lastIndexOf("/") ||
      cut === reference.length - 1
    )
      throw new Error("KRUN_IMAGE must be repository:tag without credentials or a digest");
    const repository = reference.slice(0, cut);
    const tag = reference.slice(cut + 1);
    if (
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
        repository,
      ) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)
    )
      throw new Error("KRUN_IMAGE must contain a valid repository and tag");
    image = { repository, tag };
  }
  const registry = env.KRUN_REGISTRY ?? "localhost:5001";
  const chart = text.parse(env.KRUN_CHART ?? "oci://ghcr.io/xenarro/charts/krun");
  if (chart.startsWith("-") || /[\r\n\t]/.test(chart))
    throw new Error("KRUN_CHART must be a chart reference or path, not an option");
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(chart) && !URL.canParse(chart))
    throw new Error("Invalid chart URL");
  if (URL.canParse(chart)) {
    const url = new URL(chart);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Chart URLs must not contain credentials, query strings or fragments");
  }
  if (registry !== "localhost:5001")
    throw new Error("This disposable kind demo publishes only to localhost:5001");
  return {
    mode: database,
    chart,
    cli: cli.split(/ +/),
    image,
    vendor: env.KRUN_SDK_VENDOR === undefined ? undefined : text.parse(env.KRUN_SDK_VENDOR),
    registry,
    namespace: `krun-test-quickstart-${database}`,
    jobsNamespace: `krun-test-quickstart-${database}-jobs`,
    name: `krun-test-quickstart-${database}`,
  };
};
export const quickstartValues = (settings: ReturnType<typeof quickstartSettings>) => ({
  ...(settings.image === undefined ? {} : { image: settings.image }),
  db: { mode: settings.mode, postgres: { existingSecret: "krun-test-postgres" } },
  apiKeys: { existingSecret: "krun-test-quickstart-keys" },
  gateway: { replicas: settings.mode === "embedded" ? 1 : 2 },
  scheduler: { replicas: 1 },
  config: { allowedRegistries: settings.registry },
  crds: { install: true, keep: false },
  jobsNamespace: { name: settings.jobsNamespace, keep: false },
});
