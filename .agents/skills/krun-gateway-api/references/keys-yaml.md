# `keys.yaml`: format, scopes, globs, rotation, loader rules

Serves P2.4 (PLAN.md:346-350). Module `packages/shared/src/auth/`
(PLAN.md:105), exposed as a `Keys` service (`Context.Service`) with a
scoped layer. Parsed with the `yaml` package straight into a Zod schema
(PLAN.md:72, docs/STACK.md 2.5); glob to regex is written in house
(PLAN.md:82-83). Keys live in a mounted Secret file, not in
the database, and there is no key management API in v1 (D7 SPEC.md:1448,
SPEC.md:957, non-goal SPEC.md:19-24).

## 1. File format (SPEC.md:959-966, verbatim)

```yaml
keys:
  - name: reports-service          # valid label value; becomes created_by and krun.io/created-by
    key: <random, at least 32 bytes>   # a string, or a list of strings during rotation
    scopes: [runs:write, runs:read, functions:read]   # also runs:priority, admin
    functions: ["report-*"]        # glob list, required unless scope admin
    maxQueued: 200                 # optional, queued runs per function for this key
```

| Field | Rule | Source |
|---|---|---|
| `name` | required; a valid Kubernetes label value (it becomes `created_by` and the Job label `krun.io/created-by`); unique in the file, duplicates rejected by the loader | SPEC.md:961, SPEC.md:969, SPEC.md:578, D25 |
| `key` | a string, or a list of strings during rotation; any listed secret authenticates as that name; at least 32 random bytes recommended | SPEC.md:962, SPEC.md:968-969 |
| `scopes` | list from `functions:read`, `runs:read`, `runs:write`, `runs:priority`, `admin` | SPEC.md:214-215, docs/API.md:44-45 |
| `functions` | list of globs; required unless `scopes` contains `admin` | SPEC.md:964 |
| `maxQueued` | optional integer; queued runs per function for this key, enforced at `CreateRun` through `countQueuedBy` with 429 `QUEUE_FULL` `metadata.limit: key` | SPEC.md:965, SPEC.md:974-975, docs/API.md:340 |

Location: key `keys.yaml` of a Secret mounted at the parent directory of
`KRUN_API_KEYS_PATH` (default `/etc/krun/keys.yaml`), never with `subPath`
(SPEC.md:954-956, SPEC.md:1191). Reason: Secret volume updates arrive as a
symlink swap of the whole directory, which a `subPath` mount never sees
(D12 SPEC.md:1453). The chart renders no `kind: Secret`; the platform team
creates it (SPEC.md:1316, skill-plan 1.9).

## 2. Scopes and what they unlock

| Scope | Methods | Source |
|---|---|---|
| `functions:read` | `ListFunctions`, `GetFunction` | SPEC.md:202-203 |
| `runs:read` | `GetRun`, `ListRuns`, `WaitRun`, `GetRunResult`, `WatchRun` | SPEC.md:205-210 |
| `runs:write` | `CreateRun`, `CancelRun` | SPEC.md:204, SPEC.md:208 |
| `runs:priority` | `priority` above 0 on `CreateRun`; missing scope is 403 `SCOPE_MISSING` with `metadata.scope` | SPEC.md:234, docs/API.md:331, D25 |
| `admin` | every scope; sees every function (globs not required) and every run (any `created_by`) | SPEC.md:215-217, SPEC.md:938-939, SPEC.md:972-973 |

Owner scoping: a non-admin key sees only the runs it created; another
key's run is 404 `RUN_NOT_FOUND`; a function outside its globs, missing or
not Ready is 404 `FUNCTION_NOT_FOUND` with one generic message
(SPEC.md:215-217, docs/API.md:190-193, docs/API.md:225-227). Scope is
checked before the owner lookup (403 before 404), and the key is checked
before anything else (401 before 403); the public error table fixes the
reasons (`endpoints.md` section 4).

## 3. Globs

- `functions` entries are globs matched against the Function name (a
  DNS-1123 label, docs/API.md:19). Convert in house to an anchored RegExp:
  `*` → `[^/]*`-style "any run of label characters", `?` → one character,
  every other character escaped (PLAN.md:82-83). No `**`, no character
  classes, no negation unless a task asks for them (PLAN.md:31-32).
- A key with globs that match nothing gets an empty `ListFunctions`, not an
  error (docs/API.md:185-186).
- Compile the globs once per load, not per request.

## 4. Lookup and comparison

- Lookup is constant-time with respect to the secret value (SPEC.md:956-957,
  PLAN.md:347): never index a `Map` by the presented bearer string. Hash
  every configured secret at load time (SHA-256), hash the presented
  bearer at request time, and compare each configured hash with
  `crypto.timingSafeEqual` on equal-length buffers; iterate over all keys
  without early return so the loop length does not leak which name matched.
  A length mismatch on the raw string must not short-circuit either, which
  is why the comparison happens on fixed-length hashes.
- The result of a lookup is the key record (`name`, scopes, compiled globs,
  `maxQueued`), never the secret; the hook decorates `request.key` with that
  record. A miss is the `KeyInvalid` tagged error, mapped like every other
  (SKILL.md Rule 3).
- Reject `Authorization` headers that are not exactly `Bearer <token>` as
  401 `KEY_MISSING`; an unknown bearer is 401 `KEY_INVALID`
  (docs/API.md:330). Audit lines carry `key: null` on 401
  (PLAN.md:380-381, SPEC.md:1156-1159).
- Never log, echo or store the secret (SPEC.md:1087-1089, SPEC.md:1151-1152);
  tests generate their own keys (PLAN.md:33).

## 5. Reload and rotation

- Reload by a 30 s poll on the content hash of the file; a changed hash
  re-parses and atomically swaps the in-memory key set; an unchanged hash
  does nothing (SPEC.md:956, D12 SPEC.md:1453). The key set lives in a
  `Ref`; the poll is a fiber forked into the layer's scope with
  `Effect.repeat(Schedule.spaced("30 seconds"))`, so it stops with the
  scope and tests drive it with `TestClock.adjust("30 seconds")`.
- A file that fails to parse or validate at startup fails the layer with
  a tagged error naming the problem (runMain exits 1); a file that fails on a later poll keeps the previous key set and
  logs an error (SPEC fixes only the startup behaviour, SPEC.md:1178-1184;
  keeping the last good set is the conservative reading — record it in the
  test, not as a new rule).
- Rotation (SPEC.md:969-970): append the new secret to the `key` list,
  wait one 30 s reload, switch clients, remove the old secret. Both secrets
  authenticate as the same `name` in between, so `created_by` and owner
  scoping are unaffected by rotation.
- The scheduler never reads `keys.yaml` (D25 SPEC.md:1466); only the gateway
  mounts it.

## 6. Loader validation rules (startup, exit 1)

One Zod schema: `z.strictObject({ keys: z.array(entry) })` with `entry` a
`z.strictObject` and a `superRefine` for the cross-field and uniqueness
rules. Report the entry index and field from the first issue's `path`,
never the issue's input (it may be a secret).

| Check | Error |
|---|---|
| top level is `{ keys: [...] }` | malformed file |
| each entry has `name`, `key`, `scopes` | missing field, name the entry index |
| `name` is a valid label value and unique | duplicate name rejected (SPEC.md:969) |
| `key` is a non-empty string or a non-empty list of non-empty strings | invalid key |
| every scope is one of the five | unknown scope |
| `functions` present and non-empty unless `admin` in scopes | missing globs (SPEC.md:964) |
| `maxQueued`, when present, is an integer ≥ 1 | invalid maxQueued |
| no unknown fields on an entry | unknown field (consistent with the API's rejection of unknown fields, docs/API.md:50-51) |

## 7. P2.4 acceptance (PLAN.md:349-350)

`@effect/vitest` tests (gate `pnpm exec vitest run
packages/shared/src/auth`, PLAN.md:317) for: allowed; denied (wrong scope,
glob miss); `admin`; a key with two secrets during rotation (both
authenticate as one name); a duplicate name rejected. Add: a poll that
sees a changed hash swaps the set, an unchanged hash does not re-parse,
both driven by `TestClock.adjust("30 seconds")`, never a real sleep.
