---
name: krun-webhooks-objstore
description: Use when building krun webhooks, SSRF guard or S3. picomatch host globs, pinned-address delivery, timestamped HMAC, traceparent on deliveries, retry schedule, presigned URLs.
---

# krun webhooks and object storage

Covers `packages/shared/src/webhook` (host allowlist, address check, pinned
undici dispatcher, HMAC signing), the scheduler's deliveries loop, and
`packages/shared/src/objstore` (the `ObjectStore` Effect service: presigned
PUT/GET, object exists). PLAN tasks P2.1, P5.3, P6.1, P6.2, plus the call
sites in P3.3 (`CreateRun` callback check) and P3.6 (`GetRunResult` 307).

## When to use

- Any file under `packages/shared/src/webhook/**` or
  `packages/shared/src/objstore/**`, or the `ObjectStore` layer in
  `packages/shared/src/runtime`.
- The scheduler deliveries loop (P5.3), or the `KRUN_RESULT_UPLOAD_URL` and
  object-exists steps of the terminal path (P6.2).
- The gateway's `CALLBACK_NOT_ALLOWED` branch (P3.3) or the presigned GET
  redirect in `GetRunResult` (P3.6).

Load `krun-development` first (agent protocol), plus the Effect skills
docs/STACK.md section 5 lists (`effect-core-patterns`,
`effect-error-handling`, `effect-concurrency`, `effect-resource-management`,
`effect-testing`). Effect's `MIGRATION.md` overrides any Effect 3 text in
them. Owned elsewhere; link, do not restate: Store side (`claimDeliveries`,
`updateDelivery`, delivery insert in `transition`) is `krun-store`;
terminal-path ordering and leader loops are `krun-scheduler-k8s`; HTTP
envelope for gateway errors is `krun-gateway-api`.

## Read first

- docs/STACK.md sections 1, 2.2 (`undici`), 2.4 (`@aws-sdk/*`), 2.5
  (`ipaddr.js`, `uuid`, `picomatch`), 2.6 (OpenTelemetry), 3 (Vitest,
  `@effect/vitest`, fast-check, testcontainers), 4.2 (tagged errors), 4.3
  (SPEC rules mapped to Effect), 4.4 (time). Normative for every library
  choice below.
- SPEC.md:1074-1098 (section 9 Webhooks: address check, dispatcher,
  signature); SPEC.md:1139-1152 (telemetry: deliveries send a W3C
  `traceparent`; span attribute redaction).
- SPEC.md:921-928 (deliveries loop), SPEC.md:1119 (limits row),
  SPEC.md:1146 (metric).
- SPEC.md:348-351 (delivery inserted in the terminal transaction),
  SPEC.md:452-464 (DDL), SPEC.md:515-516 (Store methods).
- SPEC.md:642-656 (object storage flow), SPEC.md:612 and SPEC.md:636-638
  (Job env, container contract), SPEC.md:863-875 (terminal order).
- SPEC.md:1178-1184 and SPEC.md:1212-1216 (config coupling, variables),
  SPEC.md:1149-1154 (redaction).
- SPEC.md:1013-1026 (jobs namespace egress); docs/OPERATIONS.md:58-60 and
  :114-121 (lifecycle rule, rotation, in-cluster receivers).
- docs/API.md:109 (`resultUri`: only with `SUCCEEDED`, never beside
  `result`), docs/API.md:269-281 (`GetRunResult`), docs/API.md:327
  (`CALLBACK_NOT_ALLOWED`), docs/API.md:368-402 (webhook contract and
  example); docs/INTERNAL-API.md section 4 (the upload as the function sees
  it).
- PLAN.md:319-328 (P2.1), :396-408 (P3.3), :428-430 (P3.6), :638-645 (P5.3),
  :646-649 (P5.4), :657-667 (P6.1, P6.2); PLAN.md:36-91 allowed
  dependencies.
- Decisions D29, D31, D35, D36 (SPEC section 15).

| Reference | Holds |
|---|---|
| [references/ssrf-check.md](references/ssrf-check.md) | glob grammar, address-check algorithm, required test vectors, pinned dispatcher code (P2.1) |
| [references/signature.md](references/signature.md) | headers, `sign`/`verify` code, rotation, signature tests |
| [references/delivery-schedule.md](references/delivery-schedule.md) | loop constants, schedule table, tick code, lease arithmetic, shutdown, logging, P5.3 acceptance |
| [references/objstore.md](references/objstore.md) | config, keys, TTLs, `ObjectStore` service shape, `result_ref` flow, exists-before-CAS, lifecycle, egress, tests |
| [references/library-facts.md](references/library-facts.md) | undici, ipaddr.js, AWS presigner, testcontainers, Effect, `node:crypto`, picomatch API facts (UNVERIFIED by execution) |

## Rules

1. Match the callback host against `KRUN_WEBHOOK_ALLOWED_HOSTS` globs first,
   then resolve and check the address. A host match alone never admits a
   URL: DNS can point an allowed name at a private address
   (SPEC.md:1062-1066).
2. Unwrap IPv4-mapped IPv6 before classifying (`ipaddr.process`), so
   `::ffff:127.0.0.1` is judged as `127.0.0.1` (SPEC.md:1063, PLAN.md:320).
3. Accept an address only when `subnetMatch` places it in
   `KRUN_WEBHOOK_ALLOWED_CIDRS` or its `range()` is exactly `unicast`. Reject
   every other range; no exceptions list (SPEC.md:1064-1068, D31
   SPEC.md:1472).
4. Check at create in the gateway (400 `CALLBACK_NOT_ALLOWED`,
   `fieldViolations[0].field` = `callback.url`, docs/API.md:327). Check again
   in the scheduler at every delivery attempt (SPEC.md:1069): the resolution
   can change between the two.
5. Connect through an undici `Agent` whose `connect.lookup` returns only the
   checked address and whose `connect.servername` is the URL host
   (SPEC.md:1070-1071). The lookup hook is the only thing that stops a
   TOCTOU re-resolution between check and connect. The Agent is a scoped
   resource (`Effect.acquireRelease`, closed in the release).
6. `fetch(url, { redirect: 'manual', dispatcher, signal })`; any 3xx fails
   the attempt (SPEC.md:1072-1073). undici returns the 3xx as a normal
   response, so a `response.ok` check alone would mark it failed. Still
   write the explicit branch, `status >= 200 && status < 300` only, and test
   it (PLAN.md:644): a receiver answering 302 to a login page looks like "a
   response arrived".
7. Sign per attempt over the exact bytes sent:
   `X-Krun-Signature: t=<unix s>,v1=<hex HMAC-SHA256("<t>.<body>")>`. One
   `v1=` per secret in comma-separated `KRUN_WEBHOOK_SECRET`, so `v1=`
   repeats during rotation (SPEC.md:1075-1078, D29). Read `t` from Effect
   `Clock` inside the attempt and pass it to the pure signer. Never cache a
   signature across attempts.
8. `X-Krun-Delivery` is the `deliveries.id`, constant across every attempt
   of one delivery (receivers dedupe on it). `X-Krun-Run-Id` is the bare
   UUIDv7. The body is `toRunSummary` of the terminal row (BASIC view, no
   `result`), serialised once and stored in `deliveries.payload`
   (SPEC.md:1079-1083, SPEC.md:349-351, docs/API.md:372-384).
9. Deliveries loop: an Effect fiber in the leader scope, `Effect.repeat`
   with `Schedule.spaced("5 seconds")`. Each tick: `claimDeliveries(now, 40)`
   (60 s lease set in the claim statement);
   `Effect.forEach(batch, attemptOne, { concurrency: 8 })`; each POST under
   `Effect.timeout("10 seconds")`. `delivered` on 2xx only; else
   `attempt + 1` and `next_at` from `1m 5m 30m 2h 12h`; `dead` after the
   sixth failure (six attempts over about 15 h). Await the whole batch;
   re-claim at once when the batch was full (SPEC.md:921-928,
   docs/API.md:374-376). The schedule is persistent (`next_at` in the row),
   never an in-process `Effect.retry`: a 12 h retry held in a fiber dies
   with the leader.
10. The scheduler refuses to start with `KRUN_WEBHOOK_ALLOWED_HOSTS` set and
    `KRUN_WEBHOOK_SECRET` empty, and exits 1 on a CIDR that does not parse
    (SPEC.md:1179-1183). Empty `KRUN_WEBHOOK_ALLOWED_HOSTS` disables
    webhooks (SPEC.md:1214). Both are Zod refinements in the Config schema
    (`packages/shared/src/config`), parsed once (P0.5). `webhook` receives
    parsed values (compiled picomatch matcher, parsed CIDRs) from the
    `Config` service and never reads `process.env`.
11. Object key is `runs/<id>/result.json` in `KRUN_S3_BUCKET`. The PUT is
    presigned at Job creation with only the host signed: no `Content-Type`,
    no size condition, `requestChecksumCalculation: "WHEN_REQUIRED"` on the
    client. TTL `KRUN_S3_PRESIGN_TTL`, default the Function's
    `activeDeadlineSeconds` (SPEC.md:643-652, SPEC.md:1213). `getSignedUrl`
    signs every header on the command: `ContentType: 'application/json'`
    would force the function to send that exact header. Signing only the
    host lets the SDK and plain `curl` both upload (SPEC.md:649-651, P6.1
    acceptance PLAN.md:659-661).
12. On the terminal transition, check the object only when object storage
    is configured, the Job completed and no inline `result` was accepted.
    Carry `result_ref = s3://<bucket>/<key>` in the CAS patch, so the
    delivery carries `resultUri`. Only `HeadObject` `NotFound` (404) means
    "no object". A missing bucket, a bad key or a network error is an
    `ObjectStoreError`: it leaves the run untransitioned for the next tick
    (SPEC.md:863-873). So `resultUri` appears only on `SUCCEEDED`, never
    beside an inline `result` (docs/API.md:109, :281).
13. The gateway presigns the GET with a fixed 300 s TTL and answers 307 with
    `Cache-Control: no-store` (SPEC.md:652-653, docs/API.md:272-277). The
    client follows it without `Authorization`; add no krun header to the
    redirect, or object stores reject the request (docs/API.md:274-276).
14. krun never deletes objects; a bucket lifecycle rule of at least
    `KRUN_RETENTION` does (SPEC.md:654-655, docs/OPERATIONS.md:58-60).
    Object age counts from upload, before `finishedAt`: a rule equal to
    `KRUN_RETENTION` can expire an object before the row is swept. Say "at
    least".
15. Never log a presigned URL, a webhook secret, a signature or a delivery
    body. Env lists and bodies are outside the pino redact list and must not
    reach a logger at all (SPEC.md:1151-1154).
16. Time comes from `Clock` and `DateTime` (CLAUDE.md rule 8, docs/STACK.md
    section 4.4). Pure helpers (`sign`, `verify`, `checkAddress`) take `now`
    as a parameter; callers pass Clock time; tests pass fixed values or run
    under `TestClock`.
17. Failures are tagged (`Data.TaggedError`): `CallbackNotAllowed` with the
    reason, `DeliveryTransportError`, `ObjectStoreError`. Adapters convert
    promise rejections with `Effect.tryPromise`; no `throw` outside adapters
    (docs/STACK.md section 4.2).
18. Only docs/STACK.md dependencies: `effect`, `undici`, `ipaddr.js`,
    `picomatch`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
    `@effect/opentelemetry` (through the process's telemetry layer),
    `node:crypto`, `node:dns/promises`. Host globs are `picomatch` matchers
    compiled once at config load, never a hand-written regex (docs/STACK.md
    2.5, 4.3). `nocase: false` is the STACK setting, so the Config
    refinement lowercases each host glob before compiling; without that,
    `*.Acme.com` silently matches nothing. Anything else needs a Decisions
    row (PLAN.md:29-30).
19. Every delivery attempt is an Effect span
    (`Effect.withSpan("webhook.deliver")`; attributes: delivery id,
    `krun.run_id`, attempt number, HTTP status; never the URL query, body,
    signature or secret). It sends a W3C `traceparent` header for that span
    (SPEC.md:1149-1156). The header is per attempt and outside the
    signature (which covers `<t>.<body>` only); receivers must not need it.
    Details: references/signature.md.

## Address check and dispatcher (P2.1)

Algorithm, test vectors, glob grammar: [references/ssrf-check.md](references/ssrf-check.md).

| Step | What | Citation |
|---|---|---|
| 1 | `new URL(callback.url)`; scheme must be `http:` or `https:`; host glob must match an allowlist entry | SPEC.md:1062 |
| 2 | Literal IP host: skip DNS, parse directly. Name: `dns.promises.lookup(host, { all: true })` inside `Effect.tryPromise` | SPEC.md:1063 |
| 3 | For each address `ipaddr.process(a)` (unwraps `::ffff:`), then allowed if `subnetMatch` hits a listed CIDR, else only `range() === 'unicast'` | SPEC.md:1064-1068 |
| 4 | Every resolved address must pass; the first passing address is the pinned one | SPEC.md:1070-1071 |
| 5 | Acquire the `Agent` with `connect: { lookup: (_h, _o, cb) => cb(null, pinned, family), servername: url.hostname }`; release closes it | SPEC.md:1070-1071 |
| 6 | `fetch(url, { method: 'POST', redirect: 'manual', dispatcher, signal })` in `Effect.tryPromise`, under `Effect.timeout("10 seconds")` | SPEC.md:1072, SPEC.md:922 |

Expose one pure `checkAddress(addrs, cidrs)` (no network) and one Effect
`resolveAndCheck(url, cfg)` on top, so the P2.1 vectors are unit tests
without DNS.

## Signing, deliveries, object storage

- Signing (P2.1, used by P5.3): [references/signature.md](references/signature.md).
  Rotation is docs/OPERATIONS.md:114-117: set `new,old`, restart the
  scheduler, roll receivers, drop `old`, restart again.
- Deliveries loop (P5.3): [references/delivery-schedule.md](references/delivery-schedule.md).
  Store side is `krun-store` (`claimDeliveries`, `updateDelivery`,
  SPEC.md:515-516); leader-only placement next to the main loop is
  `krun-scheduler-k8s`.
- Object storage (P6.1, P6.2, P3.6): [references/objstore.md](references/objstore.md).
  `krun-scheduler-k8s` owns the terminal-path order (object check, CAS with
  delivery inside, Secret delete, Job delete); this skill owns the object
  check step and the presigner.

## Lessons from Dapr

| Dapr behaviour (source) | krun rule |
|---|---|
| publishes before commit, then needs a 1 s scan delay, a 10 s polling window and a "marker missing" branch (dapr pkg/runtime/pubsub/outbox.go:42, :307-342) | insert the delivery in the terminal transaction and nothing else (SPEC.md:348-351, D29). Add no pre-publish and no marker |
| deletes the outbox marker after a successful publish (outbox.go:364-373) | mark the row after the 2xx in its own statement (`updateDelivery`); never hold the delivery POST inside a database transaction |
| exponential policies with jitter, because many clients hit one broker (pkg/resiliency/resiliency.go:396-407, pkg/backoff/jitter.go:21-50); per-endpoint breaker (pkg/resiliency/breaker/circuitbreaker.go:29-54) | keep the fixed schedule `1m 5m 30m 2h 12h` (SPEC.md:926). No jitter, no `Schedule.exponential`, no circuit breaker (non-goal, PLAN.md:31-32) |
| publishes to the DLQ, acks only when that succeeds (pkg/runtime/subscription/subscription.go:407-420) | the row is the dead-letter queue: `state = 'dead'` with `last_error`. Write `last_error` on every failure, not only the last |
| blocks on the context during shutdown, because a nack would wrongly dead-letter (subscription.go:394-405) | never mark a delivery `dead` or failed because of shutdown. An attempt interrupted by SIGTERM or lost leadership stays `pending` with its leased `next_at`; the next leader re-claims it after the lease expires |
| DLQ publish detaches the parent deadline but honours explicit cancel (subscription.go:86-92, :575-600) | every POST gets its own `Effect.timeout("10 seconds")`, never the tick's remaining time; interruption of the leader scope still reaches it |
| attempt number and next delay at warn, error at debug, recovery at info (pkg/resiliency/policy.go:345-354) | same levels; never the body or the signature |
| compares its API token with `!=` (pkg/api/http/middlewares.go:61) | receivers and tests use `timingSafeEqual` (SPEC.md:1078-1079) |

## Pitfalls

- A literal IPv6 host arrives bracketed from `URL.hostname` (`[::1]`).
  Strip the brackets before `ipaddr.process`; otherwise every v6 literal
  fails to parse and is rejected as unparseable rather than as loopback.
  `servername` is the unbracketed name only for DNS names; for IP literals
  set no SNI.
- `dns.promises.lookup` without `{ all: true }` returns one address; a name
  with one public and one private record would pass by luck. Check all
  records and pin one.
- The signature is over the bytes sent. Serialise the payload once at insert
  time (`deliveries.payload`), then send and sign those bytes.
  Re-serialising at send time with a different key order breaks receivers
  that verify against the raw body.
- `Effect.timeout` on a promise only interrupts the fiber. The HTTP request
  stops only if the `signal` from `Effect.tryPromise` is passed to `fetch`;
  without it the socket lingers past 10 s.
- `Effect.forEach` with `concurrency: 8` short-circuits on the first
  failure. `attemptOne` must record every outcome itself and never fail, or
  one bad receiver aborts the batch.
- The presigned PUT goes into the Job env (SPEC.md:612); the Job manifest
  and env list are never logged (SPEC.md:1153-1154). Redact before any debug
  dump of a manifest.
- `KRUN_S3_PRESIGN_TTL` is a duration string (`^\d+(ms|s|m|h)$`,
  SPEC.md:1182-1183) that the Config schema refines into a `Duration`.
  Convert with `Duration.toSeconds` to whole seconds for `expiresIn`;
  `activeDeadlineSeconds` is already seconds.
- `traceparent` comes from the attempt's own span, not the tick's, so each
  retry has its own span id. The attempt span is not in the run's
  `CreateRun` trace: v1 does not join a run's spans across processes (no
  trace column, SPEC section 11). The `krun.run_id` attribute correlates it
  with the run's other spans.

## Before marking a task done

- P2.1: `pnpm exec vitest run packages/shared/src/webhook` green with every
  vector in references/ssrf-check.md, fast-check properties for the address
  check and the signature, and a signature that verifies with each of two
  secrets (PLAN.md:324-328).
- P5.3: `pnpm exec vitest run apps/scheduler/src` with `@effect/vitest` and a
  local `http.createServer` receiver: 500 then 200, 302 counted as failure,
  sixth failure marks `dead`, 40 pending rows with at most 8 in flight
  (PLAN.md:642-645). Schedule steps asserted with `TestClock.adjust`, no
  sleeps.
- P6.1: MinIO testcontainer test; a PUT with `Content-Type: application/json`
  succeeds against the presigned URL (PLAN.md:659-661).
- P6.2: fake `ObjectStore` layer; delivery payload carries `resultUri`;
  inline result skips the check; TTL follows `KRUN_S3_PRESIGN_TTL`, else
  `activeDeadlineSeconds` (PLAN.md:665-667).
- P3.3 / P3.6 call sites: the `CALLBACK_NOT_ALLOWED` row and the
  `GetRunResult` branches (PLAN.md:402, :428-430).
- `make check` green. Progress-log line `2026-xx-xx P2.1 <sha> note` in
  PLAN.md section 6, committed with the code. Branch named after the task
  id, PR to main, never push main, no `Co-Authored-By` (PLAN.md:13-22,
  CLAUDE.md:7).

## Limitations

- SPEC RISK: SPEC.md:1070 names `connect.lookup` on the undici `Agent`. The
  option exists in the shipped undici types, but no runtime execution has
  verified that the pinned address is used for both the TCP connect and TLS
  verification with `servername`. Before the dispatcher is trusted, P2.1
  must include a test: a receiver bound on `127.0.0.1`, reached through a
  hostname whose lookup is pinned there, with a listed CIDR.
- SPEC RISK: the `ipaddr.js` range names come from the package types, not
  execution. The reserved ranges SPEC.md:1066-1068 lists (`0.0.0.0/8`,
  `100.64/10`, `fe80::/10`, `fc00::/7`) must each appear in the test
  vectors, so a `range()` naming difference surfaces as a failing test, not
  a silent accept.
- Per-host circuit breaker, jitter, Retry-After honouring on webhooks and a
  receiver SDK are not in SPEC. Do not add them without a Decisions row
  (PLAN.md:23-26, :31-32).
- The address check cannot defend against a receiver that itself redirects
  internally, or a DNS rebind after connect. The pinned lookup covers the
  connection krun opens, nothing beyond it.
