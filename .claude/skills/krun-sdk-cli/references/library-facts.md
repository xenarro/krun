# Library facts (SDKs and CLI)

Versions from docs/STACK.md. UNVERIFIED means not executed: confirm in a
REPL before relying on it.

- TypeScript 7 `tsc` type-checks and emits `dist/` per package
  (PLAN.md:42-44). Erasable syntax only: no enums, parameter properties or
  decorators; `.ts` extensions in relative imports; `import type` for types.
- Node never strips TS under `node_modules`: `@krun/sdk` and `@krun/cli`
  publish built `.js` from `dist/`; the templates and `npx @krun/cli`
  consume `dist/`.
- `@krun/sdk` targets Node 22 or newer (SPEC.md:664, section 14): global
  `fetch` and `AbortSignal.timeout` exist there. Use no API in `src/` that
  Node 22 lacks. CI runs the SDK's Vitest 5 suite on Node 22 and Node 26
  (Vitest 5 supports Node 22.12 or newer), so a Node 22 gap fails CI. No
  `undici`: global fetch is enough, and mixing the package with the bundled
  fetch is a known trap. `"engines": { "node": ">=22" }`.
- `@clack/prompts` 1.x: `intro`, `outro`, `select`, `text`, `spinner()`
  (`start`, `stop`), `isCancel`, `cancel`. A prompt returns a value or the
  cancel symbol; test `isCancel` on every answer. UNVERIFIED: whether 1.x
  prompts and spinners accept an output stream (to write to stderr); check
  its README. If not, use them only when stdout is a TTY, and stop the
  spinner before writing the stdout commands.
- `picocolors`: `createColors(enabled)` returns a colour set. Compute
  `enabled` yourself from the stderr TTY and `NO_COLOR` / `FORCE_COLOR`; the
  default export decides from stdout. UNVERIFIED in detail against 1.1;
  check its README.
- `tinyexec` 1.x: `x(command, args, options)` returns a promise-like process
  with `stdout`, `stderr`, `exitCode` and async iteration over output lines.
  Options include `throwOnError`, `timeout`, `signal`, `nodeOptions` (`cwd`,
  `env`); names UNVERIFIED against the installed README. Pass
  `throwOnError: false` and classify the exit code in the service: every
  failure becomes a tagged error with the stderr tail, never a thrown
  `NonZeroExitError`.
- `publint` and `attw --pack` (`@arethetypeswrong/cli`): for an ESM-only
  package attw reports the CommonJS resolution modes. krun ships ESM only
  (PLAN section 2), so use attw's ESM-only profile, not a CJS build; check
  the attw README for the flag name.
- Gate and heartbeat unit tests: `vi.useFakeTimers()` and
  `vi.advanceTimersByTimeAsync`. The gate takes an injected monotonic
  `now: () => number` (default `performance.now`, never the wall clock), so
  one fake drives timers and `now`. Subprocess conformance runs use real
  time with a small `KRUN_HEARTBEAT_TIMEOUT`.
- "Exits without waiting for the heartbeat timer" (PLAN.md:804-805) needs a
  real child process with a deadline on its exit. An in-process test cannot
  see a non-unref'd timer, and Vitest's own teardown would hide it.
- CLI tests use `@effect/vitest`: `it.effect` with fake `Docker`, `Kubectl`,
  `Fs`, `Prompt` and `Terminal` layers (TTY forced on or off, scripted
  prompt answers including a cancel), and `TestClock` for the 1 s / 120 s
  Ready poll (`Schedule.spaced("1 second")` under
  `Effect.timeout("120 seconds")`). No test drives real clack or a real
  `docker`.
- Python (UNVERIFIED, stdlib-stable):
  `urllib.request.Request(url, data=bytes, method='PUT', headers=...)`,
  `urlopen(req, timeout=10)`. `HTTPError` subclasses `URLError`: catch it
  first and read `.code`. Heartbeat:
  `threading.Thread(target=loop, daemon=True)` with `Event.wait(interval)`
  for a clean stop; `time.monotonic()` for the gate. `uv build` makes sdist
  plus wheel. Run `uv run --directory sdk/python pytest` from the repo root.
  Ruff `select = ["E","F","I","UP","B"]`.
- Layout is `sdk/python/krun/` (PLAN.md:114), not the `src/` layout
  `uv init --lib` generates. `requires-python = ">=3.11"` (SPEC.md:661,
  PLAN.md:55).
