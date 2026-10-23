# Webhook host allowlist and SSRF address check (P2.1)

Source: SPEC.md:1062-1073, D31 (SPEC.md:1472), PLAN.md:300-309,
docs/OPERATIONS.md:120-121. Module: `packages/shared/src/webhook`.

## Inputs (parsed by `packages/shared/src/config`, P0.5)

| Value | Env | Shape | Citation |
|---|---|---|---|
| allowed hosts | `KRUN_WEBHOOK_ALLOWED_HOSTS` | comma-separated globs over the URL host; empty disables webhooks | SPEC.md:1214 |
| allowed CIDRs | `KRUN_WEBHOOK_ALLOWED_CIDRS` | comma-separated CIDRs; a CIDR that does not parse exits 1 at startup | SPEC.md:1183, :1215 |
| secrets | `KRUN_WEBHOOK_SECRET` | comma-separated; required on the scheduler when hosts are set | SPEC.md:1181, :1216 |

Glob grammar: the in-house glob-to-regex (PLAN.md:71) used for API key
function globs; `*` matches any run of characters including dots
(`*.acme.com` matches `hooks.acme.com` and `a.b.acme.com`), anchored both
ends, case-insensitive on the host. Match against `url.hostname` with IPv6
brackets removed. No port, no path, no scheme in the glob.

## Algorithm

```
checkCallback(url: string, cfg): Promise<{ address: string, family: 4 | 6 }>
  1. u = new URL(url)                    -- throws: reject (malformed)
  2. u.protocol in {http:, https:}       -- else reject
  3. host = u.hostname, strip [ ]        -- IPv6 literal
  4. hostMatches(host, cfg.allowedHosts) -- else reject (SPEC.md:1062)
  5. if ipaddr.isValid(host): addrs = [host]
     else: addrs = (await dns.promises.lookup(host, { all: true })).map(r => r.address)
           empty or ENOTFOUND: reject
  6. for each a in addrs:
       addr = ipaddr.process(a)          -- unwraps ::ffff:x.x.x.x (SPEC.md:1063)
       ok = subnetMatch(addr, { allowed: cidrsOfFamily(addr) }, 'default') === 'allowed'
            || addr.range() === 'unicast'  (SPEC.md:1064-1068)
       if !ok: reject
  7. return { address: addrs[0], family }  -- the pinned address
```

The pure part is `checkAddress(addrs: string[], cidrs: Cidr[]): boolean`;
test it without DNS. `resolveAndCheck` composes DNS with it. The gateway
calls `resolveAndCheck` at create and maps a rejection to 400
`CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field` = `callback.url`
(docs/API.md:327, PLAN.md:383). The scheduler calls it again before every
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

## Required test vectors (PLAN.md:305-309 plus SPEC.md:1066-1068)

Every row is a unit test on `checkAddress`; the "reason" column is the
expected ipaddr.js `range()` so a naming mismatch fails loudly.

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

Host-level vectors (on `resolveAndCheck` with a stubbed lookup):

| URL | Hosts | Expect |
|---|---|---|
| `https://hooks.acme.com/krun` resolving to `93.184.216.34` | `*.acme.com` | accept, pinned `93.184.216.34` |
| `https://hooks.acme.com/krun` resolving to `93.184.216.34, 10.0.0.5` | `*.acme.com` | reject (one private record) |
| `https://evil.example/` | `*.acme.com` | reject before DNS |
| `ftp://hooks.acme.com/` | `*.acme.com` | reject (scheme) |
| `http://[::1]:8080/` | `*` | reject (`loopback`, after bracket strip) |
| `http://receiver.krun-e2e.svc:8080/` resolving to `10.96.0.12` | `*.svc` with CIDR `10.96.0.0/12` | accept (the e2e receiver, D31) |

## Pinned dispatcher

```ts
import { Agent, fetch } from 'undici'   // the package, not globalThis.fetch

const dispatcher = new Agent({
  connect: {
    lookup: (_hostname, _opts, cb) => cb(null, pinned.address, pinned.family),
    servername: isIpLiteral ? undefined : hostname,   // SNI and cert check on the name
    timeout: 10_000,
  },
})
const res = await fetch(url, {
  method: 'POST', body, headers, dispatcher,
  redirect: 'manual',
  signal: AbortSignal.any([AbortSignal.timeout(10_000), loopSignal]),
})
```

One `Agent` per attempt (the pinned address differs per delivery); close
it after the response is consumed. Node's global `fetch` carries its own
bundled undici and ignores this dispatcher (node-stack-facts.md:748-751),
so the import above is load-bearing.

Any `res.status` outside 200-299 fails the attempt, 3xx included
(SPEC.md:1072-1073). Drain or cancel the body on failure so the socket is
released before the next attempt.
