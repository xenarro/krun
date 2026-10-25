import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseFunctionCeilings } from "@krun/shared/dist/config/index.js";
import {
  functionImageValidation,
  functionMetadataSchema,
  functionResourceSchema,
  functionSpecSchema,
} from "@krun/shared/dist/functions/schema.js";
import { type FunctionCeilings, validateFunction } from "@krun/shared/dist/functions/validation.js";
import { Data, Effect } from "effect";
import { parseAllDocuments } from "yaml";

class ValidationIOError extends Data.TaggedError("ValidationIOError")<{
  readonly reason: "path" | "directory" | "read" | "yaml";
}> {}

const attempt = <A, E>(work: Effect.Effect<A, E>) =>
  work.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  );
const singleLine = (value: unknown) =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const specFields = new Set(Object.keys(functionSpecSchema.shape));
const ioMessage = {
  path: "cannot read input path",
  directory: "cannot list input directory",
  read: "cannot read input file",
  yaml: "invalid YAML document",
} as const;

const inspectFile = (bytes: Uint8Array, file: string, ceilings: FunctionCeilings) => {
  const lines: string[] = [];
  const errors: string[] = [];
  let count = 0;
  let failed = false;
  const documents = parseAllDocuments(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
    logLevel: "silent",
    prettyErrors: false,
  });
  if ("empty" in documents && (documents.errors.length || documents.warnings.length)) {
    errors.push(`${singleLine(file)}: invalid YAML document`);
    failed = true;
  }
  for (const [index, document] of documents.entries()) {
    if (document.errors.length || document.warnings.length) {
      errors.push(`${singleLine(file)}: document ${index + 1}: invalid YAML document`);
      failed = true;
      continue;
    }
    let value: unknown;
    try {
      value = document.toJS();
    } catch {
      errors.push(`${singleLine(file)}: document ${index + 1}: invalid YAML document`);
      failed = true;
      continue;
    }
    if (!record(value) || value.kind !== "Function") continue;
    count++;
    const metadata = functionMetadataSchema.safeParse(value.metadata);
    const name = metadata.success ? metadata.data.name : `<document ${index + 1}>`;
    const prefix = `${singleLine(file)}: ${name}`;
    const parsed = functionResourceSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      let message = "Function document does not satisfy the CRD schema";
      if (issue?.path[0] === "spec" && issue.path[1] === "image") {
        message =
          record(value.spec) && value.spec.image === "REPLACE_WITH_DIGEST"
            ? "spec.image is REPLACE_WITH_DIGEST; replace it with the deployed image digest"
            : `spec.${functionImageValidation.message}`;
      } else if (
        issue?.path[0] === "spec" &&
        typeof issue.path[1] === "string" &&
        specFields.has(issue.path[1])
      ) {
        message += ` at spec.${issue.path[1]}`;
      }
      lines.push(`FAIL ${prefix}: CRDSchema: ${message}`);
      failed = true;
      continue;
    }
    const result = validateFunction(parsed.data.spec, ceilings);
    if (result.ok) lines.push(`OK ${prefix}`);
    else {
      lines.push(`FAIL ${prefix}: ${result.reason}: ${result.message}`);
      failed = true;
    }
  }
  return { lines, errors, count, failed };
};

/** Shared by the validate entrypoint and future deploy; no cluster/config-file access. */
export const validatePaths = (
  paths: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
) =>
  Effect.gen(function* () {
    const parsed = yield* attempt(parseFunctionCeilings(env));
    if (!parsed.ok)
      return { exitCode: 1, lines: [], errors: [parsed.error.message], ceilingsLine: undefined };
    const config = parsed.value;
    const ceilings: FunctionCeilings = {
      maxQueued: config.KRUN_MAX_QUEUED,
      maxActiveDeadline: config.KRUN_MAX_ACTIVE_DEADLINE,
      allowedRegistries: config.KRUN_ALLOWED_REGISTRIES,
      allowedServiceAccounts: config.KRUN_ALLOWED_SERVICE_ACCOUNTS,
      webhookAllowedHosts: config.KRUN_WEBHOOK_ALLOWED_HOSTS,
    };
    const ceilingsLine = `krun validate ceilings: ${singleLine(config)}`;
    const lines: string[] = [];
    const errors: string[] = [];
    const files = new Set<string>();
    for (const input of paths) {
      const path = resolve(input);
      const info = yield* attempt(
        Effect.tryPromise({
          try: () => stat(path),
          catch: () => new ValidationIOError({ reason: "path" }),
        }),
      );
      if (!info.ok) {
        errors.push(`${singleLine(path)}: ${ioMessage[info.error.reason]}`);
        continue;
      }
      if (info.value.isFile()) files.add(path);
      else if (info.value.isDirectory()) {
        const entries = yield* attempt(
          Effect.tryPromise({
            try: () => readdir(path, { withFileTypes: true }),
            catch: () => new ValidationIOError({ reason: "directory" }),
          }),
        );
        if (!entries.ok) {
          errors.push(`${singleLine(path)}: ${ioMessage[entries.error.reason]}`);
          continue;
        }
        for (const entry of entries.value.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          if (!/\.ya?ml$/.test(entry.name)) continue;
          const candidate = join(path, entry.name);
          if (entry.isFile()) files.add(candidate);
          else if (entry.isSymbolicLink()) {
            const target = yield* attempt(
              Effect.tryPromise({
                try: () => stat(candidate),
                catch: () => new ValidationIOError({ reason: "path" }),
              }),
            );
            if (!target.ok)
              errors.push(`${singleLine(candidate)}: ${ioMessage[target.error.reason]}`);
            else if (target.value.isFile()) files.add(candidate);
          }
        }
      } else errors.push(`${singleLine(path)}: cannot read input path`);
    }
    let count = 0;
    let failed = errors.length > 0;
    for (const path of files) {
      const bytes = yield* attempt(
        Effect.tryPromise({
          try: (signal) => readFile(path, { signal }),
          catch: () => new ValidationIOError({ reason: "read" }),
        }),
      );
      if (!bytes.ok) {
        errors.push(`${singleLine(path)}: ${ioMessage[bytes.error.reason]}`);
        failed = true;
        continue;
      }
      const inspected = yield* attempt(
        Effect.try({
          try: () => inspectFile(bytes.value, path, ceilings),
          catch: () => new ValidationIOError({ reason: "yaml" }),
        }),
      );
      if (!inspected.ok) {
        errors.push(`${singleLine(path)}: ${ioMessage[inspected.error.reason]}`);
        failed = true;
        continue;
      }
      for (const line of inspected.value.lines) lines.push(line);
      for (const error of inspected.value.errors) errors.push(error);
      count += inspected.value.count;
      failed ||= inspected.value.failed;
    }
    if (count === 0) {
      failed = true;
      if (errors.length === 0) errors.push("no Function documents found");
    }
    return { exitCode: failed ? 1 : 0, lines, errors, ceilingsLine };
  });
