# Deliveries loop (P5.3)

Source: SPEC.md:921-928, SPEC.md:1119, SPEC.md:1146, SPEC.md:452-464 (DDL),
SPEC.md:515-516 (Store), PLAN.md:638-645, docs/API.md:374-376, docs/STACK.md
section 4.3 (SPEC rules mapped to Effect). Store semantics and SQL belong to
`krun-store`; leader placement to `krun-scheduler-k8s`.

## Constants

| Constant | Value | Effect construct | Citation |
|---|---|---|---|
| tick period | 5 s | `Effect.repeat(Schedule.spaced("5 seconds"))` | SPEC.md:921 |
| claim batch | `claimDeliveries(now, 40)` | `now` from `DateTime.now` | SPEC.md:921 |
| claim lease | 60 s, set as `next_at = now + 60s` inside the claim statement, ordered by `next_at`, skip locked | Store | SPEC.md:515, :921-922 |
| concurrency | 8 in flight | `Effect.forEach(batch, attemptOne, { concurrency: 8, discard: true })` | SPEC.md:922 |
| per-attempt timeout | 10 s | `Effect.timeout("10 seconds")` on the POST | SPEC.md:922, :1119 |
| redirects | not followed; any 3xx fails | `redirect: 'manual'` | SPEC.md:923, :1072-1073 |
| success | 2xx only, `delivered` | | SPEC.md:923 |
| worst-case tick | 40 / 8 × 10 s = 50 s, under the 60 s lease | | SPEC.md:924 |
| re-claim | when the batch returned 40 rows, claim again at once in the same tick | loop inside the tick effect | SPEC.md:924-925 |
| attempts | 6 in all; `dead` after the sixth failure | | SPEC.md:926-927, :1119 |
| total span | about 15 h | | SPEC.md:1119, docs/API.md:375-376 |
| metric | `krun_deliveries_total{state}` on the leader | prom-client counter from the `Metrics` service | SPEC.md:1146 |
| alert | `KrunDeliveriesDead`: `increase(krun_deliveries_total{state="dead"}[1h]) > 0`, warning | | SPEC.md:1399 |

## Schedule

`attempt` counts failed attempts so far (DDL default 0). After a failed
attempt with the row at `attempt = n` before the increment:

| Failed attempt | `attempt` after | `next_at` | Elapsed since insert (approx.) |
|---|---|---|---|
| 1st | 1 | now + 1m | 0 |
| 2nd | 2 | now + 5m | 1m |
| 3rd | 3 | now + 30m | 6m |
| 4th | 4 | now + 2h | 36m |
| 5th | 5 | now + 12h | 2h36m |
| 6th | 6 | `dead`, `next_at` unchanged, `last_error` set | 14h36m |

```ts
const SCHEDULE = [
  Duration.minutes(1), Duration.minutes(5), Duration.minutes(30),
  Duration.hours(2), Duration.hours(12),
] as const
```

Index by the attempt number before increment; `next_at` is
`DateTime.addDuration(now, SCHEDULE[d.attempt])` with `now` from
`DateTime.now`; when `attempt` (after increment) reaches 6 the state is
`dead` (SPEC.md:926-927). The first attempt happens at the next tick after
insert because `next_at = created_at` on insert.

The schedule lives in the row, not in a fiber: this is the one retry in
krun that is not `Effect.retry` with a `Schedule`, because the waits span
hours and must survive restarts and leader changes. No jitter, no
`Schedule.exponential`.

## Tick

```ts
const drain = Effect.gen(function* () {
  while (true) {
    const now = yield* DateTime.now
    const batch = yield* store.claimDeliveries(now, 40)                     // lease 60 s
    yield* Effect.forEach(batch, attemptOne, { concurrency: 8, discard: true }) // awaits the whole batch
    if (batch.length < 40) return
  }
})

// forked into the leader scope by krun-scheduler-k8s; interruption ends it
const deliveriesLoop = drain.pipe(
  Effect.catchTag("DatabaseError", logAndContinue),   // one bad tick never ends the repeat
  Effect.repeat(Schedule.spaced("5 seconds")),
)
```

`attemptOne(d)` never fails; it records every outcome itself:

1. `resolveAndCheck(d.url)` (references/ssrf-check.md); a `CallbackNotAllowed`
   failure is a failed attempt with `last_error` naming the reason
   (SPEC.md:1069).
2. `nowMillis = yield* Clock.currentTimeMillis`;
   `headers = { 'content-type', 'x-krun-delivery': d.id, 'x-krun-run-id': d.runId, 'x-krun-signature': sign(bodyBytes, secrets, nowMillis) }`
   (references/signature.md); `bodyBytes` is `d.payload` serialised once.
   `x-krun-delivery` is the same row id on every attempt.
3. POST through the pinned dispatcher, `redirect: 'manual'`, under
   `Effect.timeout("10 seconds")` (the scoped `post` in
   references/ssrf-check.md).
4. `2xx` → `updateDelivery(d.id, 'delivered', d.attempt, null, null)`;
   increment `krun_deliveries_total{state="delivered"}`.
5. otherwise `n = d.attempt + 1`; `n >= 6` → `updateDelivery(d.id, 'dead', n, null, err)`,
   increment `{state="dead"}`; else `updateDelivery(d.id, 'pending', n, now + SCHEDULE[d.attempt], err)`,
   increment `{state="pending"}`. Label values are the three DDL states
   written by the attempt (`delivered`, `pending`, `dead`, SPEC.md:459);
   invent no fourth value without the P4.6 metrics task agreeing.
6. `last_error` is a short string: `status 500`, `status 302`, `timeout`,
   `address rejected: private`, `ECONNREFUSED`; never the response body.
   Map the timeout failure and the `DeliveryTransportError` cause to these
   strings in one function.

Interrupted (SIGTERM, or leadership lost and the leader scope closed): the
fiber stops before `updateDelivery`; the row stays `pending` under its lease
and the next leader re-claims it after 60 s. Never mark `dead` because of
shutdown (dapr pkg/runtime/subscription/subscription.go:394-405 makes the
same choice), and never wrap the POST plus `updateDelivery` in
`Effect.uninterruptible`: shutdown must not wait 10 s per attempt.

## Lease arithmetic

- Claim sets `next_at = now + 60s` so a concurrent or restarted leader
  cannot re-claim within the lease (P1.7 acceptance, PLAN.md:287-289).
- A successful attempt overwrites `next_at` through `updateDelivery`; a
  failed one sets the scheduled `next_at`, which is always later than the
  lease end except for the 1m step, where it is 60 s too and therefore
  still correct.
- A crash mid-attempt leaves the lease to expire; the attempt counter was
  not incremented, so the schedule is not consumed by crashes, only by
  real failures. Receivers may therefore see the same `X-Krun-Delivery`
  twice (docs/API.md:374-376).

## Logging

- warn: `delivery attempt failed` with `delivery_id`, `run_id`, `attempt`,
  `next_at`, `last_error`; never the url query string, body or signature.
- debug: the underlying cause.
- info: `delivery delivered` with `delivery_id`, `run_id`, `attempt`.
  (Pattern from dapr pkg/resiliency/policy.go:345-354.) Log through the
  Effect `Logger`, which writes to the pino sink (docs/STACK.md section 2.5).

## Acceptance (PLAN.md:642-645)

`@effect/vitest` test (`it.effect`, `TestClock` by default) with
`http.createServer` on `127.0.0.1` and `127.0.0.0/8` in the allowed CIDRs,
a fake Store layer, and the real `post`:

- receiver returns 500 then 200: row goes `pending` (`attempt` 1,
  `next_at` + 1m) then `delivered` after `TestClock.adjust("1 minute")` and
  the next tick;
- receiver returns 302: counted as failure;
- six failures: `dead`, `last_error` set; the five waits are crossed with
  `TestClock.adjust`, never slept;
- 40 pending rows: all delivered, at most 8 in flight (count concurrent
  open requests in the receiver);
- a receiver that never answers: `TestClock.adjust("10 seconds")` fails the
  attempt with `last_error` `timeout`;
- the same `X-Krun-Delivery` on both requests of the 500-then-200 case;
- the signature header on each request verifies with the test secret at the
  `TestClock` time.

Gate: `pnpm exec vitest run apps/scheduler/src` (and
`packages/shared/src/webhook` for the helpers). Drive ticks by running
`drain` directly rather than through the repeat.
