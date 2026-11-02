import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  functionMetadataSchema,
  functionReadyReasonSchema,
} from "@krun/shared/dist/functions/schema.js";
import { Effect, Schedule } from "effect";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  DeployEnvironment,
  DeployFiles,
  DeployPrompt,
  DeployTerminal,
  Docker,
  deployFailure,
  Kubectl,
} from "./deploy-services.js";
import { validatePaths } from "./validate-functions.js";

const usage =
  "Usage: krun deploy [--no-apply] [--namespace <ns>] [--api-url <url>] [--registry <registry>] [dir]\nDefaults: KRUN_NAMESPACE (krun), KRUN_API_URL, KRUN_REGISTRY. KRUN_JOBS_NAMESPACE (krun-jobs) selects the printed logs namespace. Flags override environment. --no-apply builds/pushes/pins/validates only; no cluster access.";
const label = functionMetadataSchema.shape.name;
const registry = z
  .string()
  .regex(
    /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?)(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/,
  );
const apiUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/\s/.test(value) &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    );
  } catch {
    return false;
  }
});
const optionsSchema = z.strictObject({
  directory: z.string().min(1),
  registry,
  namespace: label,
  jobsNamespace: label,
  apiUrl: apiUrl.optional(),
  noApply: z.boolean(),
});
const identitySchema = z.object({
  apiVersion: z.literal("krun.io/v1alpha1"),
  kind: z.literal("Function"),
  metadata: functionMetadataSchema.extend({ namespace: label.optional() }),
  spec: z.object({ image: z.string() }),
});
const readySchema = z.object({
  metadata: z.object({ generation: z.int().min(1) }),
  status: z
    .object({
      observedGeneration: z.int().min(0).optional(),
      conditions: z
        .array(
          z.object({
            type: z.string(),
            status: z.enum(["True", "False", "Unknown"]),
            reason: functionReadyReasonSchema,
            message: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const imageWithDigest = (reference: string, digest: string) => {
  const repository = reference.split("@")[0] ?? reference;
  const colon = repository.lastIndexOf(":");
  return `${colon > repository.lastIndexOf("/") ? repository.slice(0, colon) : repository}@${digest}`;
};

const progress = <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* DeployTerminal;
      if (terminal.isTTY) {
        const prompt = yield* DeployPrompt;
        yield* Effect.acquireRelease(prompt.start(name), (stop) => Effect.sync(stop));
      } else {
        yield* terminal.output("stderr", name);
        yield* terminal
          .output("stderr", `${name} (still working)`)
          .pipe(
            Effect.repeat(Schedule.spaced("10 seconds")),
            Effect.delay("10 seconds"),
            Effect.forkScoped,
          );
      }
      return yield* work;
    }),
  );

export const waitReady = (name: string, namespace: string) =>
  Effect.gen(function* () {
    const kubectl = yield* Kubectl;
    const terminal = yield* DeployTerminal;
    let last = "no status yet: is the scheduler leader running?";
    const poll = Effect.gen(function* () {
      const raw = yield* kubectl.run(
        ["get", "functions.krun.io", name, "-n", namespace, "-o", "json"],
        terminal.cwd,
      );
      const resource = yield* Effect.try({
        try: () => readySchema.parse(JSON.parse(raw)),
        catch: () =>
          deployFailure(
            "Invalid Function status returned by kubectl.",
            "Check the installed krun CRD and scheduler versions.",
          ),
      });
      const condition = resource.status?.conditions?.find((item) => item.type === "Ready");
      const current = resource.status?.observedGeneration === resource.metadata.generation;
      if (condition)
        last = `Ready=${condition.status}, reason=${condition.reason}${current ? "" : " (previous generation)"}`;
      if (current && condition?.status === "False")
        return yield* deployFailure(
          `Function rejected: ${condition.reason}.`,
          `Run kubectl describe kfn ${name} -n ${namespace} for the validation message.`,
        );
      return current && condition?.status === "True";
    });
    yield* poll.pipe(
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (done) => done }),
      Effect.timeoutOrElse({
        duration: "120 seconds",
        orElse: () =>
          Effect.fail(
            deployFailure(
              `Function was not Ready after 120 seconds: ${last}`,
              `Run kubectl describe kfn ${name} -n ${namespace}.`,
            ),
          ),
      }),
    );
    yield* terminal.output("stderr", "Ready=True (current generation)");
  });

export const deployCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const terminal = yield* DeployTerminal;
    const environment = (yield* DeployEnvironment).values;
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          strict: true,
          allowPositionals: true,
          options: {
            help: { type: "boolean" },
            "no-apply": { type: "boolean" },
            namespace: { type: "string" },
            "api-url": { type: "string" },
            registry: { type: "string" },
          },
        }),
      catch: () => deployFailure("Invalid deploy arguments."),
    });
    if (parsed.values.help) {
      yield* terminal.output("stdout", usage);
      return;
    }
    if (parsed.positionals.length > 1)
      return yield* deployFailure("Deploy accepts at most one directory.");
    const registryValue = parsed.values.registry ?? environment.KRUN_REGISTRY;
    if (!registryValue)
      return yield* deployFailure(
        "A registry is required.",
        "Use krun deploy --registry ghcr.io/<you>, or set KRUN_REGISTRY.",
      );
    const checked = optionsSchema.safeParse({
      directory: parsed.positionals[0] ?? ".",
      registry: registryValue,
      namespace: parsed.values.namespace ?? environment.KRUN_NAMESPACE ?? "krun",
      jobsNamespace: environment.KRUN_JOBS_NAMESPACE ?? "krun-jobs",
      apiUrl: parsed.values["api-url"] ?? environment.KRUN_API_URL,
      noApply: parsed.values["no-apply"] ?? false,
    });
    if (!checked.success)
      return yield* deployFailure(
        "Invalid registry, namespace or API URL.",
        "Use a repository prefix without credentials/scheme/tag, DNS-label namespaces and an HTTP(S) API URL without credentials/query/fragment.",
      );
    const options = checked.data;
    const directory = resolve(terminal.cwd, options.directory);
    const file = join(directory, "function.yaml");
    const fs = yield* DeployFiles;
    const source = yield* fs.read(file);
    const { document, resource } = yield* Effect.try({
      try: () => {
        const documents = parseAllDocuments(source, { logLevel: "silent", prettyErrors: false });
        const document = documents[0];
        if (
          documents.length !== 1 ||
          !document ||
          document.errors.length ||
          document.warnings.length
        )
          throw new Error("Expected one valid document");
        const resource = identitySchema.parse(document.toJS());
        return { document, resource };
      },
      catch: () =>
        deployFailure(
          "function.yaml must contain exactly one valid krun Function with metadata.name and spec.image.",
          "Check function.yaml, or start with krun init.",
        ),
    });
    if (resource.metadata.namespace && resource.metadata.namespace !== options.namespace)
      return yield* deployFailure(
        "function.yaml namespace conflicts with the selected namespace.",
        "Use --namespace matching metadata.namespace, or remove that field.",
      );
    const name = resource.metadata.name;
    const repository = `${options.registry}/${name}`;
    // Docker tags are daemon-wide: never share a mutable build reference between deploys.
    const tag = `${repository}:krun-${yield* Effect.sync(randomUUID)}`;
    const docker = yield* Docker;
    yield* progress(
      "Building function image",
      docker.run(["build", "-t", tag, directory], directory),
    );
    const pushed = yield* progress("Pushing function image", docker.run(["push", tag], directory));
    const digests = new Set(
      [...pushed.matchAll(/\bdigest:\s+(sha256:[a-f0-9]{64})(?=\s|$)/g)].map((match) => match[1]),
    );
    let digest = digests.size === 1 ? [...digests][0] : undefined;
    if (digest === undefined) {
      const inspected = (yield* docker.run(
        ["inspect", "--format", "{{index .RepoDigests 0}}", tag],
        directory,
      )).trim();
      const [inspectedRepository, candidate] = inspected.split("@");
      if (inspectedRepository === repository && candidate && digestPattern.test(candidate))
        digest = candidate;
    }
    if (!digest)
      return yield* deployFailure(
        "Successful push did not identify a digest for this repository.",
        "Inspect docker push output and the repository's RepoDigests, then retry.",
      );
    const image = imageWithDigest(tag, digest);
    document.setIn(["spec", "image"], image);
    if (resource.spec.image !== image) yield* fs.replace(file, source, String(document));
    const validation = yield* validatePaths([file], environment);
    if (validation.ceilingsLine) yield* terminal.output("stderr", validation.ceilingsLine);
    for (const line of [...validation.lines, ...validation.errors])
      yield* terminal.output("stderr", line);
    if (validation.exitCode !== 0)
      return yield* deployFailure(
        "Pinned function.yaml failed krun validate; nothing was applied.",
        "Fix the Function or ceiling configuration, then rerun krun validate function.yaml.",
      );
    if (options.noApply) {
      yield* terminal.output("stdout", image);
      return;
    }
    const kubectl = yield* Kubectl;
    yield* progress(
      "Applying function.yaml",
      kubectl.run(["apply", "-f", file, "-n", options.namespace], directory),
    );
    yield* progress("Waiting for Function Ready", waitReady(name, options.namespace));
    const endpoint = (path: string) =>
      options.apiUrl === undefined
        ? `"\${KRUN_API_URL%/}${path}"`
        : quote(`${options.apiUrl.replace(/\/$/, "")}${path}`);
    const authorization = '-H "Authorization: Bearer $KRUN_API_KEY"';
    yield* terminal.output(
      "stdout",
      [
        "# First run: adjust input to function.yaml's inputSchema.",
        `curl -sS -X POST ${endpoint(`/v1/functions/${name}/runs`)} ${authorization} -H 'Content-Type: application/json' -d '{"input":{"name":"world"}}'`,
        "# Replace <id> with the run id; logs work only while scheduled or running.",
        `kubectl logs -f -n ${quote(options.jobsNamespace)} 'job/krun-<id>'`,
        "# GetRun: logTail contains the last lines of a failed run.",
        `curl -sS ${endpoint(`/v1/functions/${name}/runs/<id>`)} ${authorization}`,
      ].join("\n"),
    );
  });
