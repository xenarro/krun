# Property tests and Effect-free suites

Loaded from SKILL.md for P0.5, P0.8, P1.3, P2.1, P3.3, P3.4 (properties)
and P8.1-P8.5 (SDK and template suites).

## Property tests (fast-check 4)

STACK.md:109 names the targets: request fingerprint, filter parser,
duration grammar, address checks.

| Target | Property |
|---|---|
| `request_hash` (P1.3, P3.3) | any key permutation of `{ input, priority, callback }` hashes equal (`canonicalize`); any value change hashes differently |
| filter parser (P3.4) | `parse(print(ast))` equals `ast` for generated ASTs of the docs/API.md subset; random strings yield an AST or `FILTER_INVALID`, never a defect |
| duration grammar (P0.5, P0.8) | `^\d+(ms|s|m|h)$` strings decode to the expected `Duration`; anything else fails the Zod refinement |
| address check (P2.1) | `fc.ipV4()`/`fc.ipV6()` inside a listed CIDR pass; addresses whose ipaddr.js range is not `unicast` and not listed fail, including IPv4-mapped forms |

Write `fc.assert(fc.property(arb, (x) => ...))` in a plain `it` for pure
code. For an Effect: `fc.assert(fc.asyncProperty(arb, (x) =>
Effect.runPromise(prog(x).pipe(Effect.provide(TestLayer)))))`, providing
`TestClock.layer()` explicitly if time matters. fast-check prints the seed
on failure; paste it into a regression `it` when it finds a bug.

## SDK and template suites (Effect-free)

- `packages/sdk-node`: Vitest as a dev dependency, plain `it`, no
  `@effect/vitest`, no Effect in sources (STACK.md:30-31). This is the one
  place Vitest fake timers are right: `vi.useFakeTimers()` plus
  `vi.advanceTimersByTimeAsync` for the 1-per-second status gate and the
  heartbeat (P8.1, PLAN.md:784-805), or an injected clock. Whether fake
  timers also govern `AbortSignal.timeout` inside `fetch` is UNVERIFIED: if
  not, drive the 3 s / 10 s timeouts with a never-answering receiver and a
  short injected timeout and assert the request count.
- `sdk/python` (P8.2): stdlib at runtime; `pytest`, `hypothesis`, `ruff`,
  `mypy --strict` in development (STACK.md section 3). `hypothesis` is the
  fast-check counterpart: property-test pure helpers with `@given` (for
  example the 1-per-second status gate over generated timestamp
  sequences, mirroring the Node SDK); keep network fakes out of property
  tests. Fake the
  internal API with `http.server.ThreadingHTTPServer` on port 0 in a
  fixture; inject the clock and sleeper into the status gate and heartbeat
  thread so tests advance time instead of sleeping; assert the heartbeat
  thread is a daemon. Run once on Python 3.11 in CI (`uv run --python 3.11`).
- `packages/sdk-node` supports Node 22 or newer (SPEC.md section 14) while
  krun itself runs on Node 26. CI runs the SDK's Vitest 5 suite (Vitest 5
  supports Node 22.12 or newer) on Node 22 and on Node 26, so an API that
  Node 22 lacks fails CI. `attw --pack` and `publint` (P9.5) check the
  package shape; keep the SDK's `tsconfig` target and APIs within Node 22.
- `test/sdk-conformance` (P8.3, PLAN.md:811-818): one JSON scenario table
  both suites read; reordering one SDK's calls must fail its suite.
- `krun init` templates (`packages/cli/templates/`) are the function
  author's project, not krun: they stay dependency-free and the Node
  template's own `npm test` runs `node --test`; the P8.4 acceptance runs it
  (PLAN.md:819-825). The CLI's tests of `init` itself are Vitest.
