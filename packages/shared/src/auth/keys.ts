import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { Context, Effect, Layer, Ref, Schedule, type Scope } from "effect";
import picomatch from "picomatch";
import { parseAllDocuments } from "yaml";
import { KrunConfig } from "../config/index.js";
import { KeyInvalid, KeysConfigInvalid } from "./errors.js";
import { type KeyScope, keysFileSchema } from "./schema.js";

export interface KeyPrincipal {
  readonly name: string;
  readonly scopes: readonly KeyScope[];
  readonly functions: readonly string[];
  readonly maxQueued: number | undefined;
  readonly hasScope: (scope: KeyScope) => boolean;
  readonly allowsFunction: (name: string) => boolean;
}

interface KeyService {
  readonly lookup: (bearer: string) => Effect.Effect<KeyPrincipal, KeyInvalid>;
}

interface CompiledSecret {
  readonly digest: Buffer;
  readonly principal: KeyPrincipal;
}

interface Sources {
  readonly path: string;
  readonly read?: Effect.Effect<Uint8Array, unknown>;
}

const fields = ["name", "key", "scopes", "functions", "maxQueued"] as const;
const digest = (input: string | Uint8Array) => crypto.createHash("sha256").update(input).digest();

const compile = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        // yaml.parse can emit source snippets; parseDocument with silent logging
        // can silently accept multiple documents. Count documents explicitly and
        // reject all diagnostics without ever sending them to a logger.
        const documents = parseAllDocuments(text, { logLevel: "silent", prettyErrors: false });
        const document = documents[0];
        if (
          documents.length !== 1 ||
          document === undefined ||
          document.errors.length ||
          document.warnings.length
        ) {
          throw new Error("Invalid YAML");
        }
        return document.toJS();
      },
      catch: () => new KeysConfigInvalid({ reason: "yaml", field: "file" }),
    });
    const parsed = keysFileSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return yield* Effect.fail(
        new KeysConfigInvalid({
          reason:
            issue?.code === "custom" && issue.message === "Duplicate API key name"
              ? "duplicate_name"
              : "schema",
          field: fields.find((field) => field === issue?.path[2]) ?? "keys",
          entry: typeof issue?.path[1] === "number" ? issue.path[1] : undefined,
        }),
      );
    }
    const records = yield* Effect.forEach(parsed.data.keys, (key, index) =>
      Effect.try({
        try: () => {
          const scopes = Object.freeze([...key.scopes]);
          const functions = Object.freeze([...(key.functions ?? [])]);
          const admin = scopes.includes("admin");
          const matches = picomatch([...functions], { nocase: false, dot: true });
          const principal: KeyPrincipal = Object.freeze({
            name: key.name,
            scopes,
            functions,
            maxQueued: key.maxQueued,
            hasScope: (scope: KeyScope) => admin || scopes.includes(scope),
            allowsFunction: (name: string) => admin || matches(name),
          });
          const secrets = typeof key.key === "string" ? [key.key] : key.key;
          // Only digests and non-secret immutable metadata survive publication.
          return secrets.map((secret) => ({ digest: digest(secret), principal }));
        },
        catch: () => new KeysConfigInvalid({ reason: "glob", field: "functions", entry: index }),
      }),
    );
    return records.flat();
  });

export const makeKeys = (
  sources: Sources,
): Effect.Effect<KeyService, KeysConfigInvalid, Scope.Scope> =>
  Effect.gen(function* () {
    const rawRead: Effect.Effect<Uint8Array, unknown> =
      sources.read ??
      Effect.tryPromise({
        // Reopen the configured path on every poll, following Secret symlink swaps.
        try: (signal) => readFile(sources.path, { signal }),
        catch: () => new KeysConfigInvalid({ reason: "read", field: "file" }),
      });
    const read = rawRead.pipe(
      Effect.mapError(() => new KeysConfigInvalid({ reason: "read", field: "file" })),
    );
    const content = read.pipe(
      Effect.flatMap((input) =>
        Effect.try({
          try: () => {
            const bytes = Buffer.from(input);
            return { bytes, hash: digest(bytes).toString("hex") };
          },
          catch: () => new KeysConfigInvalid({ reason: "read", field: "file" }),
        }),
      ),
    );
    const initial = yield* content;
    const snapshot = yield* Ref.make({
      hash: initial.hash,
      records: yield* compile(initial.bytes),
    });
    const reload = Effect.gen(function* () {
      const next = yield* content;
      const current = yield* Ref.get(snapshot);
      if (next.hash === current.hash) return;
      const records = yield* compile(next.bytes);
      yield* Ref.set(snapshot, { hash: next.hash, records });
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("API keys reload rejected", {
          reason: error.reason,
          field: error.field,
          entry: error.entry,
        }),
      ),
    );
    // repeat runs once immediately: delay the WHOLE loop, not its body, so
    // reads occur at 30,60,90 seconds, rather than 0 or 30,90,150 seconds.
    yield* reload.pipe(
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.delay("30 seconds"),
      Effect.forkScoped,
    );
    return {
      lookup: (bearer) =>
        Ref.get(snapshot).pipe(
          Effect.flatMap(({ records }) =>
            Effect.suspend(() => {
              const presented = digest(bearer);
              let found: KeyPrincipal | undefined;
              let ambiguous = false;
              // Always scan every fixed-width digest. No secret-indexed Map, unequal
              // length fast path, short-circuit array predicate, or early return.
              for (const record of records satisfies readonly CompiledSecret[]) {
                if (crypto.timingSafeEqual(presented, record.digest)) {
                  if (found !== undefined && found !== record.principal) ambiguous = true;
                  found = record.principal;
                }
              }
              // A credential shared across different names cannot identify one owner.
              return found === undefined || ambiguous
                ? Effect.fail(new KeyInvalid())
                : Effect.succeed(found);
            }),
          ),
        ),
    };
  });

export class Keys extends Context.Service<Keys, KeyService>()("krun/Keys") {}

export const KeysLive = Layer.effect(
  Keys,
  Effect.gen(function* () {
    const configuration = yield* KrunConfig;
    if (configuration.role !== "gateway") {
      return yield* Effect.fail(new KeysConfigInvalid({ reason: "role", field: "file" }));
    }
    return yield* makeKeys({ path: configuration.config.KRUN_API_KEYS_PATH });
  }),
);
