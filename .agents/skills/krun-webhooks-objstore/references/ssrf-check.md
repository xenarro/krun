# Webhook host allowlist and SSRF address check (P2.1)

Source: SPEC.md:1076-1087, D31, PLAN.md:319-328,
docs/OPERATIONS.md (Security operations), docs/STACK.md sections 2.2, 2.5 and 4.3. Module:
`packages/shared/src/webhook`.

## Inputs (parsed by the Zod Config schema in `packages/shared/src/config`, P0.5)

| Value | Env | Shape | Citation |
|---|---|---|---|
| allowed hosts | `KRUN_WEBHOOK_ALLOWED_HOSTS` | comma-separated globs over the URL host; empty disables webhooks | SPEC.md:1214 |
| allowed CIDRs | `KRUN_WEBHOOK_ALLOWED_CIDRS` | comma-separated CIDRs; a CIDR that does not parse exits 1 at startup | SPEC.md:1183, :1215 |
| secrets | `KRUN_WEBHOOK_SECRET` | comma-separated; required on the scheduler when hosts are set | SPEC.md:1181, :1216 |

Glob grammar: `picomatch`, the same library as the API key function
globs (docs/STACK.md 2.5): `picomatch(hostGlobs, { nocase: false, dot:
true })`, compiled once when the Config is parsed. `*` matches any run of
characters except `/`, so dots included (`*.acme.com` matches
`hooks.acme.com` and `a.b.acme.com`, not `acme.com`), anchored both ends.
Host globs are lowercased at parse because `URL.hostname` is lowercase
for DNS names and matching is case-sensitive. Match against
`url.hostname` with IPv6 brackets removed. No port, no path, no scheme in
the glob. Never translate globs to a RegExp by hand (docs/STACK.md 2.5).

## Algorithm

```
resolveAndCheck(url: string, cfg): Effect<Pinned, CallbackNotAllowed>
                                   -- Pinned = { address: string, family: 4 | 6, servername?: string }
  1. u = new URL(url)                    -- throws: fail CallbackNotAllowed("malformed")
  2. u.protocol in {http:, https:}       -- else fail ("scheme")
  3. host = u.hostname, strip [ ]        -- IPv6 literal
  4. hostMatches(host, cfg.allowedHosts) -- else fail ("host") (SPEC.md:1062)
  5. if ipaddr.isValid(host): addrs = [host]
     else: addrs = yield* Effect.tryPromise(() => dns.promises.lookup(host, { all: true }))
           empty or ENOTFOUND: fail ("unresolvable")
  6. for each a in addrs:
       addr = ipaddr.process(a)          -- unwraps ::ffff:x.x.x.x (SPEC.md:1063)
       ok = subnetMatch(addr, { allowed: cidrsOfFamily(addr) }, 'default') === 'allowed'
            || addr.range() === 'unicast'  (SPEC.md:1064-1068)
       if !ok: fail (addr.range())
  7. return { address: addrs[0], family }  -- the pinned address
```

The pure part is `checkAddress(addrs: string[], cidrs: Cidr[]): boolean`;
test it without DNS. `resolveAndCheck` composes DNS with it as an Effect
whose failure is the tagged `CallbackNotAllowed` carrying the reason; the
DNS lookup sits behind a small `Resolver` service so tests provide a stub
layer. The gateway runs `resolveAndCheck` at create and maps the tag to 400
`CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field` = `callback.url`
(docs/API.md:327, PLAN.md:402). The scheduler runs it again before every
attempt (SPEC.md:1069) and treats a rejection as a failed attempt with
`last_error` naming the reason, never as `dead` at once (the DNS may be
fixed before the next attempt).

Why `unicast` only: ipaddr.js names every special block (`loopback`,
`private`, `linkLocal`, `carrierGradeNat`, `uniqueLocal`, `multicast`,
`unspecified`, `reserved`, `broadcast`, `ipv4Mapped`, `6to4`, `teredo`); a
denylist would miss the next one. The allowlist of CIDRs is the only
escape hatch, which D31 chose so in-cluster receivers work when the
operator lists the pod or Service CIDR (docs/OPERATIONS.md:120-121).

Split the CIDR list by family before `subnetMatch`: match a v4 address
only against v4 CIDRs and a v6 address only against v6 CIDRs, after
`process()` has turned `::ffff:10.0.0.1` into v4. An allowlisted
`10.0.0.0/8` must admit `::ffff:10.0.0.1` through the unwrapped v4 form.

## Required test vectors (PLAN.md:324-328 plus SPEC.md:1066-1068)

Every row is a Vitest case on `checkAddress` (`it.each` over the table);
the "reason" column is the expected ipaddr.js `range()` so a naming
mismatch fails loudly. Gate: `pnpm exec vitest run packages/shared/src/webhook`.

| Address | CIDRs | Expect | Reason |
|---|---|---|---|
| `127.0.0.1` | none | reject | `loopback` |
| `10.0.0.1` | none | reject | `private` |
| `169.254.169.254` | none | reject | `linkLocal` (cloud metadata) |
| `100.64.0.1` | none | reject | `carrierGradeNat` |
| `::1` | none | reject | `loopback` |
| `::ffff:127.0.0.1` | none | reject | unwrapped to `127.0.0.1`, `loopback` |
| `0.0.0.1` | none | reject | `unspecified` / `0.0.0.0/8` (SPEC.md:1067) |
| `172.16.0.1` | none | reject | `private` |
| `192.168.1.1` | none | reject | `private` |
| `fc00::1` | none | reject | `uniqueLocal` (`fc00::/7`) |
| `fe80::1` | none | reject | `linkLocal` (`fe80::/10`) |
| `224.0.0.1` | none | reject | `multicast` |
| `ff02::1` | none | reject | `multicast` |
| `255.255.255.255` | none | reject | `broadcast` |
| `93.184.216.34` | none | accept | `unicast` (the "allowed public host" case) |
| `2606:2800:220:1:248:1893:25c8:1946` | none | accept | `unicast` |
| `10.0.0.1` | `10.0.0.0/8` | accept | listed CIDR beats range |
| `::ffff:10.0.0.1` | `10.0.0.0/8` | accept | unwrapped then listed |
| `10.1.0.1` | `10.0.0.0/16` | reject | outside the listed CIDR, still `private` |
| `169.254.169.254` | `169.254.0.0/16` | accept | listed; the operator chose to allow it |

Host-level vectors (on `resolveAndCheck` with a stub `Resolver` layer, run
with `it.effect` from `@effect/vitest`):

| URL | Hosts | Expect |
|---|---|---|
| `https://hooks.acme.com/krun` resolving to `93.184.216.34` | `*.acme.com` | accept, pinned `93.184.216.34` |
| `https://hooks.acme.com/krun` resolving to `93.184.216.34, 10.0.0.5` | `*.acme.com` | reject (one private record) |
| `https://evil.example/` | `*.acme.com` | reject before DNS |
| `https://acme.com/` | `*.acme.com` | reject before DNS (`*.` needs a label) |
| `https://HOOKS.ACME.COM/` resolving to `93.184.216.34` | `*.Acme.com` | accept (hostname and glob both lowercased) |
| `ftp://hooks.acme.com/` | `*.acme.com` | reject (scheme) |
| `http://[::1]:8080/` | `*` | reject (`loopback`, after bracket strip) |
| `http://receiver.krun-e2e.svc:8080/` resolving to `10.96.0.12` | `*.svc` with CIDR `10.96.0.0/12` | accept (the e2e receiver, D31) |

Property tests (fast-check, docs/STACK.md section 3), next to the table:

- any IPv4 `a` in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `127.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`: rejected with no CIDR
  listed, accepted when its enclosing block is listed;
- for every IPv4 `a`: `checkAddress(['::ffff:' + a], c) === checkAddress([a], c)`;
- a list containing any rejected address is rejected, whatever else it holds.

## Pinned dispatcher

```ts
import { Agent, fetch } from 'undici'   // the package, not globalThis.fetch
import { Effect } from 'effect'

const post = (url: string, pinned: Pinned, body: Uint8Array, headers: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => new Agent({
      connect: {
        lookup: (_hostname, _opts, cb) => cb(null, pinned.address, pinned.family),
        servername: pinned.servername,   // the URL host for DNS names, undefined for IP literals
        timeout: 10_000,
      },
    })),
    (agent) => Effect.promise(() => agent.close()),
  ).pipe(
    Effect.flatMap((dispatcher) => Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(url, { method: 'POST', body, headers, dispatcher, redirect: 'manual', signal })
        await res.body?.cancel()          // release the socket; the body is never read or logged
        return res.status
      },
      catch: (cause) => new DeliveryTransportError({ cause }),
    })),
    Effect.timeout('10 seconds'),         // interrupts the fiber, which aborts `signal`
    Effect.scoped,
  )
```

One `Agent` per attempt (the pinned address differs per delivery), closed
by the scope's release after the response. Node's global `fetch` carries
its own bundled undici and ignores this dispatcher, so the import above is
load-bearing. The `connect.timeout` bounds the TCP and TLS handshake; the
`Effect.timeout` bounds the whole attempt (SPEC.md:922).

Any status outside 200-299 fails the attempt, 3xx included
(SPEC.md:1072-1073). The body is cancelled unread in every case so the
socket is released before the scope closes.
