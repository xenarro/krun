import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import { stringify } from "yaml";
import { ConfigLive } from "../config/index.js";
import { KeyInvalid } from "./errors.js";
import { Keys, KeysLive, makeKeys } from "./keys.js";

const secret = () => randomBytes(32).toString("base64url");
const file = (key: string, name = "reports-service") =>
  stringify({
    keys: [{ name, key, scopes: ["runs:read"], functions: ["report-*"], maxQueued: 3 }],
  });
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "krun-test-p2-4-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);
// Keep configuration explicit: never read the user's environment or kube context.
const gateway = (path: string) =>
  KeysLive.pipe(
    Layer.provide(
      ConfigLive("gateway", {
        env: {
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: "krun-test-p2-4",
          KRUN_API_KEYS_PATH: path,
        },
      }),
    ),
  );

it.effect(
  "real gateway KeysLive follows an atomic Secret directory symlink swap and removes old credentials",
  () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const old = secret();
      const next = secret();
      yield* Effect.promise(async () => {
        await mkdir(join(root, "..v1"));
        await mkdir(join(root, "..v2"));
        await writeFile(join(root, "..v1", "keys.yaml"), file(old));
        await writeFile(join(root, "..v2", "keys.yaml"), file(next));
        await symlink("..v1", join(root, "..data"));
        await symlink("..data/keys.yaml", join(root, "keys.yaml"));
      });
      yield* Effect.gen(function* () {
        const keys = yield* Keys;
        expect((yield* keys.lookup(old)).maxQueued).toBe(3);
        yield* Effect.promise(async () => {
          await symlink("..v2", join(root, "..data_next"));
          await rename(join(root, "..data_next"), join(root, "..data"));
        });
        yield* TestClock.adjust("29999 millis");
        expect(yield* Effect.flip(keys.lookup(next))).toBeInstanceOf(KeyInvalid);
        yield* TestClock.adjust("1 millis");
        // File I/O is real; let its completion publish before observing the result.
        for (;;) {
          const result = yield* Effect.exit(keys.lookup(next));
          if (Exit.isSuccess(result)) break;
          yield* Effect.yieldNow;
        }
        expect((yield* keys.lookup(next)).name).toBe("reports-service");
        expect(yield* Effect.flip(keys.lookup(old))).toBeInstanceOf(KeyInvalid);
        expect(
          (yield* Effect.promise(() => readFile(join(root, "..v1", "keys.yaml")))).length > 0,
        ).toBe(true);
      }).pipe(Effect.provide(gateway(join(root, "keys.yaml"))));
    }),
);

it.effect(
  "missing mounted file and invalid startup document fail actual KeysLive acquisition",
  () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const path = join(root, "keys.yaml");
      const acquire = Effect.gen(function* () {
        yield* Keys;
      }).pipe(Effect.provide(gateway(path)));
      const missing = yield* Effect.flip(acquire);
      expect(missing).toMatchObject({ _tag: "KeysConfigInvalid", reason: "read" });
      yield* Effect.promise(() => writeFile(path, "keys: ["));
      const malformed = yield* Effect.flip(acquire);
      expect(malformed).toMatchObject({ _tag: "KeysConfigInvalid", reason: "yaml" });
    }),
);

it.effect("scheduler rejects KeysLive without trying to read a gateway-only mount", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        yield* Keys;
      }).pipe(
        Effect.provide(
          KeysLive.pipe(
            Layer.provide(
              ConfigLive("scheduler", {
                env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p2-4" },
              }),
            ),
          ),
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "KeysConfigInvalid", reason: "role" });
  }),
);

it.effect("admin accepts an explicit empty glob list; empty scopes grant no permissions", () =>
  Effect.gen(function* () {
    const admin = secret();
    const none = secret();
    const bytes = Buffer.from(
      stringify({
        keys: [
          { name: "admin", key: admin, scopes: ["admin"], functions: [] },
          { name: "none", key: none, scopes: [], functions: ["report-*"] },
        ],
      }),
    );
    const keys = yield* makeKeys({ path: "krun-test-p2-4/keys.yaml", read: Effect.succeed(bytes) });
    expect((yield* keys.lookup(admin)).allowsFunction("billing-daily")).toBe(true);
    const principal = yield* keys.lookup(none);
    expect(principal.hasScope("runs:read")).toBe(false);
    expect(principal.hasScope("runs:write")).toBe(false);
    expect(principal.hasScope("runs:priority")).toBe(false);
    expect(principal.hasScope("functions:read")).toBe(false);
    expect(principal.hasScope("admin")).toBe(false);
  }),
);

it.effect(
  "ordinary YAML aliases are supported and invalid UTF-8 is rejected before decoding credentials",
  () =>
    Effect.gen(function* () {
      const one = secret();
      const two = secret();
      const scopes = ["runs:read"];
      const functions = ["report-*"];
      const bytes = Buffer.from(
        stringify({
          keys: [
            { name: "one", key: one, scopes, functions },
            { name: "two", key: two, scopes, functions },
          ],
        }),
      );
      const keys = yield* makeKeys({
        path: "krun-test-p2-4/keys.yaml",
        read: Effect.succeed(bytes),
      });
      expect((yield* keys.lookup(one)).name).toBe("one");
      expect((yield* keys.lookup(two)).name).toBe("two");
      const invalid = Buffer.from(file(one));
      invalid[invalid.indexOf(one)] = 0xff;
      const error = yield* Effect.flip(
        makeKeys({
          path: "krun-test-p2-4/keys.yaml",
          read: Effect.succeed(invalid),
        }),
      );
      expect(error).toMatchObject({ _tag: "KeysConfigInvalid", reason: "yaml", field: "file" });
    }),
);

it.effect(
  "UTF-8 credentials preserve case, whitespace and Unicode normalization distinctions",
  () =>
    Effect.gen(function* () {
      const bearer = ` KrUn-${secret()}-é `;
      const keys = yield* makeKeys({
        path: "krun-test-p2-4/keys.yaml",
        read: Effect.succeed(Buffer.from(file(bearer))),
      });
      expect((yield* keys.lookup(bearer)).name).toBe("reports-service");
      for (const different of [bearer.trim(), bearer.toLowerCase(), bearer.normalize("NFD")]) {
        expect(yield* Effect.flip(keys.lookup(different))).toBeInstanceOf(KeyInvalid);
      }
    }),
);
