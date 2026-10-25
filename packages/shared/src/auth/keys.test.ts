import crypto, { randomBytes } from "node:crypto";
import { expect, it, vi } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { stringify } from "yaml";
import { KeyInvalid, KeysConfigInvalid } from "./errors.js";
import { type KeyPrincipal, makeKeys } from "./keys.js";

const secret = () => randomBytes(32).toString("base64url");
const entry = (key: unknown, overrides: Record<string, unknown> = {}) => ({
  name: "reports-service",
  key,
  scopes: ["runs:write", "runs:read", "functions:read"],
  functions: ["report-*"],
  maxQueued: 200,
  ...overrides,
});
const file = (keys: unknown[]) => Buffer.from(stringify({ keys }));
const load = (bytes: Uint8Array) =>
  makeKeys({ path: "krun-test-p2-4/keys.yaml", read: Effect.succeed(bytes) });

it.effect("allowed principal retains its name, scopes, function globs and per-key queue cap", () =>
  Effect.gen(function* () {
    const bearer = secret();
    const keys = yield* load(file([entry(bearer)]));
    const key: KeyPrincipal = yield* keys.lookup(bearer);
    expect(key.name).toBe("reports-service");
    expect(key.scopes).toEqual(["runs:write", "runs:read", "functions:read"]);
    expect(key.functions).toEqual(["report-*"]);
    expect(key.maxQueued).toBe(200);
    expect(key.hasScope("runs:write")).toBe(true);
    expect(key.hasScope("runs:read")).toBe(true);
    expect(key.hasScope("functions:read")).toBe(true);
    expect(key.hasScope("runs:priority")).toBe(false);
    expect(key.hasScope("admin")).toBe(false);
    expect(key.allowsFunction("report-daily")).toBe(true);
    for (const name of ["reports", "Report-daily", "billing-daily", "xreport-daily"]) {
      expect(key.allowsFunction(name)).toBe(false);
    }
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(key.scopes)).toBe(true);
    expect(Object.isFrozen(key.functions)).toBe(true);
    expect(Object.keys(key).sort()).toEqual([
      "allowsFunction",
      "functions",
      "hasScope",
      "maxQueued",
      "name",
      "scopes",
    ]);
    expect(JSON.stringify(key).includes(bearer)).toBe(false);
    for (const candidate of [secret(), "", `${bearer} `, bearer.slice(1)]) {
      expect(yield* Effect.flip(keys.lookup(candidate))).toBeInstanceOf(KeyInvalid);
    }
  }),
);

it.effect("priority is explicit; it does not imply write, read, or admin", () =>
  Effect.gen(function* () {
    const bearer = secret();
    const keys = yield* load(
      file([entry(bearer, { scopes: ["runs:priority"], maxQueued: undefined })]),
    );
    const key = yield* keys.lookup(bearer);
    expect(key.hasScope("runs:priority")).toBe(true);
    expect(key.hasScope("runs:write")).toBe(false);
    expect(key.hasScope("runs:read")).toBe(false);
    expect(key.hasScope("admin")).toBe(false);
    expect(key.maxQueued).toBeUndefined();
  }),
);

it.effect("admin needs no function globs and grants every defined scope and function", () =>
  Effect.gen(function* () {
    const bearer = secret();
    const keys = yield* load(file([entry(bearer, { scopes: ["admin"], functions: undefined })]));
    const key = yield* keys.lookup(bearer);
    for (const scope of [
      "runs:read",
      "runs:write",
      "runs:priority",
      "functions:read",
      "admin",
    ] as const) {
      expect(key.hasScope(scope)).toBe(true);
    }
    expect(key.allowsFunction("billing-daily")).toBe(true);
    expect(key.functions).toEqual([]);
  }),
);

it.effect("all rotation secrets authenticate as exactly the same immutable principal", () =>
  Effect.gen(function* () {
    const old = secret();
    const next = secret();
    const keys = yield* load(file([entry([old, next, old])]));
    expect((yield* keys.lookup(old)) === (yield* keys.lookup(next))).toBe(true);
    expect((yield* keys.lookup(next)).name).toBe("reports-service");
  }),
);

it.effect(
  "picomatch braces, classes, extglobs, dots, case and leading negation retain native semantics",
  () =>
    Effect.gen(function* () {
      const bearer = secret();
      const negated = secret();
      const keys = yield* load(
        file([
          entry(bearer, {
            functions: ["report-{daily,weekly}", "job-[ab]", "@(bill|pay)-*", ".hidden-*"],
          }),
          entry(negated, { name: "not-billing", functions: ["!billing-*"] }),
        ]),
      );
      const key = yield* keys.lookup(bearer);
      for (const name of [
        "report-daily",
        "report-weekly",
        "job-a",
        "bill-daily",
        "pay-now",
        ".hidden-job",
      ]) {
        expect(key.allowsFunction(name)).toBe(true);
      }
      for (const name of ["Report-daily", "job-c", "xreport-daily", "report-monthly"]) {
        expect(key.allowsFunction(name)).toBe(false);
      }
      const other = yield* keys.lookup(negated);
      expect(other.allowsFunction("report-daily")).toBe(true);
      expect(other.allowsFunction("billing-daily")).toBe(false);
    }),
);

it.effect(
  "compares every configured digest, even on first/last match, unequal length or complete miss",
  () =>
    Effect.gen(function* () {
      const first = secret();
      const middle = secret();
      const last = secret();
      const keys = yield* load(
        file([entry([first, middle]), entry(last, { name: "last-service" })]),
      );
      const spy = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(crypto, "timingSafeEqual")),
        (value) => Effect.sync(() => value.mockRestore()),
      );
      for (const candidate of [first, middle, last, secret(), "", "x"]) {
        spy.mockClear();
        yield* Effect.exit(keys.lookup(candidate));
        expect(spy.mock.calls.length).toBe(3);
        expect(
          spy.mock.calls.every(
            ([left, right]) => left.byteLength === 32 && right.byteLength === 32,
          ),
        ).toBe(true);
      }
    }),
);

it.effect(
  "a secret shared by different names is ambiguous, not a first/last-record privilege grant",
  () =>
    Effect.gen(function* () {
      const bearer = secret();
      const unique = secret();
      const keys = yield* load(
        file([
          entry([bearer, unique]),
          entry(bearer, { name: "administrator", scopes: ["admin"], functions: undefined }),
        ]),
      );
      expect(yield* Effect.flip(keys.lookup(bearer))).toBeInstanceOf(KeyInvalid);
      expect((yield* keys.lookup(unique)).name).toBe("reports-service");
    }),
);

const invalidEntries: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ["missing name", { name: undefined }, "name"],
  ["empty name", { name: "" }, "name"],
  ["long label", { name: "a".repeat(64) }, "name"],
  ["invalid label", { name: "bad/name" }, "name"],
  ["bad label endpoints", { name: "-bad" }, "name"],
  ["missing key", { key: undefined }, "key"],
  ["empty key", { key: "" }, "key"],
  ["empty rotation", { key: [] }, "key"],
  ["empty rotation member", { key: [""] }, "key"],
  ["numeric rotation member", { key: [123] }, "key"],
  ["null key", { key: null }, "key"],
  ["missing scopes", { scopes: undefined }, "scopes"],
  ["unknown scope", { scopes: ["runs:delete"] }, "scopes"],
  ["missing functions", { functions: undefined }, "functions"],
  ["empty functions", { functions: [] }, "functions"],
  ["empty glob", { functions: [""] }, "functions"],
  ["invalid functions type", { functions: "report-*" }, "functions"],
  ["null cap", { maxQueued: null }, "maxQueued"],
  ["zero cap", { maxQueued: 0 }, "maxQueued"],
  ["negative cap", { maxQueued: -1 }, "maxQueued"],
  ["fractional cap", { maxQueued: 1.5 }, "maxQueued"],
];
for (const [label, overrides, field] of invalidEntries) {
  it.effect(`rejects ${label} with bounded entry/field metadata and no input`, () =>
    Effect.gen(function* () {
      const bearer = secret();
      const error = yield* Effect.flip(load(file([entry(bearer, overrides)])));
      expect(error).toBeInstanceOf(KeysConfigInvalid);
      expect(error.entry).toBe(0);
      expect(error.field).toBe(field);
      expect(JSON.stringify(error).includes(bearer)).toBe(false);
      expect(error.message.includes(bearer)).toBe(false);
    }),
  );
}

it.effect("rejects duplicate names atomically, including an otherwise different secret/scope", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      load(file([entry(secret()), entry(secret(), { scopes: ["admin"] })])),
    );
    expect(error).toMatchObject({
      _tag: "KeysConfigInvalid",
      entry: 1,
      field: "name",
      reason: "duplicate_name",
    });
  }),
);

it.effect(
  "valid label values preserve case, digits and punctuation without prototype-map aliases",
  () =>
    Effect.gen(function* () {
      for (const name of ["A", "9", "Reports_Service.1", "constructor", "a".repeat(63)]) {
        const bearer = secret();
        const keys = yield* load(file([entry(bearer, { name })]));
        expect((yield* keys.lookup(bearer)).name).toBe(name);
      }
    }),
);

it.effect(
  "rejects malformed YAML, duplicate mapping fields, multi-documents, aliases and unknown fields without warnings",
  () =>
    Effect.gen(function* () {
      const bearer = secret();
      const warn = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(console, "warn")),
        (value) => Effect.sync(() => value.mockRestore()),
      );
      const valid = file([entry(bearer)]).toString();
      const cases = [
        "keys: [",
        "keys: []\nkeys: []\n",
        `${valid}\n---\nkeys: []\n`,
        "keys: [*missing]\n",
        "keys: !unknown []\n",
        "null\n",
        "[]\n",
        "{}\n",
        stringify({ keys: [], [bearer]: true }),
        stringify({ keys: [entry(bearer, { [bearer]: true })] }),
      ];
      for (const text of cases) {
        const error = yield* Effect.flip(load(Buffer.from(text)));
        expect(error).toBeInstanceOf(KeysConfigInvalid);
        expect(JSON.stringify(error).includes(bearer)).toBe(false);
        expect(error.message.includes(bearer)).toBe(false);
      }
      expect(warn.mock.calls.length).toBe(0);
    }),
);

it.effect("native glob compiler errors are bounded and expose neither pattern nor credential", () =>
  Effect.gen(function* () {
    const bearer = secret();
    const error = yield* Effect.flip(
      load(file([entry(bearer, { functions: [bearer.repeat(2000)] })])),
    );
    expect(error).toMatchObject({
      _tag: "KeysConfigInvalid",
      entry: 0,
      field: "functions",
      reason: "glob",
    });
    expect(JSON.stringify(error).includes(bearer)).toBe(false);
  }),
);

it.effect(
  "polls only at 30 seconds, hashes actual content, and reuses unchanged compiled principals",
  () =>
    Effect.gen(function* () {
      const old = secret();
      const next = secret();
      let bytes = file([entry(old)]);
      let reads = 0;
      const keys = yield* makeKeys({
        path: "krun-test-p2-4/keys.yaml",
        read: Effect.sync(() => {
          reads++;
          return bytes;
        }),
      });
      const original = yield* keys.lookup(old);
      yield* TestClock.adjust("29999 millis");
      expect(reads).toBe(1);
      yield* TestClock.adjust("1 millis");
      expect(reads).toBe(2);
      expect((yield* keys.lookup(old)) === original).toBe(true);
      bytes = file([entry([old, next], { maxQueued: 7, scopes: ["runs:priority"] })]);
      yield* TestClock.adjust("30 seconds");
      expect(reads).toBe(3);
      const rotated = yield* keys.lookup(next);
      expect(rotated === original).toBe(false);
      expect((yield* keys.lookup(old)) === rotated).toBe(true);
      expect(rotated.maxQueued).toBe(7);
      expect(rotated.hasScope("runs:priority")).toBe(true);
      expect(rotated.hasScope("runs:write")).toBe(false);
      bytes = file([entry(next)]);
      yield* TestClock.adjust("30 seconds");
      expect(reads).toBe(4);
      expect(yield* Effect.flip(keys.lookup(old))).toBeInstanceOf(KeyInvalid);
      expect((yield* keys.lookup(next)).name).toBe("reports-service");
      bytes = file([]);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Effect.flip(keys.lookup(next))).toBeInstanceOf(KeyInvalid);
    }),
);

it.effect("a byte-only change rebuilds once; reads are not based on mtime or size", () =>
  Effect.gen(function* () {
    const bearer = secret();
    let bytes = file([entry(bearer)]);
    const keys = yield* makeKeys({
      path: "krun-test-p2-4/keys.yaml",
      read: Effect.sync(() => bytes),
    });
    const original = yield* keys.lookup(bearer);
    bytes = Buffer.concat([bytes, Buffer.from("# different bytes, same policy\n")]);
    yield* TestClock.adjust("30 seconds");
    const changed = yield* keys.lookup(bearer);
    expect(changed === original).toBe(false);
    yield* TestClock.adjust("30 seconds");
    expect((yield* keys.lookup(bearer)) === changed).toBe(true);
  }),
);

it.effect(
  "bad reloads retain the last complete snapshot, log only bounded metadata and recover",
  () => {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    return Effect.gen(function* () {
      const old = secret();
      const next = secret();
      let bytes = file([entry(old)]);
      let failure: unknown;
      const keys = yield* makeKeys({
        path: "krun-test-p2-4/keys.yaml",
        read: Effect.suspend(() => (failure ? Effect.fail(failure) : Effect.succeed(bytes))),
      });
      const original = yield* keys.lookup(old);
      for (const malformed of [
        file([entry(next), entry(secret())]),
        file([entry(next), entry(secret(), { functions: undefined })]),
        Buffer.from(`keys: [${next}`),
      ]) {
        bytes = malformed;
        yield* TestClock.adjust("30 seconds");
        expect((yield* keys.lookup(old)) === original).toBe(true);
        expect(yield* Effect.flip(keys.lookup(next))).toBeInstanceOf(KeyInvalid);
      }
      failure = new Error(next);
      yield* TestClock.adjust("30 seconds");
      expect((yield* keys.lookup(old)) === original).toBe(true);
      expect(messages.length).toBe(4);
      expect(JSON.stringify(messages).includes(old)).toBe(false);
      expect(JSON.stringify(messages).includes(next)).toBe(false);
      failure = undefined;
      bytes = file([entry(next)]);
      yield* TestClock.adjust("30 seconds");
      expect((yield* keys.lookup(next)).name).toBe("reports-service");
      expect(yield* Effect.flip(keys.lookup(old))).toBeInstanceOf(KeyInvalid);
    }).pipe(Effect.provide(Logger.layer([logger])));
  },
);

it.effect("startup read failure has no native error, file path or credential attached", () =>
  Effect.gen(function* () {
    const bearer = secret();
    const error = yield* Effect.flip(
      makeKeys({ path: bearer, read: Effect.fail(new Error(bearer)) }),
    );
    expect(error).toMatchObject({ _tag: "KeysConfigInvalid", reason: "read", field: "file" });
    expect(JSON.stringify(error).includes(bearer)).toBe(false);
    expect(error.message.includes(bearer)).toBe(false);
  }),
);

it.effect("scope closure stops future polls", () =>
  Effect.gen(function* () {
    let reads = 0;
    yield* Effect.scoped(
      makeKeys({
        path: "krun-test-p2-4/keys.yaml",
        read: Effect.sync(() => {
          reads++;
          return file([]);
        }),
      }),
    );
    yield* TestClock.adjust("2 minutes");
    expect(reads).toBe(1);
  }),
);

it.effect("scope interruption cancels an in-flight reload without another read", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    let reads = 0;
    let finalized = false;
    const read = Effect.suspend(() => {
      reads++;
      return reads === 1
        ? Effect.succeed(file([]))
        : Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          );
    });
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeKeys({ path: "krun-test-p2-4/keys.yaml", read });
          yield* Deferred.succeed(ready, undefined);
          yield* Effect.never;
        }),
      ),
    );
    yield* Deferred.await(ready);
    yield* TestClock.adjust("30 seconds");
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(finalized).toBe(true);
    yield* TestClock.adjust("1 minute");
    expect(reads).toBe(2);
  }),
);
