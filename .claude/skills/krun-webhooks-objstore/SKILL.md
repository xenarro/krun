---
name: krun-webhooks-objstore
description: Use when building krun webhooks, SSRF guard or S3. Pinned-address delivery, timestamped HMAC, retry schedule, presigned URLs.
---

# krun webhooks and object storage

Covers `packages/shared/src/webhook` (host allowlist, address check, pinned
undici dispatcher, HMAC signing), the scheduler's deliveries loop, and
`packages/shared/src/objstore` (the `ObjectStore` Effect service: presigned
PUT/GET, object exists). Serves PLAN tasks P2.1, P5.3, P6.1, P6.2 and the
call sites in P3.3 (`CreateRun` callback check) and P3.6 (`GetRunResult`
307).

## When to use

- Any file under `packages/shared/src/webhook/**` or
  `packages/shared/src/objstore/**`, or the `ObjectStore` layer in
  `packages/shared/src/runtime`.
- The scheduler deliveries loop (P5.3) or the `KRUN_RESULT_UPLOAD_URL` and
  object-exists steps of the terminal path (P6.2).
- The gateway's `CALLBACK_NOT_ALLOWED` branch (P3.3) or the presigned GET
  redirect in `GetRunResult` (P3.6).
- Load `krun-development` first for the agent protocol, and the Effect
  skills docs/STACK.md section 5 lists (`effect-core-patterns`,
  `effect-error-handling`, `effect-concurrency`, `effect-resource-management`,
  `effect-testing`); Effect's `MIGRATION.md` overrides any Effect 3 text in
  them. The Store side (`claimDeliveries`, `updateDelivery`, delivery insert
  in `transition`) is `krun-store`; the terminal-path ordering and the leader
  loops are `krun-scheduler-k8s`; the HTTP envelope for the gateway errors is
  `krun-gateway-api`. Link, do not restate.

## Read first

- docs/STACK.md sections 1, 2.2 (`undici`), 2.4 (`@aws-sdk/*`), 2.5
  (`ipaddr.js`, `uuid`), 3 (Vitest, `@effect/vitest`, fast-check,
  testcontainers), 4.2 (tagged errors), 4.3 (SPEC rules mapped to Effect),
  4.4 (time). It is normative for every library choice below.
- SPEC.md:1060-1083 (section 9 Webhooks: address check, dispatcher, signature).
- SPEC.md:921-928 (deliveries loop), SPEC.md:1119 (limits row), SPEC.md:1146 (metric).
- SPEC.md:348-351 (delivery inserted in the terminal transaction), SPEC.md:452-464 (DDL),
  SPEC.md:515-516 (Store methods).
- SPEC.md:642-656 (object storage flow), SPEC.md:612 and SPEC.md:636-638 (Job env and container
  contract), SPEC.md:863-875 (terminal order).
- SPEC.md:1178-1184 and SPEC.md:1212-1216 (config coupling and variables), SPEC.md:1149-1154
  (redaction).
- SPEC.md:1013-1026 (jobs namespace egress), docs/OPERATIONS.md:58-60 and :114-121 (lifecycle rule,
  rotation, in-cluster receivers).
- docs/API.md:109 (`resultUri`: only with `SUCCEEDED`, never beside `result`), docs/API.md:269-281
  (`GetRunResult`), docs/API.md:327 (`CALLBACK_NOT_ALLOWED`), docs/API.md:368-402 (webhook contract
  and example); docs/INTERNAL-API.md section 4 (the upload as the function sees it).
- PLAN.md:319-328 (P2.1), :396-408 (P3.3), :428-430 (P3.6), :638-645 (P5.3), :646-649 (P5.4),
  :657-667 (P6.1, P6.2); PLAN.md:36-91 for allowed dependencies.
- Decisions D29 (SPEC.md:1470), D31 (SPEC.md:1472) and D35 (SPEC.md:1476).

## Rules

1. Match the callback host against `KRUN_WEBHOOK_ALLOWED_HOSTS` globs first, then resolve and check
   the address; a host match alone never admits a URL (SPEC.md:1062-1066) because DNS can point an
   allowed name at a private address.
2. Unwrap IPv4-mapped IPv6 before classifying (`ipaddr.process`), so `::ffff:127.0.0.1` is judged as
   `127.0.0.1` (SPEC.md:1063, PLAN.md:320).
3. Accept an address only when `subnetMatch` places it in `KRUN_WEBHOOK_ALLOWED_CIDRS` or its
   `range()` is exactly `unicast`; every other range is rejected, no exceptions list
   (SPEC.md:1064-1068, D31 SPEC.md:1472).
4. Check at create in the gateway (400 `CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field` =
   `callback.url`, docs/API.md:327) and again in the scheduler at every delivery attempt
   (SPEC.md:1069) because the resolution can change between the two.
5. Connect through an undici `Agent` whose `connect.lookup` returns only the checked address and
   whose `connect.servername` is the URL host (SPEC.md:1070-1071); the lookup hook is the only thing
   that stops a TOCTOU re-resolution between check and connect. The Agent is a scoped resource
   (`Effect.acquireRelease`, closed in the release).
6. `fetch(url, { redirect: 'manual', dispatcher, signal })`; any 3xx response fails the attempt
   (SPEC.md:1072-1073). undici returns the 3xx as a normal response, so a `response.ok` check alone
   would mark it failed, but write the explicit branch and test it (PLAN.md:644).
7. Sign per attempt over the exact bytes sent: `X-Krun-Signature: t=<unix s>,v1=<hex
   HMAC-SHA256("<t>.<body>")>`, one `v1=` per secret in comma-separated `KRUN_WEBHOOK_SECRET`, so
   `v1=` repeats during rotation (SPEC.md:1075-1078, D29); `t` is read from Effect `Clock` inside
   the attempt and passed to the pure signer; never cache a signature across attempts.
8. `X-Krun-Delivery` is the `deliveries.id`, constant across every attempt of one delivery
   (receivers dedupe on it); `X-Krun-Run-Id` is the bare UUIDv7; the body is `toRunSummary` of the
   terminal row (the BASIC view, no `result`), serialised once and stored in `deliveries.payload`
   (SPEC.md:1079-1083, SPEC.md:349-351, docs/API.md:372-384).
9. Deliveries loop as an Effect fiber in the leader scope: `Effect.repeat` with
   `Schedule.spaced("5 seconds")`; each tick `claimDeliveries(now, 40)` (60 s lease set in the claim
   statement), `Effect.forEach(batch, attemptOne, { concurrency: 8 })`, each POST under
   `Effect.timeout("10 seconds")`, `delivered` on 2xx only, else `attempt + 1` and `next_at` from
   `1m 5m 30m 2h 12h`, `dead` after the sixth failure (six attempts over about 15 h); await the
   whole batch and re-claim at once when the batch was full (SPEC.md:921-928, docs/API.md:374-376).
   The attempt schedule is persistent (`next_at` in the row), never an in-process `Effect.retry`: a
   12 h retry held in a fiber dies with the leader.
10. The scheduler refuses to start with `KRUN_WEBHOOK_ALLOWED_HOSTS` set and `KRUN_WEBHOOK_SECRET`
    empty, and exits 1 on a CIDR that does not parse (SPEC.md:1179-1183); empty
    `KRUN_WEBHOOK_ALLOWED_HOSTS` disables webhooks (SPEC.md:1214). Both are Zod refinements in the
    Config schema (`packages/shared/src/config`), parsed once.
11. Object key is `runs/<id>/result.json` in `KRUN_S3_BUCKET`; the PUT is presigned at Job creation
    with only the host signed (no `Content-Type`, no size condition, `requestChecksumCalculation:
    "WHEN_REQUIRED"` on the client) for `KRUN_S3_PRESIGN_TTL`, default the Function's
    `activeDeadlineSeconds` (SPEC.md:643-652, SPEC.md:1213).
12. On the terminal transition, check the object only when object storage is configured, the Job
    completed and no inline `result` was accepted; carry `result_ref = s3://<bucket>/<key>` in the
    CAS patch so the delivery carries `resultUri`; an `ObjectStoreError` other than not-found leaves
    the run untransitioned for the next tick (SPEC.md:863-873). `resultUri` therefore appears only
    on `SUCCEEDED` and never beside an inline `result` (docs/API.md:109, :281).
13. The gateway presigns the GET with a fixed 300 s TTL and answers 307 with `Cache-Control:
    no-store` (SPEC.md:652-653, docs/API.md:272-277).
14. krun never deletes objects; a bucket lifecycle rule of at least `KRUN_RETENTION` does
    (SPEC.md:654-655, docs/OPERATIONS.md:58-60).
15. Never log a presigned URL, a webhook secret, a signature or a delivery body; env lists and
    bodies are outside the pino redact list and must not reach a logger at all (SPEC.md:1151-1154).
16. Time comes from `Clock` and `DateTime` (CLAUDE.md rule 8, docs/STACK.md section 4.4). Pure
    helpers (`sign`, `verify`, `checkAddress`) take `now` as a parameter; their callers pass Clock
    time, tests pass fixed values or run under `TestClock`.
17. Failures are tagged (`Data.TaggedError`): `CallbackNotAllowed` with the reason,
    `DeliveryTransportError`, `ObjectStoreError`; adapters convert promise rejections with
    `Effect.tryPromise`; no `throw` outside adapters (docs/STACK.md section 4.2).
18. Only docs/STACK.md dependencies: `effect`, `undici`, `ipaddr.js`, `@aws-sdk/client-s3`,
    `@aws-sdk/s3-request-presigner`, `node:crypto`, `node:dns/promises`; glob-to-regex is written in
    house (PLAN.md:82-87). Anything else needs a Decisions row (PLAN.md:29-30).

## Address check and dispatcher (P2.1)

Algorithm, required test vectors and the glob grammar are in
[references/ssrf-check.md](references/ssrf-check.md). Summary:

| Step | What | Citation |
|---|---|---|
| 1 | `new URL(callback.url)`; scheme must be `http:` or `https:`; host glob must match an allowlist entry | SPEC.md:1062 |
| 2 | Literal IP host: skip DNS, parse directly. Name: `dns.promises.lookup(host, { all: true })` inside `Effect.tryPromise` | SPEC.md:1063 |
| 3 | For each address `ipaddr.process(a)` (unwraps `::ffff:`), then allowed if `subnetMatch` hits a listed CIDR, else only `range() === 'unicast'` | SPEC.md:1064-1068 |
| 4 | Every resolved address must pass; the first passing address is the pinned one | SPEC.md:1070-1071 |
| 5 | Acquire the `Agent` with `connect: { lookup: (_h, _o, cb) => cb(null, pinned, family), servername: url.hostname }`; release closes it | SPEC.md:1070-1071 |
| 6 | `fetch(url, { method: 'POST', redirect: 'manual', dispatcher, signal })` in `Effect.tryPromise`, under `Effect.timeout("10 seconds")` | SPEC.md:1072, SPEC.md:922 |

Expose one pure function `checkAddress(addrs, cidrs)` (no network) and one
Effect `resolveAndCheck(url, cfg)` on top, so the P2.1 vectors are unit
tests without DNS.

## Signing (P2.1, used by P5.3)

Header format, per-attempt computation, receiver verification pseudo-code
and the rotation procedure are in
[references/signature.md](references/signature.md). The rotation sequence
is docs/OPERATIONS.md:114-117: set `new,old`, restart the scheduler, roll
receivers, drop `old`, restart again.

## Deliveries loop (P5.3)

Loop constants, the schedule table, lease arithmetic, shutdown behaviour
and the metric are in
[references/delivery-schedule.md](references/delivery-schedule.md).
The Store side is `krun-store` (`claimDeliveries`, `updateDelivery`,
SPEC.md:515-516); the leader-only placement next to the main loop is
`krun-scheduler-k8s`.

## Object storage (P6.1, P6.2, P3.6)

Keys, TTLs, the `ObjectStore` service shape, the `result_ref` flow, the
exists-before-CAS ordering, egress policy and the lifecycle rule are in
[references/objstore.md](references/objstore.md). The terminal-path order
(object check, CAS with delivery inside, Secret delete, Job delete) is owned
by `krun-scheduler-k8s`; this skill owns the object check step and the
presigner.

## Library facts

Versions from docs/STACK.md section 2 (verified against npm 2026-10-23); the
API shapes below are UNVERIFIED by execution, confirm in a REPL before
relying on them:

- undici `^8.12`: `new Agent({ connect: { lookup, servername, timeout, rejectUnauthorized } })`;
  `connect.lookup` has the `dns.lookup` callback signature; `fetch(url, { dispatcher, redirect:
  'manual' })` returns the real 3xx response with its `Location` (not a browser opaque-redirect).
  Import `fetch` and `Agent` from the `undici` package: Node's global fetch is a bundled undici and
  ignores the package's dispatcher. `@effect/platform-node`'s `Undici` module is unstable and not
  used (docs/STACK.md section 2.1).
- ipaddr.js `^2.5`: `ipaddr.process(str)` parses v4 or v6 and converts IPv4-mapped to IPv4;
  `addr.range()` returns `unicast`, `private`, `loopback`, `linkLocal`, `multicast`, `broadcast`,
  `carrierGradeNat`, `reserved`, `unspecified`, `uniqueLocal`, `ipv4Mapped`, `6to4`, `teredo`, ...;
  `ipaddr.subnetMatch(addr, { allowed: [[ipaddr.parse(net), bits], ...] }, 'default')` for the CIDR
  list. `subnetMatch` with a v4 address against v6 ranges (or the reverse) is a mismatch, so build
  the range list per family or convert first (test it).
- @aws-sdk/s3-request-presigner `^3.1156`: `getSignedUrl(client, new PutObjectCommand({ Bucket, Key
  }), { expiresIn })`, seconds, SigV4 max 7 days; any header given to the command (for example
  `ContentType`) becomes a signed header the uploader must send exactly, which is why SPEC signs
  only the host. Exists: `HeadObjectCommand` rejects with `err.name === 'NotFound'` and
  `$metadata.httpStatusCode === 404`. MinIO needs `forcePathStyle: true` and `endpoint`. Every SDK
  call runs through `Effect.tryPromise` (the `signal` it provides goes to `abortSignal` in the
  command options) inside the `ObjectStore` service.
- testcontainers `^12.2` with `@testcontainers/minio` (`MinioContainer`, image pinned by tag);
  `TESTCONTAINERS_RYUK_DISABLED=true` in CI without privileged Ryuk.
- Effect `~4.0.6`: `Clock.currentTimeMillis`, `DateTime.now`, `Effect.timeout`,
  `Effect.forEach(..., { concurrency })`, `Effect.repeat` with `Schedule.spaced`,
  `Effect.acquireRelease`, `Effect.tryPromise({ try: (signal) => ..., catch })` (interruption,
  including a timeout, aborts `signal`). Services are `Context.Service`s per `MIGRATION.md`.
- `node:crypto`: `createHmac('sha256', secret).update(t + '.').update(bodyBytes).digest('hex')` and
  `timingSafeEqual` on equal-length buffers (docs/STACK.md section 2.5).

## Lessons from Dapr

- Insert the delivery in the terminal transaction and nothing else. Dapr publishes before commit and
  then needs a 1 s scan delay plus a 10 s polling window and a "marker missing" branch (dapr
  pkg/runtime/pubsub/outbox.go:42, :307-342); krun's same-transaction insert (SPEC.md:348-351, D29)
  removes that whole class of races. Do not add a pre-publish or a marker.
- Mark the row after the 2xx in its own statement (`updateDelivery`), the way Dapr deletes the
  outbox marker after a successful publish (outbox.go:364-373); never hold the delivery POST inside
  a database transaction.
- Keep the fixed schedule. Dapr's exponential policies with jitter exist because many clients hit
  one broker (pkg/resiliency/resiliency.go:396-407, pkg/backoff/jitter.go:21-50); webhook receivers
  want predictable retries, and SPEC.md:926 fixes `1m 5m 30m 2h 12h`. Add no jitter, no
  `Schedule.exponential` and no circuit breaker: Dapr's per-endpoint breaker
  (pkg/resiliency/breaker/circuitbreaker.go:29-54) is a non-goal here (PLAN.md:31-32).
- krun's dead-letter queue is the row itself: `state = 'dead'` with `last_error`, like Dapr
  publishing to the DLQ and acking only when that succeeds
  (pkg/runtime/subscription/subscription.go:407-420). Write `last_error` on every failure, not only
  the last.
- Never mark a delivery `dead` or failed because of shutdown. Dapr blocks on the context instead of
  nacking during shutdown because a nack would wrongly dead-letter (subscription.go:394-405). In
  krun an attempt interrupted by SIGTERM or lost leadership stays `pending` with its leased
  `next_at`; the lease expires and the next leader re-claims it.
- Detach the attempt deadline from the loop deadline but keep cancellation. Dapr's DLQ publish
  detaches the parent deadline (the retry budget may have consumed it) but honours explicit cancel
  (subscription.go:86-92, :575-600). Give every POST its own `Effect.timeout("10 seconds")`, never
  the tick's remaining time; interruption of the leader scope still reaches it.
- Log attempt number and next delay at warn and the error at debug, recovery at info
  (pkg/resiliency/policy.go:345-354); never the body or the signature.
- Dapr compares its API token with `!=` (pkg/api/http/middlewares.go:61); receivers and tests here
  use `timingSafeEqual` (SPEC.md:1078-1079).

## Pitfalls

- A literal IPv6 host arrives bracketed from `URL.hostname` (`[::1]`); strip the brackets before
  `ipaddr.process` or every v6 literal fails to parse and is wrongly rejected as unparseable rather
  than as loopback. `servername` must be the unbracketed name only for DNS names; for IP literals
  set no SNI.
- `dns.promises.lookup` without `{ all: true }` returns one address; a name with one public and one
  private record would pass by luck. Check all records and pin one.
- `redirect: 'manual'` returns status 301/302/307/308 as a response object; a receiver answering 302
  to a login page looks like "a response arrived". Branch on `status >= 200 && status < 300` only.
- The signature is over the bytes sent. Serialise the payload once at insert time
  (`deliveries.payload`), send those bytes, and sign those bytes; re-serialising at send time with a
  different key order breaks receivers that verify against the raw body.
- `t` from the wall clock (`Date.now()`) makes the signer untestable under `TestClock` and breaks
  CLAUDE.md rule 8; read `Clock.currentTimeMillis` in the attempt and pass it down.
- `Effect.timeout` on a promise only interrupts the fiber; the HTTP request stops only if the
  `signal` from `Effect.tryPromise` is passed to `fetch`. Without it the socket lingers past 10 s.
- `Effect.forEach` with `concurrency: 8` short-circuits on the first failure; `attemptOne` must
  record every outcome itself and never fail, or one bad receiver aborts the batch.
- `getSignedUrl` signs every header on the command. Passing `ContentType: 'application/json'` would
  force the function to send that exact header; SPEC signs only the host so the SDK and plain `curl`
  both work (SPEC.md:649-651, P6.1 acceptance PLAN.md:659-661).
- The presigned PUT goes into the Job env (SPEC.md:612); the Job manifest and env list are never
  logged (SPEC.md:1153-1154). Redact before any debug dump of a manifest.
- `HeadObject` on a missing key is `NotFound` (404), but a missing bucket, a bad key or a network
  error is not; only `NotFound` means "no object"; everything else is an `ObjectStoreError` that
  leaves the run untransitioned (SPEC.md:872-873).
- Object age for the lifecycle rule counts from upload, which precedes `finishedAt`; a rule equal to
  `KRUN_RETENTION` can expire an object before the run row is swept (docs/OPERATIONS.md:58-60). Say
  "at least".
- A `GetRunResult` 307 must be followed by the client without `Authorization`; do not add a krun
  header to the redirect or object stores reject the request (docs/API.md:274-276).
- `KRUN_S3_PRESIGN_TTL` is a duration string (`^\d+(ms|s|m|h)$`, SPEC.md:1182-1183) that the Config
  schema refines into a `Duration`; convert with `Duration.toSeconds` to whole seconds for
  `expiresIn`; `activeDeadlineSeconds` is already seconds.
- Hosts glob and CIDR parsing happen in `packages/shared/src/config` (P0.5); `webhook` receives
  parsed values from the `Config` service and never reads `process.env`.

## Before marking a task done

- P2.1: `pnpm exec vitest run packages/shared/src/webhook` green with every vector in
  references/ssrf-check.md, fast-check properties for the address check and the signature, and a
  signature that verifies with each of two secrets (PLAN.md:324-328).
- P5.3: `pnpm exec vitest run apps/scheduler/src` with `@effect/vitest` and a local
  `http.createServer` receiver: 500 then 200, 302 counted as failure, sixth failure marks `dead`,
  40 pending rows with at most 8 in flight (PLAN.md:642-645); schedule steps asserted with
  `TestClock.adjust`, no sleeps.
- P6.1: MinIO testcontainer test; a PUT with `Content-Type: application/json` succeeds against the
  presigned URL (PLAN.md:659-661).
- P6.2: fake `ObjectStore` layer; delivery payload carries `resultUri`; inline result skips the
  check; TTL follows `KRUN_S3_PRESIGN_TTL` else `activeDeadlineSeconds` (PLAN.md:665-667).
- P3.3 / P3.6 call sites: the `CALLBACK_NOT_ALLOWED` row and the `GetRunResult` branches
  (PLAN.md:402, :428-430).
- `make check` green; progress-log line `2026-xx-xx P2.1 <sha> note` in PLAN.md section 6 committed
  with the code; branch named after the task id, PR to main, never push main, no `Co-Authored-By`
  (PLAN.md:13-22, CLAUDE.md:7).

## Limitations

- SPEC RISK: SPEC.md:1070 names `connect.lookup` on the undici `Agent`; the option exists in the
  shipped undici types, but no runtime execution has verified that the pinned address is used for
  both the TCP connect and TLS verification with `servername`. P2.1 must include a test that a
  receiver bound on `127.0.0.1` is reached through a hostname whose lookup is pinned there, with a
  listed CIDR, before the dispatcher is trusted.
- SPEC RISK: `ipaddr.js` range names above come from the package types, not execution. The reserved
  ranges SPEC.md:1066-1068 lists (`0.0.0.0/8`, `100.64/10`, `fe80::/10`, `fc00::/7`) must each
  appear in the test vectors so a `range()` naming difference surfaces as a failing test, not a
  silent accept.
- Per-host circuit breaker, jitter, Retry-After honouring on webhooks, and a receiver SDK are not in
  SPEC; do not add them without a Decisions row (PLAN.md:23-26, :31-32).
- The address check cannot defend against a receiver that itself redirects internally or a DNS
  rebind after connect; the pinned lookup covers the connection krun opens, nothing beyond it.
