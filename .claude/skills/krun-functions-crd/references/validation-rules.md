# Validation rules, `Ready` reasons and test cases (SPEC.md:130-174)

One pure function, proposed signature:

```ts
import type { Duration } from 'effect';
import type { ValidateFunction } from 'ajv';

export type Ceilings = {
  maxActiveDeadline: number;        // KRUN_MAX_ACTIVE_DEADLINE, default 86400
  maxQueued: number;                // KRUN_MAX_QUEUED, default 1000
  allowedRegistries: string[];      // KRUN_ALLOWED_REGISTRIES, default [] = any
  allowedServiceAccounts: string[]; // KRUN_ALLOWED_SERVICE_ACCOUNTS, default ['krun-job-default']
  webhookAllowedHosts: string[];    // KRUN_WEBHOOK_ALLOWED_HOSTS, default [] = webhooks disabled
};
export type ValidationResult =
  | { ok: true; reason: 'Valid'; validate: ValidateFunction; queueTimeout: Duration.Duration; heartbeatTimeout?: Duration.Duration }
  | { ok: false; reason: Exclude<ReadyReason, 'Valid'>; message: string; queueTimeout?: Duration.Duration };
export function validateFunction(spec: FunctionSpec, ceilings: Ceilings): ValidationResult; // FunctionSpec = z.infer<typeof FunctionSpec>
```

A plain synchronous function, not an Effect: it has no requirements and no
typed failure (an invalid Function is a value, not an error). Durations are
parsed with the shared duration grammar (the Zod refinement into
`Duration`, PLAN.md:82-86), the same code the Config layer uses.

Defaults for the five variables: SPEC.md:1199, 1206-1207, 1211, 1214.
`queueTimeout` is returned even on failure when it parses, because the
scheduler's `expireQueued` reads the cached Function "Ready or not"
(SPEC.md:808-811). No I/O, no env, no DNS, no clock inside the function.

## 1. Rule table (check order = row order; first failure wins)

| # | Rule | SPEC | `Ready` reason | Message shape (proposal) | P2.2 test case (PLAN.md:332-335) |
|---|---|---|---|---|---|
| 1 | `queueTimeout` matches `^\d+(ms\|s\|m\|h)$` | SPEC.md:117-118, 140 | `InvalidDuration` | `invalid value: "<v>": spec.queueTimeout` | `queueTimeout: 1 hour` |
| 2 | `heartbeatTimeout` (when set) matches the pattern | SPEC.md:140 | `InvalidDuration` | `invalid value: "<v>": spec.heartbeatTimeout` | `heartbeatTimeout: soon` |
| 3 | `heartbeatTimeout` (when set) >= 30 s | SPEC.md:140-141 | `InvalidDuration` | `expected 30s <= "<v>": spec.heartbeatTimeout` | `heartbeatTimeout: 5s` (named in PLAN) |
| 4 | `image` contains `@sha256:` (mirror of the CEL rule, for `krun validate` on files) | SPEC.md:133-134 | `RegistryNotAllowed` is wrong here: this is layer one; report it as the CRD schema failure line, not a reason | `spec.image must be pinned by digest ...` | tag image (P2.5 fixture) |
| 5 | `image` starts with one of `allowedRegistries` when the list is non-empty | SPEC.md:141-142, 1091-1092 | `RegistryNotAllowed` | `invalid value: "<registry>": spec.image` (print the prefix, not the whole ref if it holds credentials-like text) | `image: docker.io/x@sha256:...` with `allowedRegistries: ['ghcr.io/acme/']` |
| 6 | `serviceAccountName` (defaulted `krun-job-default`) in `allowedServiceAccounts` | SPEC.md:93, 142-143 | `ServiceAccountNotAllowed` | `invalid value: "<sa>": spec.serviceAccountName` | `serviceAccountName: default` (forbidden SA, named in PLAN) |
| 7 | no `secretRefs[i]` matches `krun-*` | SPEC.md:101, 143 | `SecretRefNotAllowed` | `invalid value: "krun-keys": spec.secretRefs[1]` | `secretRefs: [ok, krun-job-abc]` |
| 8 | `activeDeadlineSeconds` <= `maxActiveDeadline` | SPEC.md:102, 138-139 | `DeadlineAboveCeiling` | `expected 1 <= <v> <= <max>: spec.activeDeadlineSeconds` | `activeDeadlineSeconds: 86401` |
| 9 | `maxQueued` <= `maxQueued` ceiling | SPEC.md:104, 139 | `QueuedAboveCeiling` | `expected 1 <= <v> <= <max>: spec.maxQueued` | `maxQueued: 1001` |
| 10 | `maxConcurrency` >= 1 | SPEC.md:140 | no reason in the enum (SKILL.md Limitations); CRD `minimum: 1` catches it in-cluster; in `krun validate` report it as a schema failure line | `expected 1 <= <v>: spec.maxConcurrency` | `maxConcurrency: 0` |
| 11 | `callback.url` (when set): `webhookAllowedHosts` non-empty and host matches a glob (P2.1 matcher) | SPEC.md:144, 1062, 1214 | `CallbackNotAllowed` | `invalid value: "<host>": spec.callback.url` | `callback.url: https://evil.example/x` with empty hosts (P2.5 fixture) |
| 12 | `JSON.stringify(inputSchema).length <= 65536` (bytes: use `Buffer.byteLength`) | SPEC.md:87, 138 | `SchemaTooLarge` | `expected size <= 65536 bytes, got <n>: spec.inputSchema` | 65 KiB schema (named in PLAN) |
| 13 | no `$ref`/`$dynamicRef` value anywhere in `inputSchema` that does not start with `#` | SPEC.md:137 | `SchemaInvalid` | `remote $ref not allowed: spec.inputSchema<path>` | `$ref: https://example.com/s.json` (remote `$ref`, named in PLAN) |
| 14 | `new Ajv2020({ strict: true })` + ajv-formats `compile(inputSchema)` succeeds | SPEC.md:136-137 | `SchemaInvalid` | first line of the Ajv error, prefixed `spec.inputSchema: ` | `{ type: 'objekt' }` or an unknown keyword under `strict` (non-compiling schema, named in PLAN) |
| - | all passed | SPEC.md:154 | `Valid` | `""` (SPEC.md:114 shows an empty message) | the valid fixture |

Why this order: cheap string checks first, then ceilings, then the only
expensive step (compile). Size before compile keeps a 10 MB schema from
being compiled; the `$ref` walk before compile makes the remote-`$ref` case
deterministic instead of depending on Ajv's `MissingRefError`
(docs/research/node-stack-facts.md:715-720).

Rows 4 and 10 are layer one. In-cluster the API server rejects them before
any informer event; `krun validate` runs the layer-one schema (the Zod spec
schema's `safeParse`, plus the digest rule mirrored in TS; never Ajv, which
is only for `inputSchema`) over each document FIRST and prints those failures as schema errors, then runs layer
two only on documents that passed (SPEC.md:168-169). Do not invent reasons
for them.

## 2. Ajv instance

```ts
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
const addFormats = (addFormatsModule as any).default ?? addFormatsModule; // ESM interop quirk, docs/research/node-stack-facts.md:710-714
const ajv = new Ajv2020({ strict: true, allErrors: false });
addFormats(ajv);
```

- One instance per process is fine, but Ajv caches compiled schemas by
  object identity and `strict` rejects duplicate `$id`s: either strip `$id`
  from `inputSchema` before compiling or use `ajv.removeSchema()` after
  compile. Simplest: construct a fresh `Ajv2020` per compile call; compile
  happens once per uid+generation, so cost is irrelevant.
- `loadSchema` is never set, so `compileAsync` cannot exist; only
  synchronous `compile` (SPEC.md:137). Reject `$async: true` schemas too
  (an `$async` schema makes `compile` return an async validator).
- `pattern` regexes are trusted; no timeout, no safe-regex check
  (SPEC.md:948).

## 3. Ceilings from the environment (SPEC.md:170-174, 1199-1214)

| Variable | Default | Parse |
|---|---|---|
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | integer seconds |
| `KRUN_MAX_QUEUED` | `1000` | integer |
| `KRUN_ALLOWED_REGISTRIES` | empty = any | comma-separated prefixes, trimmed, empty entries dropped |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | comma-separated |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty = webhooks disabled | comma-separated globs; matcher from `packages/shared/src/webhook` (P2.1) |

In the processes these come from `packages/shared/src/config` (a Zod schema
over `process.env` exposed as an Effect Config service layer,
`krun-process-runtime`). `krun validate` is an Effect program too
(`NodeRuntime.runMain`): build the ceilings with the same Zod parsers (only
these five variables, so a missing `KRUN_DB_DSN` never fails it) and print, on stderr, one line per variable with the value used
(SPEC.md:173-174), for example:

```
krun validate: KRUN_MAX_ACTIVE_DEADLINE=86400 KRUN_MAX_QUEUED=1000 KRUN_ALLOWED_REGISTRIES=(any) KRUN_ALLOWED_SERVICE_ACCOUNTS=krun-job-default KRUN_WEBHOOK_ALLOWED_HOSTS=(none, webhooks disabled)
```

Never print a secret; none of these five are secrets.

## 4. `krun validate` behaviour (SPEC.md:168-174, PLAN.md:351-362)

- Arguments: one or more paths. A directory is walked for `*.yaml` and
  `*.yml` (proposal: non-recursive is simpler; SPEC says "files or
  directories" without depth; pick recursive only if P8 templates need it
  and record it in the progress-log note).
- Each file is parsed with `yaml.parseAllDocuments`; documents with
  `kind: Function` and `apiVersion: krun.io/v1alpha1` are validated; other
  kinds are skipped silently (function repositories hold other YAML);
  `doc.errors` non-empty is an error line for that file.
- Apply CRD defaults to a copy of `spec` before layer two (section 1,
  row 6 depends on it).
- `image: REPLACE_WITH_DIGEST` (the `krun init` template, SPEC.md:747) is
  reported by the digest rule with a dedicated message, for example
  `spec.image is still REPLACE_WITH_DIGEST; run krun deploy or paste the
  image digest` (PLAN.md:824-825 requires "a clear message").
- Output: one line per Function on stdout (proposal, stable for tests):
  `OK   <file>: <name>` / `FAIL <file>: <name>: <reason>: <message>`.
  Exit 1 if any line is FAIL or any file failed to parse; exit 0 otherwise.
  Exit code when no Function document was found is not fixed by SPEC
  (proposal: exit 1 with `no Function documents found` so CI misconfig is
  loud; note it in the progress log).
- No cluster access, no `KRUN_NAMESPACE`, no flags except `--help`
  (SPEC.md:1178). `bin/krun.js validate` dispatches to
  `packages/cli/dist/validate.js` (PLAN.md:354-356); `krun deploy` calls
  the same exported function (SPEC.md:174).

## 5. P2.2 table test checklist

One row per rule above with exactly one violation each, plus:

- the valid fixture returns `ok: true` and a `validate` function that
  accepts `{from:'2026-01-01', to:'2026-01-02'}` and rejects `{}`;
- `queueTimeout` (a `Duration`) is present on a failing result when it
  parses (feeds SPEC.md:808-811);
- the function is pure: call it twice with the same input and deep-equal
  the non-function parts; pass a frozen `spec` to prove no mutation;
- no case touches the network: give the remote `$ref` case a Vitest
  per-test `timeout` of 1000 ms as a tripwire (no wall-clock reads in the
  code under test, no sleeps in the test).
- run it with `pnpm exec vitest run packages/shared/src/functions`
  (part of the Phase 2 gate, PLAN.md:317).
