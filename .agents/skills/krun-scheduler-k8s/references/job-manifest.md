# Job and Secret manifests (SPEC.md section 7, lines 564-626)

Serves PLAN P4.1 (PLAN.md:463-467) and P6.2 (PLAN.md:642-647). The
builders live in `apps/scheduler/src/k8s`; the acceptance test is a
golden-file comparison of the rendered Job and Secret for one function.
Line numbers verified against the working tree on 2026-10-23.

## Secret (SPEC.md:568-573)

> Secret `krun-<run id>`, `immutable: true`, key `token` (32 random bytes,
> base64url; only its SHA-256 is stored in `runs.job_token_hash`, before
> the Job exists), labels `krun.io/run-id`, `krun.io/function`,
> `krun.io/created-by`, `app.kubernetes.io/managed-by: krun`. No owner
> reference. The scheduler deletes it on the terminal transition. A sweep
> deletes orphans older than 1 hour by label.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: krun-<id>
  namespace: <KRUN_JOBS_NAMESPACE>
  labels: { krun.io/run-id: <id>, krun.io/function: <function>, krun.io/created-by: <key name>, app.kubernetes.io/managed-by: krun }
immutable: true
type: Opaque
data: { token: <base64 of the base64url token> }   # or stringData: { token: <base64url token> }
```

Token: `randomBytes(32).toString('base64url')`; hash
`createHash('sha256').update(token).digest('hex')` goes to `setJobToken`
before `jobs.create` (SPEC.md:820-822, D27 SPEC.md:1468). The token is
never logged (SPEC.md:1149-1154).

## Job (SPEC.md:574-626, verbatim)

> Job `krun-<run id>` (41 characters, within the 63 limit):

```yaml
metadata:
  labels: { krun.io/run-id: <id>, krun.io/function: <function>, krun.io/created-by: <key name>, app.kubernetes.io/managed-by: krun }
spec:
  backoffLimit: 0
  activeDeadlineSeconds: <function value>
  ttlSecondsAfterFinished: <KRUN_TTL_AFTER_FINISHED>
  template:
    metadata:
      labels: { krun.io/run-id: <id>, krun.io/function: <function>, krun.io/created-by: <key name>, app.kubernetes.io/managed-by: krun }
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 30
      serviceAccountName: <function value>
      automountServiceAccountToken: false
      imagePullSecrets: <function value>
      nodeSelector: <function value>
      tolerations:
        - { key: node.kubernetes.io/not-ready,   operator: Exists, effect: NoExecute, tolerationSeconds: 60 }
        - { key: node.kubernetes.io/unreachable, operator: Exists, effect: NoExecute, tolerationSeconds: 60 }
      securityContext:
        runAsNonRoot: true
        runAsUser: <function value, default 65532>
        runAsGroup: <function value, default 65532>
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: function
          image: <digest-pinned image>
          imagePullPolicy: IfNotPresent
          resources: <function value>
          env:
            - { name: HOME, value: /tmp }
            - { name: KRUN_RUN_ID, value: <id> }
            - { name: KRUN_FUNCTION, value: <function> }
            - { name: KRUN_GATEWAY_URL, value: <KRUN_GATEWAY_INTERNAL_URL> }
            - { name: KRUN_TOKEN, valueFrom: { secretKeyRef: { name: krun-<id>, key: token } } }
            - { name: KRUN_RESULT_UPLOAD_URL, value: <presigned PUT, only when object storage configured> }
            - { name: KRUN_MAX_RESULT_BYTES, value: <KRUN_MAX_RESULT_BYTES> }
            - { name: KRUN_HEARTBEAT_TIMEOUT, value: <seconds, only when the Function sets heartbeatTimeout> }
            - <function env>
          envFrom: [{ secretRef: { name: <each secretRef> } }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
```

Add `metadata.name: krun-<id>` and `metadata.namespace: <KRUN_JOBS_NAMESPACE>`;
no owner reference on the Job either (nothing in SPEC sets one; an owner
reference to the Function would GC in-flight runs on re-apply).

## Env list, in order

| Name | Value | Present |
|---|---|---|
| `HOME` | `/tmp` | always (RO rootfs; `/tmp` is the only writable path) |
| `KRUN_RUN_ID` | run id | always |
| `KRUN_FUNCTION` | function name | always |
| `KRUN_GATEWAY_URL` | `KRUN_GATEWAY_INTERNAL_URL` (SPEC.md:1195) | always |
| `KRUN_TOKEN` | `secretKeyRef { name: krun-<id>, key: token }` | always; never a literal value |
| `KRUN_RESULT_UPLOAD_URL` | presigned PUT for `runs/<id>/result.json`, TTL `KRUN_S3_PRESIGN_TTL` or `activeDeadlineSeconds` (SPEC.md:649-652, SPEC.md:1213) | only when `KRUN_S3_*` configured (P6.2) |
| `KRUN_MAX_RESULT_BYTES` | `KRUN_MAX_RESULT_BYTES` (SPEC.md:1201) | always |
| `KRUN_HEARTBEAT_TIMEOUT` | whole seconds, parsed from the Function duration | only when the Function sets `heartbeatTimeout` |
| `<function env>` | from the Function spec | appended after krun's entries |

`envFrom` carries one `secretRef` per Function `secretRefs` entry (never a
`krun-*` name; the second validation layer rejects those, SPEC.md:143).

## Builder rules

- Name `krun-<uuid>` is 41 characters; `krun.io/run-id` and `krun.io/function`
  are label values, so both must satisfy the 63-char label rule. The
  Function name already passes the CRD pattern; the run id is a UUIDv7
  (D9 SPEC.md:1450). Validate anyway in the builder; KEDA's webhook rejects
  over-long names for exactly this reason (keda `scaledobject_webhook.go:57-58`).
- Deterministic names make create idempotent after a timed-out call: a
  retry hits `409 AlreadyExists`, which counts as success (SPEC.md:822-823;
  keda `scale_jobs.go:205` uses `generateName` and cannot retry safely).
- Defaults `runAsUser`/`runAsGroup` 65532 when the Function sets none;
  `imagePullSecrets`, `nodeSelector`, `resources` copied from the Function,
  omitted when unset (do not emit empty objects into the golden file).
- The input never appears in env, manifest, Secret or logs: the pod fetches
  it over the internal API (D16 SPEC.md:1457, SPEC.md:1087-1089).
- The manifest is exact. Fields that a competitor adds and SPEC does not
  (`terminationMessagePolicy: FallbackToLogsOnError`, `enableServiceLinks:
  false`, `krun.io/function-generation` labels) need a Decisions row before
  they enter the builder; see SKILL.md "SPEC RISK".

## Golden-file test (PLAN.md:466-467)

Render one Function with `secretRefs`, `heartbeatTimeout`, `nodeSelector`,
custom `runAsUser`, object storage on and off; compare the JSON with
`node:test` `assert.deepStrictEqual` against a checked-in fixture. The
fixture must not contain a real-looking token or presigned URL; use
`example` placeholders and a fake presigner in the test.
