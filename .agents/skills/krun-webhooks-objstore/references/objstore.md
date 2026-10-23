# Object storage (P6.1, P6.2, P3.6)

Source: SPEC.md:36, :612, :636-656, :863-875, :1013-1026, :1212-1213,
docs/API.md:110, :269-281, docs/OPERATIONS.md:58-60, PLAN.md:631-650.
Module: `packages/shared/src/objstore`.

## Configuration

| Env | Meaning | Citation |
|---|---|---|
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | all empty: object storage disabled; no `KRUN_RESULT_UPLOAD_URL` in the Job env, results above `KRUN_MAX_RESULT_BYTES` have nowhere to go | SPEC.md:1212, :612, :1114 |
| `KRUN_S3_PRESIGN_TTL` | duration; unset: the run's `activeDeadlineSeconds`; scheduler PUT presign only | SPEC.md:1213 |
| chart | `objectStorage: { enabled, endpoint, bucket, region, existingSecret, egress }`; `fail` when enabled with empty `endpoint`, `bucket` or `existingSecret` | SPEC.md:1302, :1311-1312 |

Build one `S3Client({ endpoint, region, credentials, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED' })`.
`forcePathStyle` is required for MinIO and harmless for AWS when the bucket
name is DNS-safe (node-stack-facts.md:768-769). Both processes construct it;
the gateway only presigns GET and the scheduler only presigns PUT and calls
`exists`.

## Keys and URLs

| Item | Value | Citation |
|---|---|---|
| object key | `runs/<id>/result.json` | SPEC.md:643 |
| `result_ref` column / `resultUri` field | `s3://<bucket>/runs/<id>/result.json` | SPEC.md:645-646, docs/API.md:110 |
| PUT presign | `getSignedUrl(client, new PutObjectCommand({ Bucket, Key }), { expiresIn })`; no `ContentType`, no `ContentLength` | SPEC.md:649-651 |
| PUT TTL | `KRUN_S3_PRESIGN_TTL` in seconds, else the Function's `activeDeadlineSeconds` | SPEC.md:651-652, PLAN.md:643 |
| GET presign | `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 })` | SPEC.md:652-653 |
| exists | `HeadObjectCommand`; `err.name === 'NotFound'` → false; any other error → throw | SPEC.md:872-873, node-stack-facts.md:766-768 |

Interface shape (keep it this small, PLAN.md:31-32):

```ts
interface ObjectStore {
  presignPut(runId: string, ttlSeconds: number): Promise<string>
  presignGet(ref: string): Promise<string>        // ref = s3://bucket/key, 300 s
  exists(runId: string): Promise<boolean>         // NotFound → false, else throws
  ref(runId: string): string                      // s3://<bucket>/runs/<id>/result.json
}
```

Only the host is signed on the PUT so a function may send any
`Content-Type` and any length; the P6.1 acceptance uploads with
`Content-Type: application/json` against the URL and must succeed
(PLAN.md:640-641). Adding `ContentType` to the command would make the
header part of the signature and break plain `curl -T` uploads.

## `result_ref` flow

1. Scheduler, Job creation (P6.2, `krun-scheduler-k8s` owns the manifest):
   when configured, `KRUN_RESULT_UPLOAD_URL = presignPut(id, ttl)` goes
   into the function container env (SPEC.md:612). The env list is never
   logged (SPEC.md:1153-1154).
2. Function: result up to `KRUN_MAX_RESULT_BYTES` → `PUT .../result` on the
   internal API; larger → HTTP PUT the body to `KRUN_RESULT_UPLOAD_URL`
   (SPEC.md:636-638). The URL expires with the TTL.
3. Terminal transition on `Complete` (SPEC.md:863-869), in this order:
   - object storage configured AND Job completed AND run row has no inline
     `result` → `exists(id)`;
   - `true` → add `result_ref: ref(id)` to the CAS patch; `false` → no
     `result_ref` (a succeeded run with neither is `RESULT_MISSING` on
     read);
   - `exists` threw → return without writing; the next informer event or
     the 5-minute reconcile retries (SPEC.md:872-873);
   - `transition(id, from, 'succeeded', null, patch)` inserts the delivery
     in the same transaction, so the payload carries `resultUri`
     (SPEC.md:646, PLAN.md:646).
4. A run with an inline `result` skips the check (SPEC.md:647-648,
   PLAN.md:646-647); a run never carries both, and only `succeeded` runs
   carry `result_ref` (SPEC.md:648-649). `cancelled` and `failed` never get
   the check even when an object exists.
5. Gateway `GetRunResult` (P3.6, docs/API.md:271-281):

| Run | Response |
|---|---|
| terminal, inline `result` | 200, body is the document, `Content-Type: application/json` |
| terminal, `result_ref` only | 307, `Location: presignGet(ref)`, `Cache-Control: no-store` |
| terminal, neither | 404 `RESULT_MISSING` |
| not terminal | 400 `FAILED_PRECONDITION` `RUN_NOT_TERMINAL` |
| `FAILED` or `CANCELLED` with an inline result | 200 (a 200 means a result exists, not success) |

The client follows the 307 without `Authorization` or any krun header
(docs/API.md:274-277); krun never proxies the object body.

## Why exists-before-CAS

The delivery row is inserted inside the terminal transaction
(SPEC.md:348-351). If the object check ran after the CAS, the payload
stored in `deliveries.payload` would lack `resultUri` and receivers would
get a `SUCCEEDED` run with no way to reach the result. The check is also
the only point where a missing upload is detected: a function that exited
0 without uploading yields a `succeeded` run with no result, and
`GetRunResult` answers `RESULT_MISSING` (docs/API.md:277-278).

## Lifecycle and retention

- krun never deletes objects (SPEC.md:654). The sweep (`krun-scheduler-k8s`)
  removes rows only.
- Set a bucket lifecycle expiration of at least `KRUN_RETENTION`
  (`config.retention`, default `720h`); object age counts from upload,
  which precedes `finishedAt`, so "at least" matters (docs/OPERATIONS.md:58-60).
- A swept run row leaves an object behind until the rule fires; a rule
  shorter than retention leaves a row whose `GetRunResult` 307 points at a
  deleted object (the client sees the store's error, calls `:getResult`
  again and gets a fresh URL to the same missing key).

## Egress policy (jobs namespace, chart owns the rendering)

Function pods need egress to the object store only when
`objectStorage.enabled`: the peers in `objectStorage.egress` (ipBlock, or
namespaceSelector + podSelector for in-cluster MinIO) on the port parsed
from `objectStorage.endpoint`, default 443 or 80 (SPEC.md:1018-1021). The
gateway and scheduler pods sit in the krun namespace, which has no egress
policy in v1 (SPEC.md:1056). The P6.3 e2e uses a raw NetworkPolicy
manifest in the pre-chart jobs namespace allowing egress to the MinIO pods
(PLAN.md:648-650).

## Tests

- P6.1 (PLAN.md:639-641): MinIO testcontainer (`minio/minio`, `server /data`,
  port 9000, `Wait.forHttp('/minio/health/live', 9000)`); `presignPut` then
  a raw `fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/json' } })`
  returns 200; `exists` false before and true after; `presignGet` URL serves
  the bytes; `exists` on another bucket name throws rather than returning
  false.
- P6.2 (PLAN.md:645-647): fake `ObjectStore`; the delivery payload carries
  `resultUri`; an inline result skips `exists`; `ttlSeconds` equals the
  parsed `KRUN_S3_PRESIGN_TTL` when set and `activeDeadlineSeconds`
  otherwise; an `exists` throw leaves the run in its previous state.
- P3.6 (PLAN.md:412): five branches above with a fake `ObjectStore`;
  assert `Cache-Control: no-store` and no `Authorization` echo on the 307.
