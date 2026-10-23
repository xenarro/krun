# Library facts (webhooks and object storage)

Versions from docs/STACK.md section 2 (verified against npm 2026-10-23).
The API shapes below are UNVERIFIED by execution: confirm in a REPL before
relying on them.

- undici `^8.12`: `new Agent({ connect: { lookup, servername, timeout, rejectUnauthorized } })`.
  `connect.lookup` has the `dns.lookup` callback signature.
  `fetch(url, { dispatcher, redirect: 'manual' })` returns the real 3xx
  response with its `Location` (not a browser opaque-redirect). Import
  `fetch` and `Agent` from the `undici` package: Node's global fetch is a
  bundled undici and ignores the package's dispatcher.
  `@effect/platform-node`'s `Undici` module is unstable and not used
  (docs/STACK.md section 2.1).
- ipaddr.js `^2.5`: `ipaddr.process(str)` parses v4 or v6 and converts
  IPv4-mapped to IPv4. `addr.range()` returns `unicast`, `private`,
  `loopback`, `linkLocal`, `multicast`, `broadcast`, `carrierGradeNat`,
  `reserved`, `unspecified`, `uniqueLocal`, `ipv4Mapped`, `6to4`, `teredo`,
  ... For the CIDR list:
  `ipaddr.subnetMatch(addr, { allowed: [[ipaddr.parse(net), bits], ...] }, 'default')`.
  A v4 address against v6 ranges (or the reverse) is a mismatch, so build
  the range list per family or convert first (test it).
- @aws-sdk/s3-request-presigner `^3.1156`:
  `getSignedUrl(client, new PutObjectCommand({ Bucket, Key }), { expiresIn })`,
  seconds, SigV4 max 7 days. Any header given to the command (for example
  `ContentType`) becomes a signed header the uploader must send exactly;
  that is why SPEC signs only the host. Exists: `HeadObjectCommand` rejects
  with `err.name === 'NotFound'` and `$metadata.httpStatusCode === 404`.
  MinIO needs `forcePathStyle: true` and `endpoint`. Every SDK call runs
  through `Effect.tryPromise` inside the `ObjectStore` service; the `signal`
  it provides goes to `abortSignal` in the command options.
- testcontainers `^12.2` with `@testcontainers/minio` (`MinioContainer`,
  image pinned by tag). `TESTCONTAINERS_RYUK_DISABLED=true` in CI without
  privileged Ryuk.
- Effect `~4.0.6`: `Clock.currentTimeMillis`, `DateTime.now`,
  `Effect.timeout`, `Effect.forEach(..., { concurrency })`, `Effect.repeat`
  with `Schedule.spaced`, `Effect.acquireRelease`,
  `Effect.tryPromise({ try: (signal) => ..., catch })` (interruption,
  including a timeout, aborts `signal`). Services are `Context.Service`s per
  `MIGRATION.md`.
- `node:crypto`:
  `createHmac('sha256', secret).update(t + '.').update(bodyBytes).digest('hex')`
  and `timingSafeEqual` on equal-length buffers (docs/STACK.md section 2.5).
- picomatch `^4.0`: `picomatch(globs, { nocase: false, dot: true })` returns
  one matcher for a list (true when any glob matches). `*` matches any run
  of characters except `/`, which never occurs in a hostname, so
  `*.acme.com` matches `a.b.acme.com`.
- Current span for `traceparent`: Effect exposes the active span (in Effect
  3 `Effect.currentSpan` with `traceId`, `spanId`, `sampled`). Check
  Effect's MIGRATION.md and the @effect/opentelemetry docs for the Effect 4
  name and for a ready-made W3C propagator before formatting the header by
  hand as `00-<traceId>-<spanId>-<01|00>`.
