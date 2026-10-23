# Deliveries loop (P5.3)

Source: SPEC.md:921-928, SPEC.md:1119, SPEC.md:1146, SPEC.md:452-464 (DDL),
SPEC.md:515-516 (Store), PLAN.md:618-625, docs/API.md:374-376. Store
semantics and SQL belong to `krun-store`; leader placement to
`krun-scheduler-k8s`.

## Constants

| Constant | Value | Citation |
|---|---|---|
| tick period | 5 s | SPEC.md:921 |
| claim batch | `claimDeliveries(now, 40)` | SPEC.md:921 |
| claim lease | 60 s, set as `next_at = now + 60s` inside the claim statement, ordered by `next_at`, skip locked | SPEC.md:515, :921-922 |
| concurrency | 8 in flight | SPEC.md:922 |
| per-attempt timeout | 10 s (`AbortSignal.timeout`) | SPEC.md:922, :1119 |
| redirects | not followed; any 3xx fails | SPEC.md:923, :1072-1073 |
| success | 2xx only, `delivered` | SPEC.md:923 |
| worst-case tick | 40 / 8 × 10 s = 50 s, under the 60 s lease | SPEC.md:924 |
| re-claim | when the batch returned 40 rows, claim again at once in the same tick | SPEC.md:924-925 |
| attempts | 6 in all; `dead` after the sixth failure | SPEC.md:926-927, :1119 |
| total span | about 15 h | SPEC.md:1119, docs/API.md:375-376 |
| metric | `krun_deliveries_total{state}` on the leader | SPEC.md:1146 |
| alert | `KrunDeliveriesDead`: `increase(krun_deliveries_total{state="dead"}[1h]) > 0`, warning | SPEC.md:1399 |

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

`SCHEDULE = [60, 300, 1800, 7200, 43200]` seconds; index by the attempt
number before increment; when `attempt` (after increment) reaches 6 the
state is `dead` (SPEC.md:926-927). The first attempt happens at the next
tick after insert because `next_at = created_at` on insert.

## Tick

```
every 5 s, leader only, until loopSignal aborts:
  do:
    batch = await store.claimDeliveries(now(), 40)      // lease 60 s
    await runWithConcurrency(batch, 8, attemptOne)      // await the whole batch
  while batch.length === 40 && !loopSignal.aborted
```

`attemptOne(d)`:

1. `resolveAndCheck(d.url)` (references/ssrf-check.md); a rejection is a
   failure with `last_error` naming the reason (SPEC.md:1069).
2. `headers = { 'content-type', 'x-krun-delivery': d.id, 'x-krun-run-id': d.runId, 'x-krun-signature': sign(bodyBytes, secrets) }`
   (references/signature.md); `bodyBytes` is `d.payload` serialised once.
3. `fetch` through the pinned dispatcher, `redirect: 'manual'`,
   `signal: AbortSignal.any([AbortSignal.timeout(10_000), loopSignal])`.
4. `2xx` → `updateDelivery(d.id, 'delivered', d.attempt, null, null)`;
   increment `krun_deliveries_total{state="delivered"}`.
5. otherwise `n = d.attempt + 1`; `n >= 6` → `updateDelivery(d.id, 'dead', n, null, err)`,
   increment `{state="dead"}`; else `updateDelivery(d.id, 'pending', n, now + SCHEDULE[d.attempt], err)`,
   increment `{state="pending"}`. Label values are the three DDL states
   written by the attempt (`delivered`, `pending`, `dead`, SPEC.md:459);
   invent no fourth value without the P4.6 metrics task agreeing.
6. `last_error` is a short string: `status 500`, `status 302`, `timeout`,
   `address rejected: private`, `ECONNREFUSED`; never the response body.

Aborted by `loopSignal` (SIGTERM or leadership lost): do not call
`updateDelivery`; the row stays `pending` under its lease and the next
leader re-claims it after 60 s. Never mark `dead` because of shutdown
(dapr pkg/runtime/subscription/subscription.go:394-405 makes the same
choice).

## Lease arithmetic

- Claim sets `next_at = now + 60s` so a concurrent or restarted leader
  cannot re-claim within the lease (P1.7 acceptance, PLAN.md:267-268).
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
- debug: the underlying error object.
- info: `delivery delivered` with `delivery_id`, `run_id`, `attempt`.
  (Pattern from dapr pkg/resiliency/policy.go:345-354.)

## Acceptance (PLAN.md:622-625)

Unit test with `http.createServer` on `127.0.0.1` and `10.0.0.0/8` or
`127.0.0.0/8` in the allowed CIDRs:

- receiver returns 500 then 200: row goes `pending` (`attempt` 1,
  `next_at` + 1m) then `delivered` on the next forced tick;
- receiver returns 302: counted as failure;
- six failures: `dead`, `last_error` set;
- 40 pending rows: all delivered, at most 8 in flight (count concurrent
  open requests in the receiver);
- the signature header on each request verifies with the test secret.

Use a fake clock or inject `now` so the schedule is asserted without
waiting; drive ticks directly rather than through `setInterval`.
