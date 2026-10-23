# `keys.yaml`: format, scopes, globs, lookup, reload

Serves P2.4 (PLAN.md:346-350). Module `packages/shared/src/auth/`
(PLAN.md:105), a `Keys` service (`Context.Service`) with a scoped layer.
Parse the file with `yaml`; the value goes straight into a Zod schema
(docs/STACK.md 2.5). Function globs are `picomatch` matchers (docs/STACK.md
2.5, 4.3). Keys live in a mounted Secret file, not the database. No key
management API in v1 (D7, SPEC.md section 9 "API keys", non-goal in
SPEC.md section 1).

## 1. File format (SPEC.md section 9 "API keys", verbatim)

```yaml
keys:
  - name: reports-service          # valid label value; becomes created_by and krun.io/created-by
    key: <random, at least 32 bytes>   # a string, or a list of strings during rotation
    scopes: [runs:write, runs:read, functions:read]   # also runs:priority, admin
    functions: ["report-*"]        # glob list, required unless scope admin
    maxQueued: 200                 # optional, queued runs per function for this key
```

| Field | Rule |
|---|---|
| `name` | required; valid Kubernetes label value (becomes `created_by` and Job label `krun.io/created-by`, D25); unique in the file |
| `key` | a string, or a list of strings during rotation; any listed secret authenticates as that name |
| `scopes` | from `functions:read`, `runs:read`, `runs:write`, `runs:priority`, `admin` (docs/API.md:44-47) |
| `functions` | glob list; required unless `scopes` contains `admin` |
| `maxQueued` | optional integer; queued runs per function for this key, enforced at `CreateRun` via `countQueuedBy`, 429 `QUEUE_FULL` `metadata.limit: key` (docs/API.md:340) |

Location: key `keys.yaml` of a Secret mounted at the parent directory of
`KRUN_API_KEYS_PATH` (default `/etc/krun/keys.yaml`), never with
`subPath`. Secret volume updates are a symlink swap of the directory,
which a `subPath` mount never sees (D12). The chart renders no `Secret`;
the platform team creates it (SPEC.md section 13).

## 2. Scopes

| Scope | Unlocks |
|---|---|
| `functions:read` | `ListFunctions`, `GetFunction` |
| `runs:read` | `GetRun`, `ListRuns`, `WaitRun`, `GetRunResult`, `WatchRun` |
| `runs:write` | `CreateRun`, `CancelRun` |
| `runs:priority` | `priority` above 0 on `CreateRun`; else 403 `SCOPE_MISSING` `metadata.scope` (D25) |
| `admin` | every scope; every function (no globs needed) and every run |

Owner scoping: SKILL.md Rule 7 (SPEC.md:214-217, docs/API.md:44-47,
190-193, 225-227). Order: key (401), scope (403), then function and owner
(404); `endpoints.md` section 4 fixes the reasons.

## 3. Globs

- `functions` entries match the Function name (a DNS-1123 label,
  docs/API.md:19) with `picomatch`. One matcher per key:
  `picomatch(entry.functions, { nocase: false, dot: true })`; an array of
  globs yields a matcher true when any glob matches. Matching is anchored
  to the whole name and case-sensitive. Never translate globs to a
  `RegExp` by hand (docs/STACK.md 2.5, 2.8).
- picomatch dialect: `*` any run of characters except `/` (Function names
  never contain `/`), `?` one character, plus braces, classes and
  extglobs. A leading `!` negates the glob: `["!billing-*"]` grants every
  other function. State that in the loader test and the README; do not
  forbid it (no task asks, PLAN.md:31-32).
- Validate each glob at load. The Zod schema requires non-empty strings
  (picomatch throws on an empty or non-string pattern). Compile inside
  `Effect.try` anyway, so any throw fails the load naming the entry index
  (section 6).
- Globs that match nothing give an empty `ListFunctions`, not an error
  (docs/API.md:184-186).
- Compile once per load (a changed content hash rebuilds the matchers with
  the key set), never per request.

## 4. Lookup and comparison

- Constant-time with respect to the secret (SPEC.md section 9 "API keys",
  PLAN.md:347). Never index a `Map` by the presented bearer. Hash every
  configured secret with SHA-256 at load; hash the presented bearer;
  compare against every configured hash with `crypto.timingSafeEqual` on
  equal-length buffers, without early return, remembering the match.
  Fixed-length hashes mean a length difference cannot short-circuit.
- The result is the key record (`name`, scopes, compiled globs,
  `maxQueued`), never the secret; `onRequest` decorates `request.key`
  with it. A miss is the `KeyInvalid` tagged error, mapped like every other
  (SKILL.md Rule 3).
- `Authorization` absent or not exactly `Bearer <token>`: 401
  `KEY_MISSING`. Unknown bearer: 401 `KEY_INVALID` (docs/API.md:330).
  Audit lines carry `key: null` on 401 (PLAN.md:380-381).
- Never log, echo or store the secret; tests generate their own keys
  (PLAN.md:33). The Zod error for a bad file reports entry index and field
  from the issue `path`, never the issue's input (it may be a secret).

## 5. Reload and rotation

- 30 s poll on the file's content hash (D12). Changed hash re-parses and
  swaps the set atomically (`Ref.set`); unchanged does nothing. The poll is
  a fiber forked into the layer scope with
  `Effect.repeat(Schedule.spaced("30 seconds"))`, so it stops with the
  scope and tests drive it with `TestClock.adjust("30 seconds")`. File
  reads go through `Effect.tryPromise` on `node:fs/promises`.
- A file that fails to parse or validate at startup fails the layer with a
  tagged error naming the problem; `runMain` then exits 1 (SPEC.md section
  12 startup rule). A failure on a later poll keeps the previous set and
  logs an error. SPEC fixes only startup: this is the conservative
  reading, recorded in a test, not a new rule.
- Rotation (SPEC.md section 9): append the new secret to the `key` list,
  wait one reload, switch clients, remove the old one. Both authenticate as
  the same `name`, so `created_by` and owner scoping are unaffected.
- The scheduler never reads `keys.yaml` (D25); only the gateway mounts it.

## 6. Loader validation (startup, exit 1)

One Zod schema: `z.strictObject({ keys: z.array(entry) })`, `entry` a
`z.strictObject`, plus `superRefine` for cross-field and uniqueness rules.

| Check | Error |
|---|---|
| top level is `{ keys: [...] }` | malformed file |
| each entry has `name`, `key`, `scopes` | missing field, entry index named |
| `name` is a valid label value and unique | duplicate name rejected |
| `key` is a non-empty string or a non-empty list of non-empty strings | invalid key |
| every scope is one of the five | unknown scope |
| `functions` present and non-empty unless `admin` | missing globs |
| `maxQueued`, when present, is an integer >= 1 | invalid maxQueued |
| every `functions` entry is a non-empty string that compiles with `picomatch` | invalid glob, entry index named |
| no unknown fields on an entry | unknown field (same rule as the API, docs/API.md:50-51) |

## 7. P2.4 acceptance (PLAN.md:349-350)

`@effect/vitest` `it.effect` tests (Phase 2 gate `pnpm exec vitest run ...
packages/shared/src/auth`, PLAN.md:317):

- allowed;
- denied: wrong scope, glob miss, `report-*` matching `report-daily` and
  not `reports` or `Report-daily`;
- `admin`;
- a key with two secrets during rotation (both authenticate as one name);
- a duplicate name rejected;
- added: a changed hash swaps the set and an unchanged hash does not
  re-parse, both after `TestClock.adjust("30 seconds")`, never a real
  sleep.
