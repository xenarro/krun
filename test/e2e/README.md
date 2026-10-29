# Disposable kind/e2e gate

This harness is local infrastructure, not a production installer. It creates
only the `krun-test-e2e` cluster and an ownership-labelled `kind-registry`
container, bound to `127.0.0.1:5001`. Do not reuse these names for other work.

Prerequisites: Docker, kubectl 1.37, Helm4.3.0, the exact kind version in
`.kind-version`, Node from `.node-version` and locked pnpm dependencies.
`images.json` pins the Kubernetes node, registry and curl manifests by digest.
CI installs the same pinned Helm and kind; kind0.33 includes enforcing kindnetd.
No third-party CNI or database operator is installed.

    make e2e
    make kind-down

`kind-up` creates/reuses only owned infrastructure, configures every node's
loopback-registry mirror and standard discovery ConfigMap, builds the current
Dockerfile and pushes only to that registry. The acknowledged manifest digest
is authoritative. It also builds/deploys the genuine checksum-pinned MinIO
fixture in its restricted namespace and initializes the private bucket. It does
not install the application or submit Runs.

`make e2e` installs the actual chart twice, sequentially: embedded in a fresh
`krun-test-embedded` namespace and postgres in a fresh `krun-test-postgres`
namespace, each with its own fresh `-jobs`, `-monitoring` and `-outsider`
namespaces. Platform PSA is explicitly enforced as `restricted`;the chart
owns jobs PSA/RBAC/budgets/policies/admission. Test-only `crds.keep=false` and
`jobsNamespace.keep=false` allow complete removal before the other mode. The
chart installs the CRD, not a parallel raw platform manifest. All prerequisite
Secret contents are generated privately and sent through stdin,never values or
argv. Only references enter the Helm release. Embedded uses its real PVC;
postgres uses `postgres.yaml`, an ordinary restricted Postgres18 Deployment and
Service with generated existing-Secret credentials, not an operator.

Both serving processes receive S3 settings and account Secret references from
the chart,callback host/CIDR allowlists are scoped to the actual test namespace
and kind Pod/Service CIDRs,and only scheduler receives the signing Secret.
`objectStorage.egress` selects only the genuine MinIO namespace/server on9000.
There are no raw platform, jobs-policy or separate MinIO-egress manifests.

For each mode the mandatory open/deny/reopen scratch probe still runs before
Vitest. Only an explicit remote client timeout counts as denial; kubectl,API
and exec errors fail. A native API projection and process log privacy smoke
remain mandatory. The separate runner then executes the eight earlier
execution/wait/webhook/large-result scenarios and `chart.e2e.ts`.

The chart scenario proves jobs-to-internal8081 and no jobs-to-public8080,
including actual embedded Pod labels,monitoring-selection open/deny/recovery
for every real admin port,and outsider denial. Removing/restoring only the
chart storage allow proves real MinIO egress enforcement. A pinned admission
control passes;an actual hand-created tag-only Job is rejected by
`krun-jobs-digest` and confirmed absent. Postgres runs two Ready schedulers with
one actual leader gauge matching the single Lease.

The lifecycle test executes `helm upgrade --reuse-values --set
config.logLevel=debug`,then `helm rollback e2e 1`,with both rollouts Ready,new
Pod UIDs and a successful Run after each. After exact Ready Pod convergence,a
bounded unauthenticated GET must observe401 through the actual public Service
before the next single POST;mutating requests are never replayed. Embedded's pre-upgrade FULL Run must
remain identical/readable across both changes. Postgres also submits a Run
while old and new serving Pods coexist during each actual rollout,checks the
successful native Helm migrate-hook execution receipt on upgrade,and observes
the same Lease plus a single leader gauge on a new scheduler Pod. The measured
handover upper bound must remain below the configured Job TTL;it is not
presented as an exact outage duration. A dedicated in-cluster public client
survives gateway replacement without replaying POSTs;credentials travel only
on stdin. Existing function-Pod/run-credential and all-replica process-log
privacy oracles still run. Every test uses the existing runner budgets and
visible single retry;no application timeout,retry,worker or isolation policy is
relaxed. Per-mode chart uninstall and namespace absence are read back;CI always
also invokes complete owned cluster/registry cleanup,including on failure.

This is the local P7.6 implementation gate,not independent review,hosted
acceptance,PLAN closure,production use or publication. P7.7 monitoring/full
Phase7 remain separate. The historical sections below record the earlier
raw-foundation gates;the chart procedure above is the current entrypoint.

## Phase 4 scenarios (P4.13)

The separate Vitest runner requires all eight `*.e2e.ts` files (five Phase 4,
two Phase 5 and one Phase 6); an empty suite fails. File execution is sequential, with a unique generated Function
per file, the existing bounded test/hook budgets and one visible runner retry.
The phase gate passes locally and in [exact source-head hosted CI](https://github.com/xenarro/krun/actions/runs/40523418351)
for `2f8f5e2` ([PR #59](https://github.com/xenarro/krun/pull/59));
both `verify` and `kind`, including owned cleanup, pass. Independent correctness/
contracts review and the actual Run-credential privacy repair are complete.
Required repository approval/merge remains separate; tracking receives its own
checked commit. This is Phase 4 acceptance, not production or later-phase acceptance.

- `success`: input fetched through the internal API, one accepted status and an
  inline result PUT. The public FULL Run succeeds with the exact opaque result.
- `exit_code`: exit 1, `EXIT_CODE`, non-empty marker-bearing log tail, terminal
  detection within ten seconds of the observed native `finishedAt`.
- `exit_code_status`: two accepted reports spaced by the normative rate limit,
  exit 3, retained second report, exact exit code and bounded terminal log tail.
- `image_pull_backoff`: missing local digest, current scheduled
  `ImagePullBackOff`, native Job deadline 60 seconds, then `DEADLINE_EXCEEDED`.
- `heartbeat_timeout`: one accepted report then silence, a 30-second heartbeat
  window, `HEARTBEAT_TIMEOUT` and log tail, and positively observed Job removal
  within sixty seconds of that report.

The four runnable fixtures are tiny shell entrypoints FROM the curl manifest
pinned in `images.json`; `functions/Dockerfile` does not change the base runtime.
Their scripts use `set -eu`, `--fail-with-body` and bounded GET/PUT retries;
status reports use one attempt. Images are built and pushed only to the owned
loopback registry, using the acknowledged digest, never to a remote registry.
Function v1 has no command/args override, so no API/schema extension is needed.

The public API is reached through a private loopback-only ephemeral
port-forward. Pod WATCH starts from a real LIST resourceVersion before Run
submission, retaining fast native terminal events. Missing/null timestamps from
never-started containers remain unknown; only actual finish timestamps prove
exit latency. API/watch errors cannot prove an absent resource. Each file checks
Pod manifests and process logs for generated credentials/input markers, cancels
unfinished owned runs on cleanup, removes only its Function-labelled resources,
reads back deletion and bounds shutdown of its kubectl children. Raw private
responses, manifests, logs and credentials are not printed as diagnostics.

## Phase 5 scenarios (P5.4)

The complete local `make e2e` gate now passes all seven scenarios, including the
unchanged Phase 4 regressions and mandatory policy-enforcement probe. P5.4 is
implementation-local evidence; independent review and hosted acceptance remain
separate, and PLAN is not closed by implementation.

- `wait`: reuses the success curl function. CreateRun with `?wait=30s` returns
  201 with `SUCCEEDED` and its inline result. WaitRun on that same Run returns
  200 with the entire identical FULL resource. Both clients use a transport
  bound above the requested wait; no terminal result is fabricated or seeded.
- `webhook`: reuses the success function with a callback to its own receiver
  Service/Pod. The receiver returns 500 then 200 and observes the actual
  one-minute retry, the same delivery and Run IDs and unchanged raw BASIC bytes.
  Both rotation signatures are independently verified over those incoming bytes,
  with the five-minute timestamp window. The retry has a newer send timestamp
  and a distinct valid attempt trace context.

`kind.yaml` explicitly fixes the Pod and Service subnets; both serving processes
receive those exact CIDRs and only the `krun-test-webhook-*` Service hostname
pattern. `kind-up` generates two disposable signing values in private state and
one Kubernetes Secret. Pod manifests contain only references to that Secret.
No production webhook policy, jobs-namespace isolation or application retry
schedule is relaxed. The receiver is nonroot, read-only, capability-free,
restricted, without a service-account token, and ingress selects only existing
serving Pods. Its ConfigMap, Service, NetworkPolicy and Pod share a unique
scenario cleanup label, including after partial setup failure, and deletion is
read back before the test exits.

The receiver validates the canonical public BASIC schema, rejects FULL fields
and verifies each configured key without importing the sender's signer. It
retains sanitized verdicts, never bodies, callback queries, signatures or key
material in diagnostic output. Its mounted source uses the compiled contract
in the real runtime image; host tests use source contracts, including on a
fresh checkout without `dist`. The source is a single-file `subPath` mount:
a directory ConfigMap mount exposes versioned symlinks and changes Node's real
entrypoint/relative import resolution. Native failure evidence and a red/green
mount contract qualify that correction; the final complete gate has no skips.

SSE behavior has its P5.2 handler/native stream controls, not a new P5.4 kind
scenario. The later Phase 6 large-result gate is recorded below;chart/admission
scenarios remain Phase 7 and capacity/security acceptance Phase 9. The Phase 5
section alone makes no production,SDK or object-storage completion claim.

## Phase 6 scenario (P6.3)

The complete local `make e2e` gate passes all eight scenarios with genuine
MinIO in `krun-test-minio` and S3 enabled in both real process graphs.
`large_result.e2e.ts` runs a Node26 author Function built from the same immutable
runtime image. It reads the actual internal input and uploads exactly one MiB
of JSON through its designated signed PUT URL, without an inline result or S3
account credentials. Author source directories use traversable read-only modes.

The native FULL Run exposes the canonical external `resultUri` and no inline
result. Authenticated `:getResult` returns a bodyless no-store 307 with a
300-second signed GET. A separate in-cluster client receives only that URL,
not the krun API key, and verifies the raw object's exact byte length and SHA256.
Anonymous public access is 401;unsigned native object access is 403. A direct
readonly SQLite/native HTTP readback independently confirms the stored reference,
zero redirect-body bytes and genuine one-MiB object. MinIO's running binary
matches the upstream release checksum from `test/minio/Dockerfile`.

`minio.yaml` has no account values: generated material is held only in private
owned state and Secrets referenced by the restricted server,initializer and
serving processes. `allow-minio.yaml` selects only that namespace plus the
MinIO server Pods on TCP9000. Removing just this allow causes real uploads to
fail and leaves external refs absent; restoring the exact policy restores the
positive native acceptance. No jobs default-deny or enforced-policy probe is
removed or relaxed.

Pod privacy permits only the required `KRUN_RESULT_UPLOAD_URL` env value after
checking its Run identity, internal endpoint and owned object key. It is not a
blanket Pod URL exemption. Input, actual Run/API/webhook/S3 credentials and other
signed URLs are still forbidden in manifests or gateway/scheduler/MinIO logs;
account credential env fields or account Secret references in a Function Pod
are rejected. The original implementation gate covers eight privacy oracles and nine actual Run
credential contexts because the existing `exit_code_status` case used its
unchanged single retry; the new large-result case passed first attempt. The
first-attempt failure cause remains unestablished and is not hidden or promoted
to a no-retry claim. Initial fixture configuration, directory-mode and client URL
failures and their red/green corrections remain in the owned P6.3 evidence.

Post-review repair validates a closed, single-valued SigV4/PutObject query,
calendar-valid signing date, credential date/region/service scope, actual public
access-key identity and bounded expiry before excluding the capability. Raw and
decoded values are checked against known private input, tokens and API/webhook/S3
secrets; only the credential's public key component and previously validated
capabilities receive their precise exceptions. Unknown or duplicate parameters
and private signature/credential substitutions fail before observation. Both
independent six-control replays pass against the repaired source.

The disposable bucket initializer now HEADs the bucket and creates it only after
an actual 404. Existing buckets succeed; 403 and infrastructure errors still fail.
Four failing-first script controls and genuine MinIO diagnostics cover repeated
initialization without changing the 90-second Job or ten-second request bounds.
The earlier initializer deadline and generic cleanup-hook failure remain retained
and qualified, not attributed to invented causes. Cleanup errors now identify
only fixed safe stage names, never private exception details.

This is local acceptance, not hosted delivery,
a PLAN closure,production chart installation, SDK completion or publication.

## Ownership and recovery

Every kubectl call supplies both an isolated kubeconfig and the explicit
`kind-krun-test-e2e` context. The kind create, export and delete commands also
explicitly select that private kubeconfig, including partial-setup recovery;
none may fall back to the ambient configuration. Setup does not select or mutate the ambient
current-context. The private state directory is under `TMPDIR` (or the OS's
temporary directory) and includes a hash of the checkout path. It is mode 0700;
its kubeconfig, generated API credential and rendered manifests are private.
Do not copy those files into the repository or publish them as CI artifacts.
Use the same checkout and `TMPDIR` for setup, verification and cleanup.

A registry with the recipe's fixed name is reused or deleted only when its
ownership label and loopback port binding match this checkout. An existing
cluster without this checkout's private ownership state is refused. A lock
prevents concurrent harness commands from sharing or tearing down an active
setup. Keep the private state when recovering an interrupted run; do not
replace it with fabricated ownership. After the active command has exited,
remove only its stale lock directory if an uncatchable process termination
left it behind, then rerun `make kind-down` or `make kind-up`.

`make kind-down` deletes the owned kind cluster, the owned local registry and
its anonymous storage, confirms their absence, and removes private state.
It is repeatable. CI runs it under `always()`, including after a failed gate.
It does not publish images, change production clusters or remove other local
clusters. `node test/e2e/cluster.ts diagnostics` prints only selected Pod status
fields, never kubeconfig/Secret contents or raw application logs.
