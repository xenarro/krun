# Disposable kind/e2e gate

This harness is local infrastructure, not a production installer. It creates
only the `krun-test-e2e` cluster and an ownership-labelled `kind-registry`
container, bound to `127.0.0.1:5001`. Do not reuse these names for other work.

Prerequisites: Docker, kubectl 1.37, Helm4.3.0, the exact kind version in
`.kind-version`, Node from `.node-version`, uv 0.13.1/Python 3.13 and locked
pnpm dependencies.
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

The foundation also generates both language projects through the freshly built
CLI, vendors the current packed Node SDK/Python wheel and runs the projects'
generated tests. Their unchanged Dockerfiles build with `--network=none` after
the project lockfiles exist. Only the owned loopback registry receives pushes;
acknowledged manifest digests become the generated Functions' images. The
fixture handlers in `functions/sdk-node.js` and `functions/sdk-python.py` keep
the default result but select thrown-error/75-second paths through input. They
use the SDK, never a second hand-written internal-API client. Test Function
input schemas permit private canaries and use 30-second heartbeats and
120-second Job deadlines.
Host Python tests invoke the environment's interpreter explicitly so a noexec
TMPDIR does not require executing its pytest script.

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
execution/wait/webhook/large-result scenarios, `chart.e2e.ts`, and six SDK
cases in `sdk_{success,error,heartbeat}.e2e.ts`. The local P8.6 gate passes 17
tests per mode (34 total). SDK successes require exact inline results; thrown
exceptions require FUNCTION/EXIT_CODE, retained logTail and native exit 1. Slow
cases positively observe a live Job plus RUNNING SDK status reports spanning
at least 30 seconds, then succeed after the 75-second handler. All six cases
in each mode run the existing credential and process/object-store/Pod privacy oracles;
no native runner deadline, retry, worker or security override is introduced.

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

## CLI deploy acceptance (P8.7)

`deploy.e2e.ts` reuses the real CLI-generated, vendored projects prepared by the
owned foundation. For each language and chart mode it runs the actual CLI in
that project, with only the owned kubeconfig and loopback registry available.
`--no-apply` receives a nonexistent kubeconfig and must leave every Function
item unchanged while writing a digest. Full deploy must reach current-generation
Ready=True and print exactly the three documented commands. A synthetic output
canary and an ignored SDK-mode setting must never appear in CLI output.

Both invocations' digests are independently checked against registry manifest
bytes. Readback accepts OCI indexes, Docker manifest lists and single-image
manifests: a successful push may legitimately identify an index. The Dockerfiles
copy the whole project, including function.yaml, so pinning that file can change
the next build's digest; each invocation is verified separately, not assumed
identical. Each case removes only its explicitly named test Function. The
private project-path receipt is removed with the owned foundation on kind-down.
Existing scenario retries, deadlines, concurrency and security oracles remain
unchanged; a failed attempt is retained rather than counted as a pass.

Final frozen-source P8.7 native acceptance passes 19 tests in each mode (38 total,
13 files per mode), including four canonical CLI deploy/no-apply cases, with no
runner retry observed. The accepted source corrects OCI-index media negotiation
and prints the canonical Function-scoped GetRun URL. The CLI image hash/help
verification and owned kind-down command also pass; final consolidated cleanup
readback and whole-check results live in the implementation report. The entire
unchanged whole check passes 2,383 TypeScript and 110 Python tests under the
existing hardened two-CPU verifier with scoped best-effort I/O priority0;
original deadline failures are retained, not hidden or universally repaired.

Post-review cancellation/tag repairs rerun the unmodified full native gate:
all 38 tests pass again in both modes, against a rebuilt matching CLI image.
Separate real-daemon, barrier-interleaved working copies each pin their own
built image using distinct invocation tags; local tag cleanup is read back.
Real inherited-pipe helper interruption, timeout and CLI SIGINT/SIGTERM controls
pass, and a deliberately escaped pipe holder verifies the five-second drain
bound. The complete repaired-source whole check passes 2,387 TypeScript and
110 Python tests, including 153 CLI cases, under the same hardened two-CPU,
1,800-second profile and scoped I/O priority. Source, image/archive correspondence
and exact owned cleanup are verified separately from later Git delivery.

## Backpressure acceptance (P9.1)

`backpressure.e2e.ts` adds one native case per chart mode. Its own Function uses
`maxQueued=1000` and `maxConcurrency=5`; its curl producer posts an accepted
`holding` status and blocks on an observer-controlled FIFO, not a timed sleep.
A test-only `count/jobs.batch=0` ResourceQuota first isolates queue admission.
The non-admin generated backpressure key is restricted to these Functions and
`maxQueued=10`: ten creates succeed, the eleventh is canonical key-limited
`QUEUE_FULL`. After their cancellation/readback, exactly 1,000 of 3,000 further
sequential creates succeed; 2,000 must return canonical function-limited
`QUEUE_FULL` with `Retry-After: 1`. A `RATE_LIMITED`, transport failure or unrelated
429 cannot satisfy the oracle. The disposable chart configures the existing
rate bucket at 1,000 requests/s, burst 4,000; production defaults are untouched.

The actual scheduler counter must classify quota failures, attempted Runs remain
queued, and the continuous LIST-resourceVersion-anchored Job watch stays empty.
The test cancels surplus Runs through the public API before removing its own
quota, then positively observes five running held producers. A sixth Run must
stay queued across multiple real scheduler ticks. Releasing one FIFO permits
that Run to start, giving six distinct native Jobs with a maximum of five
nonterminal Jobs. Pending and deleting Jobs count until a terminal condition or
DELETED event; watch errors fail, never prove absence. All six executions use
the existing run-credential/input/Pod/process/object-store privacy oracles. Only
this scenario declares the two exact generated test principals; the default
single-principal fence stays unchanged, foreign creators fail and a changed
creator fails credential identity checks. Every runner attempt owns a fresh
scenario scope. The metric scraper honors both explicit admin addresses and the
documented default9090 when the environment omits it.

Foundation setup now requires a positive read-only MinIO health response from
the actual restricted initializer Pod before S3 calls. Kubelet readiness alone
does not prove that client Service/DNS/policy path. The bounded preflight uses
at most ten two-second reads and drains their bodies; exhausted readiness
fails, and AWS403/503 responses still fail without a bucket-create attempt.
The original90-second Job deadline and ten-second S3 bounds stay unchanged.
No S3 mutation, API submission or scenario retry is added. Original foundation
failures and same-image DNS/HTTP/S3 diagnostics remain in the implementation
evidence; this is not a claimed universal repair of host timing failures.
Cleanup reads back all 1,011 accepted Runs as terminal and the quota/Function/
label-owned resources as absent. No application/runtime dependency, runner
budget, retry, worker, network, admission or supply-chain policy is relaxed.

This scenario is not a concurrent multi-replica admission benchmark or the
complete Phase9 gate; security, measured benchmarks, quick start, restore and
release remain separate tasks. Run it through the normal two-mode `make e2e`.

The native Job observer stays live while all owned Runs are cancelled and all
nonterminal Jobs settle. Teardown then joins child close (including stdout drain)
and rejects any sticky watch error, truncated final record or nonzero final Job
occupancy before emitting its success record. Cancellation transport/validation
failures join all sibling workers before propagating; failed mutations are not
replayed by that sweep. Ten controlled lifecycle regressions and independent
real-process/loopback controls cover both failure paths as well as normal close.

The repaired frozen-source qualification has 20 tests across 14 files in each
mode (40 tests total). Each backpressure case records 1,000 admissions, 2,000
canonical queue rejections, four quota classifications, six executed Jobs with
maximum occupancy five, six credential/privacy witnesses and 1,011 terminal
owned Runs. Final observer records positively confirm child/stdout drain and zero
nonterminal Jobs.

The complete embedded runner summary and successful namespace removal are
retained from the interrupted parent command. Postgres has two successful bounded
runner verdicts covering disjoint seven-case and thirteen-case inventories,
including all module hooks; each uses fresh owned namespaces and a successful
policy probe. No interrupted-run case ticks are promoted into clean file verdicts.
Original parent failures and configured retry history remain in the receipts;
no timeout, worker, security or retry setting was relaxed.

Current-image restrictive hash/help checks and final owned infrastructure
cleanup/readback pass. Fresh post-repair `make check` passes 2,405 TypeScript and
110 Python tests, including 153 CLI tests, under the unchanged hardened profile.
The private report links exact receipts, case identities and source hashes.
Independent repair review and hosted delivery remain separate.

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
