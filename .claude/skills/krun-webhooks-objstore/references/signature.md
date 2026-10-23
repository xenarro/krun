# Webhook signature (P2.1 signing, P5.3 per-attempt use)

Source: SPEC.md:1075-1083, D29 (SPEC.md:1470), docs/API.md:368-402,
docs/OPERATIONS.md:114-117.

## Headers on every attempt

| Header | Value | Constant across attempts | Citation |
|---|---|---|---|
| `Content-Type` | `application/json` | yes | docs/API.md:371-372 |
| `X-Krun-Delivery` | `deliveries.id` (UUID) | yes; receivers dedupe on it | SPEC.md:1079-1080 |
| `X-Krun-Run-Id` | bare run UUIDv7 (`name` in the body carries the full resource name) | yes | SPEC.md:1080-1081 |
| `X-Krun-Signature` | `t=<unix seconds at send>,v1=<hex>,v1=<hex>...` | no; `t` is the send time of this attempt | SPEC.md:1075-1078 |

Body: the stored `deliveries.payload` bytes, the BASIC `Run` (`RunSummary`
from `toRunSummary`, SPEC.md:1082-1083, SPEC.md:529-533). It omits
`input`, `result`, `logTail` and `error.details`; receivers fetch the
result with `GetRunResult` (docs/API.md:384).

## Signing (sender, scheduler)

```ts
import { createHmac } from 'node:crypto'

function sign(body: Uint8Array, secrets: string[], now = Date.now()): string {
  const t = Math.floor(now / 1000)
  const sigs = secrets.map(s =>
    'v1=' + createHmac('sha256', s).update(`${t}.`).update(body).digest('hex'))
  return `t=${t},${sigs.join(',')}`
}
```

- `secrets` is `KRUN_WEBHOOK_SECRET` split on `,`, in order, empty entries
  dropped; one `v1=` per entry (SPEC.md:1077-1078).
- The signed string is `<t>.<body>` where `<body>` is the exact bytes sent;
  compute it on the `Buffer`/`Uint8Array` that goes into `fetch`, never on
  a re-stringified object.
- Call `sign` inside the attempt, after the address re-check and before
  `fetch`; a retry 12 hours later carries a fresh `t` (SPEC.md:927-928).
- A bare `KRUN_WEBHOOK_SECRET` with hosts set and no secret is a startup
  error (SPEC.md:1180-1181); the signer therefore always has at least one
  secret.

## Verification (receiver guidance, docs/API.md:379-382)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(header: string, rawBody: Buffer, secret: string, now = Date.now()): boolean {
  const parts = header.split(',')
  const t = parts.find(p => p.startsWith('t='))?.slice(2)
  if (!t || !/^\d+$/.test(t)) return false
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > 300) return false   // SPEC.md:1081
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest()
  return parts
    .filter(p => p.startsWith('v1='))
    .some(p => {
      const got = Buffer.from(p.slice(3), 'hex')
      return got.length === expected.length && timingSafeEqual(got, expected)
    })
}
```

- Verify against the raw request bytes, before JSON parsing; a framework
  that re-serialises the body breaks the check.
- Accept when any `v1=` matches (SPEC.md:1078); compare in constant time,
  and guard the length first because `timingSafeEqual` throws on unequal
  lengths.
- Reject `|now - t| > 300` seconds (SPEC.md:1081, D29): replay window.
- Dedupe on `X-Krun-Delivery`: at-least-once means the same delivery can
  arrive twice when a 2xx was sent but the scheduler crashed before
  `updateDelivery` (docs/API.md:374-376).
- Answer 2xx fast; anything else, including 3xx, is retried on the schedule
  (SPEC.md:923, :926). Do the work after acknowledging if it is slow; the
  attempt times out at 10 s.

The e2e receiver (P5.4, PLAN.md:626-629) implements this with a 10-line
`http.createServer` and asserts a constant `X-Krun-Delivery` across a
retried attempt and two `v1=` entries during rotation.

## Rotation (docs/OPERATIONS.md:114-117, D29)

1. Set the `secret` key of `webhooks.existingSecret` to `new,old`.
2. `kubectl rollout restart deployment/krun-scheduler` (postgres) or
   `statefulset/krun` (embedded); the value reaches the pod as env, there is
   no hot reload for this Secret.
3. Every attempt now carries two `v1=`; receivers still verifying `old`
   keep passing. Roll receivers to `new`.
4. Drop `old` from the Secret, restart again.

Order of `v1=` entries follows the env order; receivers must not depend on
position. No `v2=` scheme exists; a new scheme would be a Decisions row.

## Tests (PLAN.md:308-309)

- `sign` with two secrets yields two `v1=` and `verify` passes with each.
- `verify` fails on a tampered byte, on a wrong secret, on `t` 301 s old,
  and on a header with no `v1=`.
- Signing the same body twice 1 s apart yields different headers.
- Never commit a real secret; tests generate theirs with `randomBytes`
  (PLAN.md:33).
