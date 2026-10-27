# krun

HTTP-triggered functions, executed as one-off Kubernetes Jobs. Callers submit JSON input over HTTP and observe durable status, results and failures without holding Kubernetes credentials.

## Development status

The scaffold, configuration, admin health/telemetry and complete dual-backend Store layers are implemented locally. This is not a runnable function platform yet:

- Strict TypeScript workspace on Node.js 26, with Effect 4 process entrypoints.
- Zod configuration schemas and Effect services for gateway and scheduler settings.
- Dependency-free Node.js and Python SDK package skeletons; SDK runtime behavior is pending.
- Digest-pinned, non-root distroless container packaging.
- CI checks for types, formatting, tests, unused code, generated files, container packaging, chart lint and critical vulnerabilities.

Admin health and telemetry are reusable scoped layers wired into both gateway and scheduler processes (P4.11). The separate admin app serves `/healthz`, Ref-backed `/readyz` with a two-second database timeout, initial Function-LIST and shutdown gates, and non-gating leader status. `TelemetryLive` bridges Effect metrics to the OpenTelemetry Prometheus exporter on `/metrics` without an exporter-owned port or global registry. When a parsed OTLP endpoint is set it installs the real HTTP batch trace exporter, using the parsed service name and explicit sampler; otherwise traces are not exported. Scope exit closes the reader and flushes/shuts down tracing. Invalid sampler values fall back nonfatally with variable-name-only warnings; an invalid endpoint disables tracing without disabling metrics.

Readiness's HTTP deadline does not wait for database cancellation cleanup. Overlapping probes share at most one DB worker; the readiness layer owns that worker until its cleanup completes, so repeated timeouts cannot accumulate abandoned checks. Client disconnects cancel both Effect-backed admin routes. Admin scope release cancels and settles active handlers before dependent layers close. Cleanup remains cooperative: uninterruptible cleanup is awaited by its owner, not detached or forcibly discarded.

Health/telemetry acceptance covers real Prometheus collection through Fastify `inject`, stalled-database timing through `TestClock` (including slow finalizers and uninterruptible work), real socket disconnects, handler/dependency teardown ordering, reader/provider cleanup, and actual OTLP JSON sent to a disposable local collector. Run `pnpm exec vitest run packages/shared/src/health packages/shared/src/runtime` for this slice. P0.7 module acceptance and hosted CI passed for [PR #3](https://github.com/xenarro/krun/pull/3), including the reviewed lifecycle repairs, container rebuild, smoke, audit and fixable-critical scan. [Code CI](https://github.com/xenarro/krun/actions/runs/40019565091) verified reconciled head `9f870d4`, containing implementation commit `afc0375`. The PR remains unmerged pending required independent approval. PLAN records this bounded task; Phase 0 and the application are not complete.

The `gateway` and `scheduler` commands now start real scoped serving processes. Both `--help` commands remain finite and configuration-free. `validate` is a real offline Function validator and `migrate` is a real database command, as described below. Apply migrations explicitly before starting serving replicas. Gateway process implementation now passes local source, rebuilt-container and current gateway phase/supporting acceptance. Both independent review findings are resolved; the code is pushed and exact-head hosted CI passes. Protected-stack integration remains pending; no merged delivery is claimed. Scheduler process composition now passes the P4.11 host/image process acceptance below; actual kind/admission/Job execution remains P4.12/P4.13. See [PLAN.md](PLAN.md) for acceptance criteria and progress.

## Disposable kind foundation (P4.12)

`make kind-up` now builds and deploys the current hardened image into the owned
`krun-test-e2e` cluster. `.kind-version` pins kind 0.33.0, and `test/e2e/images.json`
pins its Kubernetes 1.37 node and registry:2 manifests by digest. The local
registry follows kind's localhost:5001 recipe, including per-node containerd
mirrors and the discovery ConfigMap. Both real processes share embedded SQLite,
with explicit init-container migrations, restricted security contexts, separate
admin ports and the scheduler's downward-API Lease identity. The generated CRD
and raw jobs namespace isolation/RBAC/limits/quota are applied before a
kubectl-applied Function reaches current `Ready=True`.

Local `make e2e` now passes with zero behavioural scenarios. Before the empty
Vitest runner, it proves a real pod-to-pod connection opens, default-deny blocks
it, and policy removal restores it; it also checks the authenticated Function
projection and generated-key log privacy. Kubernetes/API/exec errors cannot
stand in for an observed blocked connection. The harness uses a private
kubeconfig and explicit test context, leaving even an unusable ambient context
unchanged. `make kind-down` removes owned resources; CI has a separate SHA-pinned
kind job using the same version and an always-run cleanup step. Hosted task-head
CI awaits independent review/delivery; no new hosted run is claimed here.

The first real API run exposed and reproduced a Lease MicroTime write defect:
ordinary Date JSON has three fractional digits, but Kubernetes requires six.
The native Lease adapter now normalizes both timestamp fields without mutating
its caller or losing precision in read strings. Failing-first create/update
wire tests and the rebuilt real-cluster serving acceptance pass.

See [test/e2e/README.md](test/e2e/README.md) for prerequisites, ownership and
recovery. P4.13 still owns the actual Run/lifecycle/failure scenarios and the
complete Phase 4 gate; a passing foundation is not completion of that phase.

## Scheduler process (P4.11)

`krun scheduler` now serves the admin listener and assembles real Config,
Telemetry, Database/Store, a single shared bounded Kubernetes connection,
Function LIST/WATCH cache, Lease election and the existing scheduler components.
Migrations remain an explicit `krun migrate` operation before serving startup.
Set `KRUN_POD_NAME` from downward API `metadata.name`; it is required by the
serving process and never inferred from a hostname. Embedded mode also needs a
writable `KRUN_DB_PATH`; use a distinct admin address from the gateway (the
chart's scheduler convention is `:9091`).

Every replica maintains its Function cache. `/readyz` stays unavailable until
Function synchronization and a bounded database check succeed, while `/healthz`
remains independent. A standby returns ready with `leader: false`, exports a
zero leader gauge and starts no Job/Pod watches, scheduler loops or status writes.
The leader acquires Job/Pod informers and wires the shared controller, main loop,
lost-Job reconciliation, heartbeat, retention sweep and Function status writer.
Claiming waits for Function synchronization and both initial Job/Pod LISTs.

SIGTERM marks draining before stopping work; leader calls and Job/Pod watches
settle, the Function informer stops, the owned Lease is released, then admin and
Store resources close before telemetry. Real host and hardened-image tests exit
zero within five seconds with an empty holder and no live watches. A stolen
Lease instead exits nonzero, closes watches and never clears its successor.
Tests also drive an actual SQL row through native Secret/Job creation and a
cached completion to `succeeded`, verify cleanup and lifecycle metrics, inject
a real database failure (readiness503/liveness200), and preserve terminal work
rather than invent success when configured result storage lacks its P6.2 adapter.
A deterministic interruption regression also fences process Function cleanup
before Lease release when elected work never enters. Additional real PostgreSQL18
standby and leader process probes pass on host and image,including native
completion and zero remaining pool/LISTEN connections after shutdown.
The same five embedded process controls run against source and the rebuilt nonroot,
read-only image via `scripts/smoke-scheduler.ts`; CI now exercises this real
process boundary as well as finite scheduler help.

Object-store transport/wiring remains P6.2 and webhook delivery P5.3. This is
assembled-process acceptance over a disposable loopback API and real SQL, not
actual Kubernetes admission, garbage collection or Job execution. The complete
kind/e2e phase gate remains P4.12/P4.13; no whole-phase pass is claimed.

P4.11 source is pushed in [PR #56](https://github.com/xenarro/krun/pull/56) at
`9d2dfe4797b15450c31450f1c9945a5b153abc98`. Its [exact-head CI](https://github.com/xenarro/krun/actions/runs/40482390594)
passes all nine gates, including the real hardened-image scheduler process
acceptance and 1,541 TypeScript tests plus one Python test. Required main review
remains pending; this is a green pushed delivery, not a merged-main claim.
Task-only PLAN/README tracking receives a separate fresh check and hosted run.

The following component delivery sections retain their original pre-P4.11
acceptance snapshots. Their historical finite-command/assembly-pending wording
is superseded by this process section, not a statement of the current CLI.

## Sweep component (P4.10)

`makeSweepLoop` is a leader-scoped component behind both Job/Pod initial LISTs.
It runs immediately and then ten minutes after each completed pass, serializing
explicit overlapping iterations too. One Effect-clock retention cutoff is frozen
per pass; the existing `Store.sweep(cutoff, 1000)` repeats until a batch is short.
The caller supplies the parsed retention duration; production configuration and
leader wiring remain P4.11. Each settled SQL batch publishes its exact committed
run count to `krun_sweep_deleted_total` before interruption can stop the pass.
Failed batches and Secret deletions do not inflate that counter.

After SQL retention, the component pages native `krun.io/run-id`-selected Secrets
in the jobs namespace through the shared bounded Kubernetes connection. Only
valid metadata strictly older than one hour, with no current or pending cached
Job, qualifies. Native deletes carry UID/resourceVersion preconditions, and the
Job cache is checked again after permit wait. Exact-age, newer, malformed,
replaced and live-Job Secrets are preserved. Per-Secret failures do not starve
later candidates; 404 is harmless, 409 defers a changed object, and 429 stops
further acquisitions for that pass. Failed work retries on the next pass.

Thirteen fake-clock/stubbed-client controls, four real native HTTP/informer/SQLite
controls and three real span/Prometheus controls pass. Eight compiled native
client/informer/real-Store groups pass on both host and rebuilt hardened image,
each with SQLite and PostgreSQL; all 87 runtime module hashes match. They include
1,001-row retention, strict cutoff and delivery cascades, consistent Secret
pagination, pending ingress, replacement fencing, retry, native request timeout
and leader-scope abort. No Secret data, private API Status text or continuation
cursor enters metrics or spans. These are component boundaries, not actual
Kubernetes admission/garbage collection or the P4.12/P4.13 kind/e2e phase gate;
the `scheduler` command remains finite until P4.11.

Source delivery: [`e9e5091`](https://github.com/xenarro/krun/commit/e9e5091249cff2344a7288afd753c27156b5599b) in [PR#55](https://github.com/xenarro/krun/pull/55) passes [all nine exact-head hosted gates](https://github.com/xenarro/krun/actions/runs/40465434121),
including 1,522 TypeScript tests and one Python test. Both independent reviews
and the supplementary contracts controls are reconciled without product edits.
PR54 is merged; PR55 remains open pending required independent main review at
source acceptance. PLAN/README tracking receives separate full local and hosted
acceptance. No automatic merge or whole-phase scheduler execution is claimed.

## Heartbeat component (P4.9)

`makeHeartbeatLoop` is a leader-scoped component with an immediate first pass
behind both Job/Pod initial LISTs and Function-cache synchronization, followed by
non-overlapping ten-second passes. Only valid Functions with `heartbeatTimeout`
are queried through the existing `Store.listStale`; freshness uses the later of
`startTime` and `runtimeStatus.reportTime`. Complete/Failed cached Jobs, pending
native Job ingress and missing/non-Running Pods are left to the informer path.

A stale candidate fetches bounded `function` logs, awaits foreground Job DELETE,
commits `running` to `failed` with `heartbeat_timeout`, then deletes its Secret.
The controller's per-run gate coordinates this path with informer/lost-Job work;
current same-UID Function validity/timeout, cache state and Store freshness are
refreshed before each new candidate and again after log capture, before the
destructive request. Disabled, deleted, invalid or replaced Functions defer new
judgements; changed durations recompute the cutoff and error message. Already
acknowledged post-DELETE debt still settles independently of later policy changes. The Store preserves a function-reported error and
atomically inserts the BASIC delivery without the separate `logTail`. The existing
committed-row observer counts only a winning heartbeat failure, and invents no
exit-latency sample when the container exit time is unknown.

A failed post-DELETE CAS or Secret deletion retains only leader-local stage
information and a bounded tail. Retry works after cached objects disappear or
the Function's timeout is removed; it neither repeats a successful DELETE nor
recounts a committed failure. Cancellation winning the CAS retains its own
cleanup responsibility. Logs have the same ten-second abort/16-KiB UTF-8-safe
bound as P4.8; Kubernetes I/O remains interruptible when the leader scope closes.

Twenty-six unit and twelve native HTTP controls cover operation order, readiness,
strict timeout boundaries, recent status, terminal observations, error/tail
separation, callback/metric privacy, interruption, overlapping passes and retry
ownership. Eight native repair controls use the actual Function validation/cache
stream to cover changes during a candidate's logs and before later rows start.
Five real in-memory exporter controls verify one `scheduler.heartbeat_loop` span
for empty, fresh, stale, query-error and retry-debt passes, with per-run child
spans and no misleading aggregate run ID. Sixteen compiled
native-client/informer/real-Store groups, including P4.8 regressions and real-cache
later-row policy controls, pass on both host and the rebuilt hardened image with
SQLite and PostgreSQL; all 86 runtime module hashes match. Source
`353462feaa844f5a3c5b03722eb308009b295f2c` in [PR#54](https://github.com/xenarro/krun/pull/54) passes
[all nine hosted acceptance gates](https://github.com/xenarro/krun/actions/runs/40454569909) with
1,494 TypeScript tests plus one Python test, including 265 scheduler tests.
Native loopback HTTP proves requests, parsing and abort, not Kubernetes
garbage-collector completion or actual Job execution.
Production leader wiring remains P4.11 and whole-phase e2e/kind remains
P4.12/P4.13; this component does not make the finite `scheduler` command serve.

## Failure detection component (P4.8)

The leader Job controller captures the `function` container's log tail on the
first nonzero exit, `OOMKilled` or Pod deletion observation, before a later
Job failure and before any cleanup. Exit zero never fetches logs. Terminal-first
observations fetch once as a fallback; missing Pods and failed/timed-out log
requests leave a null tail without preventing the terminal CAS. Native requests
ask for the last 100 lines and 16 KiB, retain the shared request limiter and
AbortSignal, and the capture itself also has a ten-second interruptible bound.
UTF-8-safe truncation cannot create replacement bytes above the stored byte cap.

Existing classification remains `oom_killed` before `deadline_exceeded`,
`evicted`, `disrupted` and `exit_code`. The Store's atomic coalescing preserves a
function-reported error; `logTail` stays separate and outside BASIC callbacks.
An early captured tail also survives `job_lost`, but successful completion
explicitly persists a null tail, including after an earlier deletion-triggered
capture; FULL resources therefore expose tails only on failed runs. A queued
run whose token is already stored can retain bounded Pod diagnostics before
`markScheduled`, without publishing queued `jobStatus`, running or terminal state.
This preserves a first observed failure and exit time even if the Pod is evicted
before scheduling finishes. Leader-local tail/exit-time observations are released
on cleanup, cancellation, Store-row absence or scope closure; no Pod bodies or
history are retained for this feature.

D95 extends the existing committed-row observer with the actual winning
`failure_reason` for `krun_runs_failed_total{function,reason}` across leader
failure paths, including expiry, provisioning and lost Jobs. A call-local
`TerminalExitAt` reference supplies an observed container exit time for
`krun_terminal_detect_seconds{function}` after a successful terminal commit,
measured in seconds with Effect Clock. Stale CAS, rollback, status-only and plain
gateway Store calls emit neither sample; unknown exits invent no latency sample.
No extra Store read or public schema, dependency or security-policy change is
needed. Metrics, spans and logs do not contain the captured tail or error details.

Twenty-three targeted controls, six native HTTP controls, both-backend metric
controls and the full scheduler suite cover early/fallback capture, precedence,
function-error preservation, native timeout/abort, scope closure, UTF-8 boundaries,
failed-only tail persistence, pre-scheduling evidence and committed-only metrics.
Both independent review findings have permanent regressions. Eight compiled
native-client/informer/real-Store groups pass on host SQLite and PostgreSQL;
rebuilt-image integration and complete verification are recorded in the repair
report. Source commit `50a66d1aba801a421d6c89b20101c8771a9766c9` passed all nine gates in
[exact-head CI](https://github.com/xenarro/krun/actions/runs/40444940823) and was independently
approved/merged in [PR #52](https://github.com/xenarro/krun/pull/52). PLAN records the
source acceptance; its separate tracking update receives fresh local/hosted
verification. This is not the assembled scheduler (P4.11) or real kind/admission
acceptance (P4.12/P4.13). The whole-phase
`make e2e` gate still exits 2 at its explicit P4.12 placeholder.

## Leader Function status writer (P4.7)

`makeFunctionStatusWriter` publishes the existing validation result as the
Function's `Ready` condition and `observedGeneration`. It is an explicitly
leader-scoped component: the shared Function cache remains active on every
replica, while writer acquisition/run belongs inside the elected leader term.
A bounded, replay-one cache invalidation stream supplies a complete promotion
pass, including invalid Functions, and coalesces later changes without retaining
old Function bodies or running another informer.

D94 compares the actual cached generation and condition fields. A native
`CustomObjectsApi` JSON Merge Patch changes only status, with UID and
resourceVersion preconditions to reject stale validation after an update or
replacement. Successful writes acknowledge only their exact pre-echo input;
repeated inputs cause no second patch. A newer observation always rechecks real
status, so erasure/drift is repaired. Failed writes acknowledge nothing and do
not prevent other Functions from progressing; the next event or explicit leader
reconcile retries them. Calls use the shared limiter, ten-second Effect Clock
budget and native AbortSignal transport. Scope closure stops the subscription
and clears its compact acknowledgement state.

Fifteen permanent acceptance tests cover invalid/valid conditions, condition-only
changes, repeated input, status echo without recompilation, status erasure,
generation/UID races, error isolation/retry, native timeout/abort and real Lease
standby/acquisition/loss. Compiled native-client/cache acceptance passes six
groups on both the host and rebuilt read-only/nonroot image, checking all 85
runtime module hashes. The loopback fixture enforces Merge Patch and optimistic
preconditions; it is not Kubernetes admission.

Both independent reviews report no confirmed scoped defect. Repair/integration
reruns the original acceptance plus four reviewer-authored race/lifecycle
controls: deletion/replacement during a blocked earlier patch, coalesced updates
and actual leader loss with a native PATCH pending. The reviewer-derived
seven-group native probe and four-group validation/coalescing probe also pass
on the host and freshly rebuilt image; all 85 runtime module hashes match.
No runtime repair was necessary, and no review setup/oracle failure was treated
as a product defect.

Source commit `1947b20a05913bed370934e92e05314e199c3002` is pushed in
[PR51](https://github.com/xenarro/krun/pull/51); its
[exact-head CI](https://github.com/xenarro/krun/actions/runs/40433248388)
passes all nine gates and 1,420 TypeScript tests plus one Python test. At source
acceptance the PR targets the recorded unmerged `feat/scheduler-run-metrics`
parent (PR50), not a claimed main merge. P4.7 tracking follows that accepted
source; protected-main review still applies.

These are component-level checks; Git delivery is recorded separately in
PLAN.md. Production scheduler assembly remains P4.11. The whole-phase
`make e2e` gate still exits 2 at its explicit P4.12 placeholder; real kind
execution remains P4.12/P4.13.

## Scheduler run metrics and request tracing (P4.6)

Leader main-loop and Job-controller writes now publish
`krun_runs_transitions_total{function,to}`, plus queue-wait, cold-start and
run-duration histograms with exactly the SPEC names and labels. D91 observes the
actual committed Store rows, not a fallible later read: stale CAS, rollback,
status-only updates and plain gateway/standby Store calls emit no lifecycle
samples. PostgreSQL and SQLite use the same observer. Durations are persisted
lifecycle differences in seconds; terminal start-time recovery supplies duration
without inventing a running transition or cold-start observation. Metrics are
process-lifetime operational signals, not an exactly-once audit across crashes.

The first `countByState` snapshot of each main-loop iteration also publishes
`krun_runs_current{function,state}`. Missing previously published pairs become
zero, including deleted Functions; closing the leader scope clears its gauges
without teardown replay. No run IDs or private values become metric labels.

D92 adds one request span at the shared native Fastify boundary for public and
internal API requests, including pre-handler failures. Valid incoming
`traceparent` supplies its parent; malformed/zero/multiple values are ignored.
The request runner carries that parent through Store work, and response or
transport closure ends the request span once. CreateRun's assigned ID annotates
the request span at completion. The existing per-run scheduler iteration child
and Kubernetes spans carry the same `krun.run_id`, but remain separate traces:
no stored trace context or Job trace environment is added. Multi-run iteration
spans do not falsely claim one run ID. Admin routes have no request span.

Local repair acceptance passes 268 focused tests, 183 scheduler tests and
`make check` with 1405 TypeScript tests plus one Python test. The real CreateRun
handler, native Job/Pod informers and Kubernetes clients run against
`test/fake-kube`, completing one Job and scraping the real admin `/metrics`:
queue wait is 2 seconds, cold start 3 seconds and run duration 5 seconds. The
in-memory exporter verifies incoming parenting, per-run correlation and separate
scheduler tracing, with no private payload in spans or metric labels. This
compiled acceptance passes on host and rebuilt read-only/nonroot image against
both SQLite and PostgreSQL, checking all 84 compiled runtime module hashes.
Additional contracts cover fractional seconds, stale/rollback/status paths,
terminal start fallback, expiry, pending interruption and gauge teardown.

Both independent reviews are consumed. Contracts finding P46-C1 is reproduced:
malformed run-path/audit values previously reached `krun.run_id`, even on a 401.
D93 validates the selected identity with the existing Zod UUIDv7 contract before
span attachment. Invalid values are omitted, never repaired or replaced by a
lower-precedence path value; valid values remain unchanged. Two permanent
regressions cover path and late audit sources, malformed/wrong-version/nil IDs,
invalid prefixes/suffixes, valid identities and exact case preservation. Native
HTTP 401 controls on both backends pass on host and rebuilt image while valid
CreateRun correlation, metric values and traceparent behavior stay intact.

Source commit `4ee85c97d9193e86fbca6b0493608a4e00526332` passed all nine
hosted CI gates in [run 40423366076](https://github.com/xenarro/krun/actions/runs/40423366076).
[PR #48](https://github.com/xenarro/krun/pull/48) was independently approved and
merged externally; the delivery job did not merge it. Only P4.6 is recorded
complete after that accepted source CI. This PLAN/README tracking update
receives its own fresh full check and exact-head hosted acceptance.

This proves reviewed-and-repaired components, not whole-phase scheduler
execution. Production scheduler assembly remains P4.11. `make e2e` still exits 2
at its explicit P4.12 placeholder;
Kubernetes admission/Job execution, kind scenarios and actual S3 are not proved
by the loopback fixture. Those gates remain P4.12/P4.13/P6.2.

## Scheduler lost-Job detection (P4.5)

`makeMainLoop` now requires the controller's real `checkLost` capability as step
6, after cancellation work and inside the existing iteration deadline. The same
check runs during the controller's initial and five-minute reconciliation. Both
processed Job/Pod LISTs gate it. It reads only the bounded
`listByState(["scheduled", "running"], KRUN_MAX_RUNNING)` selection and native
canonical-name cache lookups, never one-off Job API reads.

Each leader owns its first-absent Clock timestamps. A Job reappearing clears its
entry; a missing Job receives a full two-minute grace, including after initial
sync or a leader change. A fresh active-state read and the shared per-run handler
gate protect the terminal CAS. Cached Jobs and retained D88 terminal deletion
work stay on the normal informer path, not `job_lost`. Startup logs the initial
missing-Job count once without run input or private API data.

D90 publishes a per-run pending generation synchronously at native Job-event
ingress, before enqueueing. An unrelated slow consumer therefore cannot hide an
already received reappearance or terminal deletion from the loss check. Pending
work fences only its own run, even beyond the grace. The controller acknowledges
the exact generation only after resetting presence and retaining terminal work;
an older acknowledgement cannot clear a newer event. This handoff precedes
fallible Store/object work, so retries retain terminal ownership. The loss path
rechecks after its fresh Store read and immediately before CAS dispatch. Latest
safe acknowledgement prunes the compact entry; scope close clears it without
replay, an API reread, polling or a historical object cache.

The winning CAS records `failed` / `job_lost`, a krun fallback error and the
terminal callback while preserving accepted result and function-reported error.
Only then does loss handling delete the per-run Secret; it does not delete a Job
or request object results or logs. D89 retains a compact known cleanup target
atomically with settled CAS ownership, so interruption or a transient delete
failure retries cleanup without another terminal write or callback. Active checks
precede retry-only cleanup debt; a bounded-selection cursor and rotated debt
advance before interruptible work, preventing poisoned deletes from starving later
runs across iteration deadlines. Closing the leader scope clears its maps without
teardown work, not a historical cache or terminal-row scanner.

Local repair acceptance passes 108 focused tests, 183 scheduler tests and
`make check` with 1397 TypeScript tests plus one Python test. Twenty-eight compiled
native-client/informer and real-Store groups pass on SQLite and PostgreSQL, each
on host and in a rebuilt nonroot/read-only image with 82 matching runtime module
hashes. Ten new native groups cover both active states, preserved result/error,
reappearance (including a presence event consumed after cache eviction), actual
main-loop step 6, five-minute reconciliation, Secret retry,
known evicted terminal work and pre-sync gating. Two added native groups verify
received presence/Complete behind another run's blocked handler on both databases,
including multi-minute backlogs, safe acknowledgement and fresh grace after drain.
Both independent reviews' shared P45-C1 finding is reproduced and repaired; the
independent four-case native/SQLite race probe also passes on host and image.
Clock-driven tests also cover
startup logging, competing/late CAS settlement, fresh leader grace and the
reproduced cleanup-starvation regression, newer-generation protection, unrelated
pending-run isolation, ingress during a Store read, retained terminal work after
an acknowledged failed read, and leader-scope pending cleanup. Container CLI/gateway smoke, Helm,
workflow syntax, production audit, frozen offline install, fixable-critical scan
and stable double generation pass.

Source `b14c9488e7fbf13fb2c9084e1b1d89156d633833` is delivered in [PR #46](https://github.com/xenarro/krun/pull/46)
to main after normal reconciliation `955c08fa04b1574a5c1ae26188061f238d7a8fe2`.
Its [exact-head CI](https://github.com/xenarro/krun/actions/runs/40410837737)
passes all nine gates with 1397 TypeScript tests plus one Python test. Source
PR46 was approved and merged externally as `b20a73ba3d9ed05955db5137b9f2376e688b2c21`;
this job did not merge it. Only P4.5 closes in PLAN after accepted source CI.
PLAN/README-only tracking receives its own fresh full check and exact-head hosted
acceptance on a follow-up PR because the source PR is already merged. No automatic
merge or protection bypass. Production scheduler composition remains P4.11. `make e2e` still exits 2 at the explicit P4.12 placeholder, and kind
scenarios remain P4.13. Native loopback acceptance is not Kubernetes admission,
Job execution or whole-phase acceptance; the object-store service remains P6.2.

## Scheduler Job/Pod informers and terminal handling (P4.4)

`makeJobPodSource` supplies leader-scoped Job and Pod informer caches and Effect
Streams, restricted to the jobs namespace and the `krun.io/run-id` label selector.
D86 uses `makeInformer`'s actual native `ListWatch` cache through its public
constructor with an owned `Watch` transport: the installed factory cannot abort
an outstanding LIST/watch handshake and signals connect before processing LIST.
Both processed LISTs, including empty ones, gate the controller. Native typed
LIST calls and authenticated watch handshakes share the scheduler limiter and
ten-second budget; streaming bodies follow the leader scope. Scope closure
aborts pending calls and bodies, detaches listeners and destroys dispatchers.
Error handlers restart stopped watches with Clock-driven backoff capped at thirty
seconds; native resourceVersion and 410 relisting behavior are retained.

`makeJobController` consumes live events, reconciles the caches once after sync
and every five minutes, and serializes handlers per run. It derives `jobStatus`,
ignores `observedAt` when comparing changes, keeps image-pull failures scheduled,
and maps pod `Running` and terminal Job conditions to actual Store transitions.
D88 retains one compact outstanding terminal deletion observation per run,
including the relevant Pod status, before a queued-state gate or fallible Store
read. Replay and reconciliation include that work even when both native caches
are empty. A transient object check, cleanup failure or interrupted settlement
keeps it retryable; successful ordered cleanup or resolved cancellation/orphan
disposition prunes it. Leader-scope close forgets it without teardown replay.
No historical full-object/spec/env cache is added. Its `replayCached` capability
connects directly to the scheduling loop's post-`markScheduled` replay, including
a Complete already evicted while the run was queued. Cancelling runs continue
changed `jobStatus` updates only, never lifecycle/log/cleanup work.

Terminal handling checks the completed run's object only without an inline
result, then performs the real Store CAS with final status, failure/error/log
data and missing start time (terminated container, else Job `status.startTime`),
deletes the Secret, and deletes the Job
with explicit background propagation. The terminal transaction inserts its
callback. Already-terminal reads and terminal CAS winners receive deletes only;
404 succeeds, cleanup failures retry, and object-check errors retain the active
run and cached/retained terminal observation. D87 resolves an inline-result/object-check race atomically in
the CAS on both databases, so a concurrently accepted inline result excludes the
checked reference from the run and its callback. The object check is a required,
fallible capability, not a no-op default: the actual S3 adapter remains P6.2.

Local repair acceptance passes 87 focused tests, 160 scheduler tests, and full
`make check` with 1374 TypeScript tests plus one Python test. Sixteen compiled
native-informer/client and real-Store groups pass on SQLite and PostgreSQL, each
on host and in a rebuilt nonroot/read-only image with 82 matching runtime module
hashes. They include a native completion before the real scheduling CAS, image
pull/running events, object-check retry and inline-result precedence, terminal
replay, failed-run logs/reported errors, cleanup retry, and pending LIST/watch
cancellation. Added native groups verify evicted completions across scheduling,
object/cleanup failures, Job-only start-time fallback for Complete and Failed,
and status-only cancellation. Both reviews' three findings are reproduced and
repaired. Separate clock-driven tests cover reconnect backoff, unchanged and
five-minute retries with empty caches, Store-read failure, duplicate/orphan debt
pruning, timestamp precedence, late terminal settlement and leader-scope close. Image CLI/gateway smoke, Helm,
workflow syntax, production audit, fixable-critical scan and stable double
generation pass.

Delivered in [PR #44](https://github.com/xenarro/krun/pull/44) against main after parent PR43 merged.
Code `29d2d6d` and content-preserving reconciliation `7da86a6`
pass [exact-head hosted CI](https://github.com/xenarro/krun/actions/runs/40386333038) with all nine gates,
1374 TypeScript tests and one Python test. All three review findings are repaired
and freshly delivery-verified. Only P4.4 closes in PLAN after accepted code CI;
this tracking update receives its own full check and exact-head CI. The source PR was
merged externally as `0207e8f`; this job did not merge it.
PLAN/README tracking is delivered separately with its own PR and exact-head
checks; no auto-merge or protection bypass is used.
The `scheduler` command still exits as a finite
scaffold: production process assembly remains P4.11, lost-Job detection P4.5,
remaining leader/failure metrics P4.6/P4.8 and the S3 adapter P6.2. `make e2e`
still exits 2 with the explicit P4.12 harness placeholder; kind scenarios remain
P4.13. Native loopback receivers are not Kubernetes admission or Job execution.

## Scheduler cancellation handling (P4.3c)

Main-loop step 5 reads `cancelling` runs in bounded batches, deletes each Job
with foreground propagation, deletes its Secret, then performs the real Store
`cancelling` to `cancelled` compare-and-set. The same terminal transaction records
its timestamp, event, notification and callback delivery. Already absent Jobs
and Secrets are successful deletes; a failed/interrupted delete leaves the row
`cancelling` for an ordered retry. A losing CAS never overwrites a competing
terminal transition or creates another terminal delivery.

Cancellation does not require a Ready or existing Function. Batches are bounded
by `KRUN_MAX_RUNNING` but draining continues while the iteration budget permits,
so queued cancellations are not capped by admission capacity. A resource-specific
Job/Secret or terminal-write failure is isolated to its run. After such a failure,
bounded state-filtered keyset pages pass the retained row rather than repeatedly
reading the same oldest prefix (D85). One pending page and cursor survive iteration
deadlines within the leader term; failed rows are attempted at most once per
iteration and remain retryable in a later sweep. Clock checks
separate reads, runs, both deletes and the transition. Existing non-create 429
handling pauses without incrementing creation counters. Correlated
`scheduler.cancel_run` spans parent native delete calls; actual OTLP acceptance
checks run identity and excludes input, env, token and private Status data.

Local repair acceptance passes 17 cancellation cases, 43 focused main-loop/telemetry
tests, 118 scheduler tests overall and full `make check` with 1330 TypeScript
tests plus one Python test. Both reviews' shared starvation finding is reproduced
and repaired. Eleven compiled native-client/real-Store cancellation
scenarios pass on both SQLite and PostgreSQL, each on host and in a rebuilt
nonroot/read-only image with 80 matching runtime module hashes. They verify
present/absent resources, retry ordering, 429/deadline behavior, preserved reports,
terminal CAS/delivery atomicity, a backlog larger than the running cap and healthy
row completion despite persistent Job/Secret denial at batch size one. Separate
native HTTP503 isolation probes pass on host and image; clock-driven tests also
cover terminal Store failures, fallback429, repeated cursor-page deadlines and
late/competing CAS settlement.
Existing ten-group scheduling and two-group review-regression probes also pass
on each combination. Image CLI/gateway smoke, fixable-critical scan, Helm,
workflow syntax, frozen install and stable double generation pass.

Code `0eeaf7d` is pushed in [PR #43](https://github.com/xenarro/krun/pull/43)
to main after parent PR41 and PR40 merged. Normal ancestry reconciliation
`98dcc12` preserves the accepted feature tree; its
[exact-head CI](https://github.com/xenarro/krun/actions/runs/40362250064) passes all nine gates.
This is pushed/green, not merged; required independent main approval remains.
Only P4.3c closes in PLAN after code CI; this PLAN/README tracking receives its own
fresh full check and exact-head hosted verification. No auto-merge or protection
bypass. Job/Pod informers and terminal handling are covered by P4.4 above;
scheduler process wiring remains P4.11; the command remains the finite scaffold. `make e2e` still exits 2 at the explicit P4.12 placeholder, with
whole-phase kind scenarios pending P4.13. Native loopback tests are not Kubernetes
admission, actual Job execution or whole Phase 4 acceptance.

## Scheduler main loop (P4.3b)

`makeMainLoop` supplies the leader-local scheduling loop over the real Store,
Function cache and P4.3a native Kube service. Each iteration counts states first,
expires queued runs (including deleted/invalid Functions), reserves global and
per-Function capacity, then schedules claimed runs. Secret creation/adoption
precedes persisting the token hash; Job creation/adoption precedes
`markScheduled`. A false scheduling CAS deletes the Job with foreground
propagation and deletes its Secret. Known interrupted/failed expiry or false-CAS
cleanup is retained within the leader term for retry, without listing Jobs or
adding a terminal-row scanner.

Successful scheduling settlement atomically retains known cached-replay work
before releasing claim ownership (D83). If a deadline or handler interruption
prevents replay, the next active iteration drains it after `countByState`; only
a completed replay clears it. Handlers remain interruptible, and teardown never
starts replay. This is leader-local recovery, not another informer or API read.

Creation failures use the existing permanent/transient policy and actual Store
transitions. Secret adoption GET failures retain their non-create provenance:
they neither increment creation counters nor mutate function creation backoff;
a GET429 still releases all unfinished claims before the global pause. Unfinished claims are released before a 429 Retry-After pause;
non-create 429s pause too without incrementing create counters. One serialized
consumer uses a sliding capacity-one wake queue, state notifications and the
specified one-second ticker. Scope exit stops its producer fibers and releases
unfinished claims. The ten-second iteration budget is checked between steps and
runs and interrupts native I/O. Existing uninterruptible Store transactions are
allowed to settle: returned claims are registered before pending cancellation
can lose them, and cleanup does not detach late database writes.

A required cache-replay capability is invoked after a successful scheduling CAS,
not a no-op default or API re-read. Acceptance supplies a cache-backed handler
that observes `Complete` before scheduling and performs a real Store transition
to `succeeded`. Informer construction and the cache-backed terminal handler are
covered by P4.4 above. Cancellation is now covered by P4.3c above; lost-Job detection, remaining
leader metrics and scheduler process assembly remain P4.5/P4.6/P4.11. The finite `scheduler` command is
unchanged.

Local repair acceptance passes 25 main-loop tests plus an actual OTLP/Prometheus test,
101 scheduler tests overall, and full `make check` with 1313 TypeScript tests and
one Python test. Ten compiled native-client/real-Store groups pass on both SQLite
and PostgreSQL, each on the host and in a rebuilt nonroot/read-only image with
80 matching runtime module hashes. Checks cover adoption, capacity, classified
failures, cached completion, expiry cleanup, notification coalescing, deadline
and scope cancellation, hash ordering and telemetry privacy. Both independent
review findings are reproduced and repaired: late successful scheduling retains
replay ownership, and adoption GET429 no longer counts as a failed creation.
Additional review-derived probes verify both fixes on each backend and host/image
combination, alongside fast-replay and late-false-CAS cleanup controls. Image CLI/gateway
smoke, critical scan, Helm, frozen install and stable generators pass. Run
`pnpm exec vitest run apps/scheduler/src/main-loop.test.ts apps/scheduler/src/main-loop-telemetry.test.ts`
for the checked-in acceptance.

Code `eb0b278` is pushed in [PR #41](https://github.com/xenarro/krun/pull/41) against
its still-unmerged P4.3a parent, `feat/scheduler-kubernetes-api`/PR #40.
[Exact-code-head CI](https://github.com/xenarro/krun/actions/runs/40343964037)
passes all nine gates. This is pushed/green, not independently approved or merged.
Only P4.3b is checked in PLAN after accepted code CI; this tracking update gets
its own fresh full check and exact-head hosted verification. Native loopback
fixtures do not establish Kubernetes admission or the whole Phase 4 gate:
`make e2e` still exits 2 with the P4.12 harness placeholder; kind scenarios remain
P4.13.

## Scheduler Kubernetes API plumbing (P4.3a)

`KubeLive` supplies real native Job/Secret create, Secret read, Job/Secret delete
and bounded pod-log methods over the existing scheduler-wide `KubeConnection`.
Its configured semaphore and ten-second total call budget are shared with Lease
calls. Permit wait consumes that budget; an expired queued call never dispatches
native I/O, including when a permit is released on the deadline tick (D81).
Per-call middleware forwards interruption to the native AbortSignal and destroys
the request dispatcher. Named spans cover permit wait and requests, with only
namespace, object/function identity, run correlation, HTTP status and error tag.
Deletes treat 404 as success; Job deletion always specifies propagation, and
pod-log requests use the manifest's `function` container, 100 lines and 16384 bytes.

A leader-local creation policy projects permanent API failures to
`job_create_failed` with the documented krun-sourced Status message and
`details.code`/`details.reason`. Quota 403, 429, 5xx, network and timeout failures
are transient; per-function backoff doubles from one second to a 60-second cap
and resets on success. Create `409/AlreadyExists` is left for adoption. The
explicit failed-create policy boundary counts the two required error/quota
metrics; API methods do not retry or count unrelated reads. A separate
interruptible 429 pause honours Retry-After (default one second, capped at 60),
including all three HTTP-date forms in UTC and the RFC850 fifty-year rule (D81).
The later loop can release claimed leases before waiting without holding an API
permit.

Installed client-node error bodies can be JSON text rather than objects. The
adapter validates both (D80). It keeps only the required persistence Status data
and Retry-After in a private WeakMap keyed by sanitized typed errors (D79), not
in serializable errors, logs or spans. Actual Prometheus and OTLP collector tests
check exact counters/labels, correlation and absence of private Status/manifest
canaries from telemetry.

Local repair acceptance passes 75 scheduler tests and 21 shared Kubernetes tests;
full `make check` passes 1287 TypeScript tests and one Python test. Five compiled
native API groups and six adversarial groups pass both on host and in a rebuilt
nonroot/read-only image with 79 matching runtime module hashes. Additional real
wall-clock saturation probes for both Kube and Lease finish all nine calls in
one ten-second budget, with only eight requests reaching the receiver. The
adversarial checks include native HTTP-date headers, cancellation, backoff and
permit recovery. Four existing Lease lifecycle process cases also pass on each,
preserving SIGTERM and loss behavior. Image CLI/gateway smoke, critical scan,
Helm, frozen install and stable generators pass.

Both material review findings are reproduced and repaired, with permanent
regressions. Code `159efaa` is pushed in [PR #40](https://github.com/xenarro/krun/pull/40)
to main after both prior parent PRs merged. Normal ancestry reconciliation
`cbe00e1` preserves the accepted source tree, and its
[exact-head CI](https://github.com/xenarro/krun/actions/runs/40323798272) passes all nine gates.
This is pushed/green, not independently approved or merged; PLAN/README tracking
receives its own full precommit check and exact-head hosted verification. The finite
`scheduler` command remains unchanged. Store transitions and main-loop lease
release/pause ordering are now covered by the P4.3b component above; process
composition remains later work. These policy and native-client checks do not
establish Kubernetes admission or complete
Phase 4 kind/e2e acceptance (`make e2e` remains pending P4.12).

## Scheduler leader election (P4.2)

`runLeaderElection` owns one Lease term and a separate scope for leader-only
resource acquisition. It uses `krun-scheduler`, the caller's pod name, a
15-second lease, two-second retries and an independent ten-second renewal
watchdog. Every write follows a read and carries its resourceVersion. Candidates
judge expiry from local observation, not remote timestamp age; even same-name
restarts wait out an observed held lease. Renewals continue during stalled
resource initialization. Known holder loss or a missed renewal deadline stops
work and fails the election rather than silently becoming a standby again.

The native `LeaseApiLive` uses the existing bounded Kubernetes connection,
per-request AbortSignal middleware and dispatcher cleanup. Its validated read
view preserves client-node's wire MicroTime strings, including microsecond-only
changes (D78). Leader readiness state and the real `krun_scheduler_leader` gauge
change together. Leader resources and requests stop before one bounded,
owner-checked read/replace clears the holder on shutdown.

Local acceptance passes 41 scheduler tests, including clock-driven election and
real native-client loopback tests. Full `make check` passes 1249 TypeScript tests
and one Python test. Four actual NodeRuntime process cases run both on the host
and in a freshly rebuilt nonroot/read-only image with 76 matching module hashes:
SIGTERM releases and exits zero; holder loss, repeated renewal failure and a
stalled native renewal exit one; pending transport abort and real Prometheus
leader gauge values one/zero are checked. The probes use the repository's
explicit interrupt-only teardown policy; the installed runner default returns
130 on interruption. Existing image CLI/gateway lifecycle checks and the
fixable-critical scan also pass.

Both independent reviews found no confirmed material defect; repair/integration
retains the reviewed runtime unchanged. Code commit `5fb7e60` is pushed
in [PR #39](https://github.com/xenarro/krun/pull/39) against its still-open P4.1 tracking parent,
`feat/scheduler-job-builders` (PR #38). [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40309685305)
passes all nine gates. This is pushed/green, not merged; PLAN/README tracking
receives its own full precommit check and exact-head hosted verification.
The `scheduler` command is still the finite scaffold: later process wiring must supply pod
metadata.name and join this election effect using that teardown policy. Actual
Job/Pod informers, loops and the status writer are later components; tests verify
that their resource-acquisition program is leader-scoped, not that those
components already exist. No real-cluster admission, two-scheduler kind takeover
(P7.6) or complete Phase 4 e2e gate is claimed; `make e2e` remains pending P4.12.

## Scheduler manifests (P4.1)

`apps/scheduler/src/k8s/manifests.ts` builds typed Kubernetes Job and immutable
Secret resources as pure functions. They reproduce SPEC section 7: deterministic
names and four labels, no owner references, exact env order and Secret token
reference, service account without token automount, both eviction tolerations,
UID/GID and restricted security contexts, `/tmp` emptyDir, deadlines and TTL.
`hostUsers` is omitted by default and emitted only as `false` when configured.
Resources, selectors, pull secrets and envFrom are copied without mutable aliases;
unset fields stay absent. A caller may supply an already-presigned upload URL;
the builder itself performs no signing, credential generation or Kubernetes I/O.

Golden-file acceptance compares the Job and redacted Secret through the actual
client-node serializer. Eighteen builder checks cover defaults, optional fields,
identity/token diagnostics, zero result caps, duration-to-seconds conversion and
snapshot isolation; the scheduler suite passes 19 tests. Full `make check` passes
1227 TypeScript tests and one Python test. A freshly rebuilt nonroot/read-only,
network-isolated image passes seven compiled-builder/identity groups with 74 emitted
module hashes, seven CLI groups and the fixable-critical scan.

Both independent reviews found no confirmed material defect. The code is pushed
and [exact-head hosted CI](https://github.com/xenarro/krun/actions/runs/40295121160)
passes in [PR #37](https://github.com/xenarro/krun/pull/37), now based on main
after the prior stack merged and normal ancestry reconciliation preserved the
reviewed source. P4.1 code is approved and merged via PR #37; its PLAN/README
tracking updates require their own exact-head hosted verification. The
`scheduler` command is still the finite scaffold.
Leader election, API orchestration, actual Job execution and the Phase 4 kind e2e
gate remain later PLAN tasks; no cluster admission or running-function claim.

## Internal API (P3.8)

The internal listener now serves `GetInput`, `ReportStatus`, `SetResult` and
`SetError` under `/internal/v1`, using the actual shared Store. Authentication
hashes the per-run token and compares in constant time; only queued runs with a
token, scheduled runs and running runs accept calls. Public API keys do not work
here. Route/version errors precede authentication, followed by media type, body
cap, strict validation, accepted-status rate limit and state-guarded persistence.

Input is re-serialized JSON with `Content-Length`. Status replaces the whole
report, stores gateway time as `at` and renders public `reportTime`; only a
successful report starts the replica-local one-second window. Result and error
writes replace earlier reports without changing lifecycle state. Native
Content-Length/chunked caps and compact-JSON UTF-8 field limits are enforced;
errors use the canonical envelope and log User-Agent without credentials/bodies.
This includes a configured zero-byte result cap under both framings and recursive
finite-JSON validation before Store work. At the end of the configured drain,
unfinished internal body transports are closed while validated writes settle;
responses finishing during close do not leave keep-alive sockets behind.

Internal Store calls have a five-second Effect deadline, including status-lock
and database-pool acquisition. PostgreSQL calls use per-call driver and server
timeouts, active-query cancellation and settled rollback/release, rather than
abandoning a write that could later commit. Forward-only migration
`0004_opaque_reports` preserves the full opaque JSON Unicode domain in reports
and callback/event payloads; an additive heartbeat timestamp projection avoids
SQL decoding unrelated opaque fields. A database trigger invalidates it for
legacy status-only writers; current writers republish it in the same transaction.
The legacy fallback decodes authoritative report time without narrowing Unicode.
Existing migrations and wire fields stay unchanged. Apply migrations before starting the gateway.

Local `make check` passes 1209 TypeScript tests and one Python test; the standalone
gateway phase gate passes 297 tests, including real SQLite and PostgreSQL routes
and the existing POST-then-GET acceptance. Dedicated checks cover every internal
error-table row, 10 Hz status reports, concurrent/failed reports, byte boundaries,
unknown versions, token isolation, real locked-write cancellation, exhausted-pool
recovery, opaque Unicode and forward-migration rollback. Double generation is
byte-identical; `docs/api/openapi-internal.json` lists all four operations with
open string response statuses and no nullable schema.

The rebuilt `krun-test-p38-repair:local` image passes twelve hardened real-process
lifecycle groups, including all four internal methods, API-key rejection,
public readback, status rate limit, result cap and continued internal service
after readiness turns unavailable. Two exact Docker process-state exit checks
finish the configured two-second drain in 2051 ms and 2049 ms with exit 0;
Docker CLI/cleanup elapsed time is recorded separately. The image matches 73
current emitted-module hashes across all five workspaces and passes seven CLI groups and the
fixable-critical scan. Helm, workflow syntax and production dependency audit pass.

All four independent P3.8 findings have been reproduced and repaired locally,
including mixed-writer heartbeat freshness, nested JSON validation, zero result
caps and unfinished-body shutdown. Source commit `d4d759df93dafba34717610b37dbc76b328e7e0f` is
pushed and code-head green in [PR #35](https://github.com/xenarro/krun/pull/35), stacked against
`feat/gateway-process-wiring` (PR #34). [Exact code CI](https://github.com/xenarro/krun/actions/runs/40285156613)
passes all nine gates with 1209 TypeScript tests and one Python test, including
current-source image build/lifecycle checks. Only P3.8 is marked complete after
that acceptance; the documentation tracking commit has its own full-check and
exact-head CI requirement. The Phase 3 gateway gate passes. This stack is not
merged or auto-merged; protected-main independent review is not bypassed.
Scheduler execution, full platform e2e and concrete object storage remain later work.

## Gateway process (P3.7)

`krun gateway` composes the existing parsed configuration, pino-backed Effect
logging, telemetry, SQLite/PostgreSQL Store, Kubernetes Function LIST/WATCH
cache, keys and separate public/internal/admin listeners as scoped layers under
`NodeRuntime.runMain`. Initial LIST blocks readiness, not liveness or listener
startup. Public methods implemented through P3.6 are mounted on the public
listener only; P3.8 now mounts the four token-scoped internal methods on the
separate internal listener. Concrete object-store integration remains P6.1.

SIGTERM/SIGINT mark readiness unavailable, keep normal public requests serving
for the configured shutdown delay, finish existing CreateRun waits with their
current stored Run and 201, then close transports and dependencies. Pure
interruption exits 0; startup/finalization failures exit 1. A scoped 25-second
watchdog bounds pathological cleanup. No custom signal handlers or automatic
serving-replica migrations are introduced.

The repaired local full `make check` passes 1161 TypeScript tests and one Python
test; the exact standalone gateway phase gate passes all 252 gateway tests.
Twelve dedicated entrypoint/process/ownership
acceptance tests cover real SQLite and PostgreSQL processes, initial LIST/WATCH,
listener isolation, two-second grace and exit 0 within five seconds, pending-LIST
interruption, partial-startup failure, SIGINT, credential privacy and PostgreSQL
pool/LISTEN connection cleanup. An initial in-flight wait returning 500 was reproduced and
fixed through a scoped shutdown signal and native response finish/close tracking.

The newly rebuilt `krun-test-p3-7-repair:local` image passes all ten real-process
lifecycle groups as uid/gid 65532 with a read-only root filesystem, all capabilities
dropped and no-new-privileges. Its two-second drain completed in 2158 ms with exit 0,
normal public requests still served after readiness turned 503, the in-flight
wait settled 201, and the actual Function WATCH socket closed. The same image
matches 69 emitted-module hashes and passes all seven CLI groups. Double
generation is byte-identical; OpenAPI, Helm, production dependency audit,
workflow syntax and fixable-critical image scan pass. The real hardened-image
smoke is also part of the CI command verification step, not a finite gateway
scaffold assertion.

Both independent P3.7 review findings were reproduced and repaired. Response
ownership now starts before admission/semaphore/Store work, including replays
and non-waiting creates. After the configured grace, registration is sealed
synchronously before the response snapshot, so new admission receives existing
`NOT_READY` before mutation while already-owned responses settle. A real
PostgreSQL event insert held across drain now commits and returns 201/current
Run instead of 500; the rebuilt hardened image reproduces that corrected race
with exit 0 in 2423 ms. A permanent post-seal native regression verifies no extra
Run is inserted. Normal grace serving and real disconnect cancellation remain.
The internal constructor now shares the existing sanitized framework-error
mapper; malformed percent/UTF-8 native paths use the canonical `REQUEST_INVALID`
envelope, without reflected paths. Permanent source and rebuilt-image controls
cover both cases. D73 records these ownership and transport-boundary repairs.
Original review findings and failed receipts remain immutable; repair-owner
verification is not an independent approval or hosted delivery claim.

Source commit `e0dd5713dc14aaa49ba810de658ad0e985af6dce` is pushed in
[PR #34](https://github.com/xenarro/krun/pull/34) against the immediate still-unmerged
`feat/gateway-run-results` / PR33 parent. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40270654763)
passes all nine gates on attempt 1, including 1158 TypeScript tests and
one Python test. PLAN records only P3.7 after that code acceptance; its tracking
update receives a separate full precommit check and exact-head hosted CI.
Tracking CI exposed an inherited aggregate CLI test timeout twice. The four
existing installation-ceiling subprocess cases now run as separate parameterized
tests, each with the unchanged default five-second limit and identical exit-code
and diagnostic assertions. No application behavior, timeout value or worker
setting changes. This increases the full test total by three; the accepted
original code-head count above remains its historical 1158.
The PR remains open, not merged; required protected-main review is not bypassed
and an empty review decision is not approval. The P3.8 local implementation above
awaits independent review; remaining scheduler/object-store/application gates are
future work.
Tests use explicitly owned loopback fake Kubernetes and disposable databases,
never a production cluster or ambient user context.

## Run admission (P3.3)

`apps/gateway/src/create-run-routes.ts` implements real `CreateRun` as a scoped
plugin under `makePublicApp`, using the existing Store, validated Function cache,
current Keys principal and caller-owned parsed limits/webhook policy. Acquire
`createRunRoutes(parsedGatewayConfig)` in the owning Effect scope with the real
`DnsLookup` service, then register the returned plugin through the factory.
No listener or serving command is started by this reusable slice.

Authentication and method scope precede per-key Clock-driven rate admission,
Ready/current-glob Function resolution and native byte-limited parsing. Both
Content-Length and chunked bytes are bounded before JSON parsing, including a
configured zero cap. Strict owned schemas reject unknown/null members while
opaque input retains own JSON keys without assigning prototypes. Compiled input
validation reports canonical `BadRequest.fieldViolations`; priority scope and
real callback host/all-address policy precede queued-cap checks and insertion.
The current positive-priority grant is enforced before fingerprint and private
Store request-id lookup (D63), including replay after revocation. The lookup
returns the current FULL row before schema, callback and quota checks; JCS fingerprints exclude
output-only fields, `requestId` and `wait`, and precede default callback copying.
Replay/conflict responses preserve the documented 201/409 semantics, Location,
Idempotent-Replay and Retry-After headers.

New runs use the owning Clock for UUIDv7 and creation time, and the actual Store
transaction persists the queued row and actor event. Per-Function same-replica
admission serialization excludes response waits; database uniqueness remains
cross-replica dedupe authority. Optional capped waits register scoped queues before
insertion, consume one shared Store hint stream per plugin, re-read actual rows
and retain the specified one-second fallback. Client disconnects release waiting
work without cancelling a persisted Run. Admission counters expose only the four
bounded reason labels in the owning telemetry registry, not a fresh global one.

D60 records composition/admission choices. Native HTTP acceptance exposed and
repaired D61: Fastify's request signal also aborts on a normally consumed POST
body, so shared cancellation now checks real incomplete/destroyed transport state
while retaining genuine disconnect and app-close interruption. D62 records the
isolated-registry regression and context-preserving native error-hook metric fix.
D63 repairs the independently reproduced priority-replay exemption without
weakening current grants. D64 preserves valid Unicode NUL input values/keys and
opaque request IDs on both databases: a forward Postgres migration changes input
to native `json` and adds a nullable binary slot/index for the disjoint NUL-ID
domain. An exact UTF-16LE storage adapter and infrastructure decoder preserve
identifiers without normalization or aliasing printable escapes. Existing text
IDs/index, shipped migration, domain DTOs, fingerprint and ordinary legacy SQL
writers/readers remain intact; no new public restriction or blanket database
error remapping is introduced.

Repaired local acceptance passes 42 dedicated CreateRun tests, two UUID/Clock
checks and eight real-database Unicode/migration/rollback controls. Complete
`make check` passes 1062 TypeScript tests (including all 159 gateway tests)
and one Python test. The phase gate includes actual
CreateRun POST, replay/conflict and an explicitly test-owned durable readback GET
against PostgreSQL18; it does not implement the future public GetRun handler.
Full checks use the recorded owned two-CPU verifier with unchanged test defaults,
assertions and deadlines, real file-backed SQLite fixtures on task-owned tmpfs,
and actual PostgreSQL Testcontainers. Earlier unrestricted-host Store timeouts
remain retained, not claimed repaired. A first repair full run also hit the
unchanged five-second leasing planner deadline; its isolated control and the
final complete gate pass without changing assertions, workers or deadlines.
The separately rebuilt `krun-test-p3-3-repair:local` image passes actual native
SQLite/Postgres create/replay, NUL-data and current-priority controls, credential
and resource-lifecycle controls, and 63 emitted-module hashes as uid/gid65532.
The preserved implementation image also successfully reads/writes NUL input and
replays ordinary text IDs against the upgraded Postgres schema. Both images run
read-only; the PostgreSQL probe uses only its owned disposable database.
Fresh repair-image reruns also pass all 15 admission/disconnect/isolated-registry
metric groups and seven CLI groups. The exact standalone 159-test gateway gate,
double generation/drift, Helm, frozen install, production audit, workflow lint
and fixable-critical image scan pass. Original failed attempts and reviewer
reports remain preserved; owner reruns are not a new independent approval.

At the repair checkpoint this source was uncommitted and P3.3 was unchecked.
Runtime commit `0961769ff6b0f7607e23d6f5e6c2b62fa30c1315` was subsequently pushed and
normally reconciled with verified main as `326a3966e560b1d602a54e7796371e2fec30a593`.
[Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40237884278)
passes all nine hosted gates on attempt2; the original unchanged CLI aggregate
five-second deadline failure and isolated control are retained without weakened
assertions, deadlines or workers. [PR #29](https://github.com/xenarro/krun/pull/29)
is independently approved and merged as `68f2e7cd35cda44eba3f35cba12c613beecf663a`;
this delivery job did not merge it or bypass protection. Only after accepted code
CI is P3.3 checked in PLAN. This documentation-only follow-up reconciles merged
main normally and receives its own pre-commit and exact-head hosted checks.
Public Run reads, remaining methods, listener/process wiring, graceful drain and
complete application/Kubernetes end-to-end acceptance remain later PLAN tasks.

## HTTP observability (P3.1b)

The public factory and reusable admin app now echo bounded X-Request-Id values,
replacing missing,empty,duplicate,oversized or illegal wire values with UUIDv7
using the owning Effect Clock. Public /v1 completion audits record key names
(null on401),reqId,trusted-proxy client IP,User-Agent and approved run/function/
idempotency correlation. Authentication failures use warn; normal audits use info.
Native router failures are covered too,without duplicate request logs.

Shared native pino options remove sensitive structured payload/credential fields
and do not serialize raw URLs,headers,bodies or exceptions. Request Effect logs
use the same redacted pino child,KRUN_LOG_LEVEL and active span IDs. Both existing
app factories record the exact krun_http_requests_total{route,code} and
krun_http_request_seconds{route} metrics through the owning real Prometheus
exporter; every404 uses unmatched rather than a raw path. A scoped LogDestination
reference supports owned process/test sinks without a global logger singleton.

Current repaired verification: 73 gateway tests; full `ionice -c 2 -n 0 make check`
passes 946 TypeScript tests and one Python test. Rebuilt
`krun-test-p3-1b-repair:local` passes 101 integration groups (80 inherited, eight gateway,
six observability, seven CLI), checks 56 emitted-module hashes and runs as 65532:65532.
Independent review exposed two extraction defects, now reproduced and repaired:
native origin/HTTP/HTTPS absolute targets all receive exactly one public audit;
idempotency fallback comes only from the bounded query `requestId`, never a Run
body member. Registered templates and unmodified target path boundaries preserve
unknown/bootstrap auditing without logging raw targets or normalizing dot segments.
Permanent regressions and both reviewers' native controls cover auth failures,
query/body conflicts, handler-owned metadata and real exported-span privacy.
Repair evidence and finding dispositions are in
`.agent-state/krun/reports/repair-p3-1b.json`.
Native routing/credential regressions,generation,Helm,audit,frozen supply-chain
installation,actionlint and the fixable-critical image scan also pass. Failed
acceptance/build/format/tool-discovery attempts are retained and dispositioned in
`.agent-state/krun/reports/implement-p3-1b.json`.

Code `6d3e2b347204f2dddd2341ac2a8e07e651d3a011` is pushed in [PR #25](https://github.com/xenarro/krun/pull/25) against
`main`, after content-preserving ancestry reconciliation with the merged prior stack.
Its [exact-head hosted CI](https://github.com/xenarro/krun/actions/runs/40199214351)
passes all nine gates, including 946 TypeScript tests and one Python test.
P3.1b is checked only after that accepted code CI; the tracking update receives
its own precommit check and exact-head hosted CI. The PR remains open with
required independent repository review, not merged or automatically merged.
One earlier delivery check hit ten unchanged Postgres startup-hook timeouts;
Docker/pinned-image health, an isolated original fixture and a fresh unchanged
full check then pass without weakened assertions, budgets or worker settings.
No public-method or full-platform completion is claimed. The prior P3.1a PR is
now merged; older section counts/delivery notes below describe earlier acceptance.
Process/listener startup,HTTP request-span wiring,OpenAPI,concrete API methods and
the full Phase3/Kubernetes end-to-end gate remain later tasks.

## Public gateway foundation (P3.1a)

`apps/gateway/src/app.ts` now provides a real scoped `makePublicApp` factory.
It builds and readies Fastify without opening a listener. Supply the existing
Store, Function-cache and Keys services once through Effect, and register
method plugins with the factory's `routes` option. Their encapsulated Fastify
scope inherits `store`, `functions`, `keys` and the cancellation-aware
`runEffect` decorator; these are not global root-instance decorators. Each
route must explicitly declare its required scope and optional function-name
parameter. No API-method placeholders or public health endpoints are installed.

Authentication runs before body parsing, performs a fresh lookup against the
real scoped key loader on every request, enforces method scopes and function
globs, and rejects duplicate Authorization fields before Node's normalized
first value can authenticate. Hidden and missing Functions share the same
404 envelope. Zod 4 compilers enforce strict own request objects and unknown
query rejection, with nested krun-owned objects authored as strict schemas;
the factory does not rewrite nested opaque-data schemas. Malformed/empty JSON and
invalid/null owned fields become 400, and non-JSON content types become 415.
One mapper emits the API's canonical AIP-193 status/reason pairs and hides
native parser, validation, serialization and Effect-defect diagnostics.

Run `pnpm exec vitest run apps/gateway` for 59 current tests, including all
20 public error mappings, actual SQLite/Postgres18 Store access through
explicitly test-owned HTTP POST/GET routes, real socket disconnects,
close/finalizer ordering, key reload and captured TestClock behavior. The
current full `ionice -c 2 -n 0 make check` passes 920 TypeScript tests and one
Python test, including the final body-less-method guard. Methods without a
declared body schema accept omission or an empty object, but reject explicit
JSON null and unknown members before Fastify can normalize absence to null.
The rebuilt non-root image passes eight native gateway groups and verifies
53 current emitted-module hashes, alongside 80 inherited integration groups
and seven offline CLI groups. These test routes are fixtures, not implemented public CreateRun/GetRun
methods or full Phase 3 completion. Concrete API methods, rate limits,
OpenAPI generation, process/listener startup and graceful draining remain
later tasks. The `gateway` process command still prints its name and exits.
Code `b24b2062108f36ccbd60377a12e4db154ce6b9a4` is pushed in [PR #23](https://github.com/xenarro/krun/pull/23)
against the open `feat/function-validate-cli` parent. Its [exact-head hosted CI](https://github.com/xenarro/krun/actions/runs/40188371354)
passes all nine required gates, including the same 920 TypeScript tests and one
Python test. Only P3.1a is checked after that code CI; the PR remains unmerged,
with no auto-merge or implied formal repository approval.

Verification retains the failed attempts rather than claiming every run was
green. During the preceding implementation, eight existing Store tests exceeded
their unchanged five-second budgets
during measured heavy host I/O pressure; all 116 affected-file controls and a
fresh unrestricted full gate pass without changing product code, test budgets,
assertions, workers or scheduling. Supplemental inherited image runs also hit
a 30-second Docker-client lifecycle wait at different stages, including a
finite command that had printed its complete output and exited zero. An owned
wrapper copy permits 120 seconds only for Docker startup/auto-removal, retaining
all in-container assertions/deadlines, expected exits, real disk-backed
backends and container-removal checks; all 80 groups pass. A tmpfs experiment
failed before reaching Postgres and was not adopted. This is test-infrastructure
recovery, not a universal filesystem-latency or product timing repair.

## Check the current implementation

P3.1a independent-review repair (D53) now canonicalizes native router URL/parameter
failures and makes supported wrapped request roots strict. Optional, ExactOptional,
Default, Prefault, Readonly and NonOptional retain their wrapper semantics;
unsupported root forms fail registration. Omitted declared bodies remain distinct
from explicit null, and nested opaque user schemas are not rewritten.
The current exact gateway acceptance and phase commands each pass 59 tests. The
rebuilt `krun-test-p3-1a-repair:local` image passes the router/wrapped-root/cleanup
regressions, its 53-artifact gateway check and the complete real-disk inherited
Store corpus: 80 inherited groups, eight gateway groups and seven CLI groups.
Current full verification passes all 920 TypeScript tests and one Python test
using per-command I/O priority (`ionice -c 2 -n 0 make check`), with no CPU-affinity
or worker restriction on that successful run. Earlier unchanged Store setup and
five-second test timeouts remain retained; bounded-CPU and earlier I/O-priority
attempts were not all successful. No existing test deadlines, assertions, Store
code or test configuration were changed. All three independent-review findings
(two root defects) have explicit red/green dispositions in
`.agent-state/krun/reports/repair-p3-1a.json`. Delivery verifies the actual pushed
code and subsequent tracking heads separately; local repair acceptance alone is
not treated as hosted CI or a merged-main claim.

Prerequisites: Node.js matching `.node-version`, pnpm matching `package.json`, [uv](https://docs.astral.sh/uv/), Docker, Helm 4, actionlint and OpenSSL CLI (only for ephemeral local TLS test certificates).

```sh
pnpm install --frozen-lockfile
uv sync --directory sdk/python --frozen
make check
make helm-lint
actionlint
make docker
```

Run resource-free help from source build output or the container:

```sh
make build
node bin/krun.js gateway --help
docker run --rm --read-only --network none krun:local scheduler --help
```

Both examples print usage and exit 0. Without `--help`, gateway and scheduler require configuration and remain serving until shutdown. `validate` instead requires manifest paths (or `--help`) and performs real offline validation; `migrate` requires database settings and performs real migrations. The kind/e2e Make targets fail explicitly until their planned harness is implemented; the Helm chart is currently a minimal lintable skeleton.

Tests include configuration defaults and boundaries, process-specific validation, namespace resolution, typed/redacted failures, Effect layers, command dispatch and build/CI contracts. `make check` also runs Python lint/type checks and Knip.

P0.8 provides the strict composite Function spec, resource/status schemas and separate raw-input/parsed-output TypeScript types in `packages/shared/src/functions/schema.ts`. Minimal create input requires image and an explicit object `inputSchema`; documented defaults are applied without inventing readiness. Queue/heartbeat duration floors, leading-zero equivalence and safe-integer overflow agree across Zod, editor JSON Schema and the structural CRD. SPEC D40 records the delegated contract decisions; D41 limits the independent JSON Schema conformance evaluator to development tests. Review repairs in D42 make callback URI validation byte-preserving and consistent across Zod/editor/CRD, and preserve opaque own JSON keys such as `__proto__` without rebuilding dictionaries or mutating prototypes. Wire URI syntax does not replace the later runtime webhook allowlists.

`make generate` runs the native Node TypeScript generator and reproducibly writes `deploy/crds/functions.krun.io.yaml`, the conditional Helm CRD template and `docs/schemas/function-v1alpha1.json`. Runtime consumers import the source module, not these files. Tests cover isolated drift repair, actual Helm install/keep combinations and preservation of arbitrary user-schema keywords. A disposable Kubernetes 1.33.7 test cluster verified CRD establishment, native defaults/pruning, opaque `inputSchema`, duration bounds and status behavior; no production cluster was used. Independent reviews identified callback URI parity and opaque-key preservation defects; both were repaired and the reviewer-authored regression assertions pass at delivery. [P0.8 code CI](https://github.com/xenarro/krun/actions/runs/40067784483) passed exact code head `263c22b60108d5b022767cefd8eb30fa36c10719` in [stacked PR #4](https://github.com/xenarro/krun/pull/4), including 199 TypeScript tests and one Python test, generated-clean checks, the rebuilt container, Helm, audit and scanning. The PR targets the still-unmerged `feat/admin-health-telemetry` parent; no stack layer was auto-merged. Phase 0 remains incomplete. CLI validation, informer/runtime policy and actual serving processes remain later PLAN work.

P1.1 adds the normalized Store model, plain Kysely-compatible Postgres/SQLite table interfaces, canonical `toRun`/`toRunSummary` mappers, tagged errors and all 23 Effect Store method contracts in `packages/shared/src/store`. BASIC is whitelisted directly without reading FULL-only columns or error details; opaque JSON keys and falsy results are preserved. Both independent reviews found no material defects. Task/root no-emit checks, 33 focused tests and `make check` (232 TypeScript tests and one Python test) pass. [P1.1 code CI](https://github.com/xenarro/krun/actions/runs/40072000762) verified exact code commit `82d3a69239e728e0954dedf27ea7add2cee021e7` in [stacked PR #6](https://github.com/xenarro/krun/pull/6), including current-source container build/smoke, generated-clean, Helm, audit and scanning. The PR targets the still-unmerged `build/release-preconditions` parent; no layer was auto-merged. That delivery covers model/interface/mapper contracts, not Store methods. P1.2's migrations are described below; real SQLite/Postgres Store behavior and the full Phase 1 dual-backend gate remain pending. P0.9 publishing preconditions remain independently unresolved.

P1.2 implements `krun migrate` with Kysely `Migrator`/`FileMigrationProvider` and forward-only raw SQL files for both dialects. It reads only `KRUN_DB_MODE`, `KRUN_DB_DSN` and `KRUN_DB_PATH`: Postgres is the default and requires the database setting; embedded mode defaults to `/data/krun.db`. Scoped production layers own the Postgres pool (five connections, ten-second query bound) or built-in SQLite connection. Unknown recorded migrations with nothing pending warn and exit 0 without changing history; unknown plus pending exits 1 before application DDL. Driver failures retain no raw connection data. Real CLI tests against temp-file SQLite and digest-pinned Postgres 18 via Testcontainers cover migration twice, both history branches, transactional rollback, unrelated-schema bookkeeping, config isolation and scoped release. SPEC D43 records the SQLite transactional-DDL correction; D44 records explicit denial of unused transitive install scripts. Both independent reviews and repair found no material defects. `make check` passes 263 TypeScript tests and one Python test; the Store suite passes 61 checks. [P1.2 code CI](https://github.com/xenarro/krun/actions/runs/40097891636) verified exact code commit `d862527a4dcf6c66f3400dae3850925b42af1485` in [stacked PR #7](https://github.com/xenarro/krun/pull/7), including frozen dependencies, generated-clean checks, rebuilt non-root image with actual embedded migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-contract` parent; no layer was merged or auto-merged. The full P1.3-P1.11 Store contract gate and P1.9 remain separate, incomplete work.

P1.3 now implements the declared `createRun` method as a Database-backed factory, without fake implementations of later Store methods (SPEC D45). It uses the existing composite partial index and one transaction for the queued run, actor event and Postgres notification. A shared `canonicalize`/SHA-256 helper hashes the API 3.3 projection with absent priority as 0 and absent callback as null, before Function callback fallback; requestId and wait are excluded. The existing NewRun contract supplies ids, timestamps and hashes. Shared tests against temp-file SQLite and Postgres 18 exercise 20 concurrent duplicates, including mixed omitted/explicit-zero priority retries, nested key-order equivalence, changed-payload conflicts, owner/function scoping, null/empty keys, rollback, current-row decoding, opaque JSON keys and committed notifications. Both independent reviews reproduced the fingerprint-default mismatch; the repair now verifies normalized golden bytes and equivalent replay on both backends. Store suite 87 and `make check` (289 TypeScript tests and one Python test) pass. [P1.3 code CI](https://github.com/xenarro/krun/actions/runs/40102991839) verifies exact code commit `8a189d466286bb5721c916b7db5011cc70963509` in [stacked PR #8](https://github.com/xenarro/krun/pull/8), including frozen dependencies, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-migrations` parent; no layer was merged or auto-merged. Full Store-layer assembly, later Store methods and the complete Phase 1 gate remain pending.

P1.4 implements all eight leasing/scheduling/query methods as a typed Database-backed method group under D45: `claimQueued`, `releaseLease`, `setJobToken`, `markScheduled`, `countByState`, `countQueued`, `countQueuedBy` and `listByState`. Claims change only the lease and attempt, ordered by priority/creation time, with Postgres `FOR UPDATE SKIP LOCKED` or SQLite `BEGIN IMMEDIATE`; expiry uses the Effect clock and strict `< now`. Scheduling is one queued-state CAS/transaction for clearing the lease, setting the shared event timestamp and publishing the committed notification. Active counts/listing reuse one literal partial-index predicate; actual Postgres `EXPLAIN` names `runs_active_idx` after 5000 terminal and 50 active fixtures. The 29 new real temp-file SQLite/Postgres 18 checks cover disjoint claimers, strict clock expiry, token idempotency, stale/cancelled scheduling, rollback (including deferred-commit notification rollback), scoped counts/listing, malformed-row failures and redacted spans. `make check` passes 318 TypeScript tests and one Python test; the Store suite passes 116 checks. A rebuilt non-root image exercises the eight compiled methods on both dialects plus earlier creation/migration integration. Both independent reviews and no-defect repair verified unchanged accepted source. [P1.4 code CI](https://github.com/xenarro/krun/actions/runs/40106782768) verifies exact code commit `cda51a97494f71cc00748e10fbe5fbf6d302a830` in [stacked PR #9](https://github.com/xenarro/krun/pull/9), including frozen dependencies, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-create-run` parent; no layer was merged or auto-merged. Full Store-layer assembly, later methods and complete Phase 1 acceptance remain separate and incomplete.

P1.5 implements the declared `transition` method as a Database-backed factory under D45. One compare-and-set transaction updates the run, shares the Effect-clock timestamp with its state event, preserves an accepted error with SQL `coalesce`, and inserts a pending callback delivery for each terminal target when a callback is set. Delivery payloads use the canonical `toRunSummary` of the updated row, excluding input, result, log tail and error details; UUIDv7 delivery ids use the same clock. Postgres notifications execute inside that transaction. Stale transitions return false without dependent writes; event, delivery, decoding and deferred-commit failures roll back the state and notification. The 43 shared temp-file SQLite/Postgres 18 checks cover running/terminal timestamps, actor payloads, all terminal callback states, concurrent CAS and cancellation races, error precedence, unique frozen-clock ids, rollback and redacted spans. The Store suite passes 159 checks and `make check` passes 361 TypeScript tests and one Python test. A newly rebuilt non-root image verifies the compiled transition on both dialects, together with the previous creation, leasing and migration integration. Independent contracts review reproduced lifecycle-field ownership drift: patches could rewrite creation/scheduling times or add a start time during non-terminal cancellation. The repair preserves the timestamps owned by createRun/markScheduled and limits missing-start backfill to terminal transitions; four new both-dialect regressions and the rebuilt compiled image verify row/event/callback consistency. [P1.5 code CI](https://github.com/xenarro/krun/actions/runs/40110679826) verifies exact code commit `4b15cd62064908e26024b3578349bb92a485a094` in [stacked PR #10](https://github.com/xenarro/krun/pull/10), including frozen install, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and scanning. The PR targets the still-unmerged `feat/store-run-leasing` parent; no layer was merged or auto-merged. Full Store-layer assembly, P1.6-P1.11 and complete Phase 1 acceptance remain incomplete.

P1.6 locally implements Database-backed `getRun` and `listRuns` factories under D45. `getRun` returns the normalized FULL row or `NotFoundError`; listing selects every column except input, result and log tail, decodes that smaller row, and uses the sole canonical BASIC mapper. The shared Zod filter grammar implements the documented closed-enum/state/failureReason/time-bound AND subset. Keyset pagination orders by creation time and id descending, uses the actual row-value comparison, and binds canonical base64url cursors to the function, owner and normalized filter, not page size. Zero page size defaults to 50 and values above 200 are capped. The 36 checks cover real temp-file SQLite/Postgres 18 queries, 250-row 100/100/50 pagination with equal-time ties, owner/function isolation, cursor mismatch and malformed-token rejection, changed page sizes, between-page inserts/deletes, BASIC privacy/FULL-column exclusion, typed sanitized errors and redacted spans. Actual Postgres `EXPLAIN` of the production unfiltered builder names `runs_created_idx`. The Store suite passes 195 tests; `make check` passes 397 TypeScript tests and one Python test. A rebuilt non-root image verifies both compiled query methods on both databases alongside previous migration/creation/leasing/transition integration. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40116652312) passes for `5fe6834b15d77ada45e2ee3e8df9175201e30d07` in [PR #12](https://github.com/xenarro/krun/pull/12) against main, including frozen installs, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and fixable-critical scanning. This is pushed/green P1.6 source, not a merged-main or complete Store/Phase 1 claim. Independent correctness review reproduced P16-C1: fractional RFC3339 operands were truncated before SQL and filter hashing. The repair preserves exact comparisons on the millisecond storage grid by adjusting strictness for nonaligned bounds, without rejecting fractional input or changing Store types; independent integer-oracle and cursor-regression checks pass on both databases and in the rebuilt image. The feature preserves its verified integration fork `0fb0f177c8ad1cb52446ef88d043aa499806b858`. Delivery refreshed main and reconciled the already-merged integration PR #11 through a normal content-preserving ancestry merge; the authorized repository-local xenarro author policy was committed separately. PR #12 remains open for required independent repository review, without auto-merge or protection changes.

P1.7 locally implements the declared `expireQueued`, `sweep`, `claimDeliveries` and `updateDelivery` methods through a Database-backed factory under D45. Expiry compare-and-sets only the named function's queued rows strictly before the cutoff, preserves FULL cleanup/job metadata and accepted errors, and atomically writes the shared-clock finish/event timestamp, queue-timeout reason, canonical BASIC callback and Postgres notification. Retention deletes oldest finished rows in bounded strict-cutoff batches with foreign-key cascades; SQLite runs incremental vacuum after every batch on the same transaction/connection. Delivery selection and its 60-second lease are one SQL statement, using Postgres `SKIP LOCKED` or SQLite's existing immediate transaction; due rows are eligible at the exact lease boundary. Delivery updates change only state, attempt, retry time and last error. The existing interface permits a null replacement time while DDL keeps `next_at` NOT NULL, so null retains the previous claim/retry time rather than inventing a timestamp or violating the schema; terminal rows are excluded from claims. A Zod infrastructure decoder validates stored BASIC callback snapshots without replacing the sole row-to-wire mapper. The 53 focused real SQLite/Postgres 18 checks cover every method, strict cutoffs, concurrent expiry/cancellation/claim races, callback privacy and optional fields, event/delivery/decode/deferred-commit rollback, external row-lock skipping, retention cascades, actual SQLite page reclamation, vacuum failure rollback and sanitized spans/errors. The Store gate passes 248 tests and `make check` passes 450 TypeScript tests and one Python test. A newly rebuilt non-root image verifies all four compiled methods on both databases together with prior Store/migration integration: 16 current emitted hashes and 15 phases. Generation, Helm, production audit and fixable-critical image scan pass. Independent correctness and contracts reviews reproduced the same missing queue-timeout diagnostic: an ordinary no-report expiry left the row and immutable callback without an error. The repair fills a safe KRUN error with SQL `coalesce` in the same expiry update, before FULL decoding/BASIC snapshotting, while preserving every accepted FUNCTION/KUBERNETES/KRUN report. Four new dialect regressions plus both unchanged reviewer probes verify returned/stored/callback consistency, and concurrency/cancellation/rollback assertions and the rebuilt compiled image include the fallback. P1.7 code is pushed and exact-head green in [stacked PR #13](https://github.com/xenarro/krun/pull/13), against immediate unmerged parent feat/store-run-queries/PR #12; [code CI](https://github.com/xenarro/krun/actions/runs/40121735947) passes the frozen install, 450 TypeScript/one Python, generation, rebuilt container/migration, Helm, audit and scan gates. This is verified source delivery, not merged P1.7 source, assembled full Store or complete Phase 1 acceptance. No auto-merge or protected-main review bypass is enabled.

P1.8 locally implements the declared `subscribe` method through a Database-backed factory under D45. Postgres uses one lazy, shared, scoped `LISTEN krun_runs` client outside the unchanged five-connection query pool; all consumers and factories share it, and the last consumer closes it. A failed client is finalized and replaced with a new client using Effect exponential reconnect delays from 100 ms, capped at 1 second; paired error/end events do not start duplicate reconnects. Notifications validate UUID and known suffixes, emitting only id and state/status/job_status kind. The bounded 256-element sliding callback/fan-out buffers carry advisory hints, not replayable history; the SPEC wait/SSE re-read fallback remains separate future handler work. SQLite initializes each consumer at `max(rowid)` when the stream is consumed, then polls strict increasing rowids in order every second, classifying same-state rows as job_status and never replaying an already-seen row. Query or batch-decode failures are typed and sanitized, rather than empty polls; cancellation stops polling or reconnect work. All 19 real SQLite/Postgres 18 subscription checks and three forward-migration checks pass, including production transitions within the required two seconds, committed-only delivery, malformed payload rejection, independent cursors, live client termination/reconnect, two-factory sharing, cancellation during backoff, responsiveness while all five query-pool connections are held, and ended redacted client spans. The current Store gate passes 270 tests; `make check` passes 472 TypeScript tests and one Python test. A newly rebuilt non-root image verifies 20 current emitted hashes and 18 integration phases, including both compiled subscription backends and all prior Store/migration integration. Generation, generated-clean checks, Helm, production audit and fixable-critical image scan pass. D46 repairs the independently reproduced retention/cursor defect: SQLite forward migration `0002_event_rowid` adds an internal AUTOINCREMENT rowid alias, preserving existing rowids, all six shared event columns, the index and cascade without changing shipped `0001_init`. The live stream now observes new transitions after retention empties events or deletes their maximum, without replaying surviving history. Tests verify migration rollback, sparse-rowid/data preservation, allocator persistence through vacuum/restart and unchanged Postgres behavior; the rebuilt image also upgrades an actual pre-repair image database and accepts that old image's six-column writer afterward. The polling query, interval, public Store shape and Postgres transport remain unchanged. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40128846408) passes for `2940bf228fef86fcd5f6e0169b85e7d875e198b9` in [PR #14](https://github.com/xenarro/krun/pull/14) against the still-unmerged `feat/store-expiry-delivery` parent, including frozen installs, generated-clean checks, rebuilt non-root image/migration smoke, Helm, audit and fixable-critical scanning. This is pushed/green P1.8 source, not merged source, assembled full Store or complete Phase 1 acceptance. P0.9 remains independently owner-blocked.

P1.9 verifies the existing in-house built-in `node:sqlite` dialect and scoped Database layer; the adapter, five open pragmas, single-connection mutex, `begin immediate` driver and D43 transactional-DDL support were already required by P1.2 and remain unchanged. Four new temp-file checks cover writer reservation before any transaction-body SQL, concurrent WAL readers and committed-only visibility, native writer recovery after commit/rollback, one serialized physical connection for concurrent borrowers, and reapplication of connection-local pragmas after reopening the same file. A second native connection uses `busy_timeout = 0` and reports `ERR_SQLITE_ERROR` with numeric `errcode = 5` while the production transaction is open. Isolated source snapshots show that the new assertions reject deferred BEGIN, disabled connection serialization and an incorrect busy timeout; the unchanged source is the positive control. All 10 dialect checks, 274 real SQLite/Postgres Store tests and `make check` (476 TypeScript tests and one Python test) pass. A newly rebuilt non-root image verifies the current emitted runtime and previous integration, plus five compiled dialect checks under a read-only root, no network and dropped capabilities. No runtime behavior, dependencies, schema or public API changed in this task. Both independent reviews reported no confirmed material defect; the repair preserved runtime and reran native failure-recovery and separate-writer-process controls. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40133747415) passes for `8a9fe97b03a58c241ea0f19cee69dc4255019c5d` in [stacked PR #15](https://github.com/xenarro/krun/pull/15) against the still-unmerged `feat/store-subscriptions` parent, including 476 TypeScript tests, one Python test, generation, rebuilt non-root image/migration smoke, Helm, audit and scanning. Earlier local default-parallel runs exceeded existing five-second test deadlines; those failures are retained and their root cause remains unconfirmed. No assertions, deadlines or execution scheduling were weakened. This is pushed/green P1.9 source, not merged source, assembled full Store or complete Phase 1 acceptance. P0.9 remains independently owner-blocked.

P1.10 implements `setRuntimeStatus`, `setResult`, `setError` and `setJobStatus` as a typed Database-backed method group under D45. Function reports use an atomic state predicate: queued with a token, scheduled or running; they replace the latest value without changing lifecycle state, appending history or creating callbacks. Runtime status publishes a committed Postgres status hint; SQLite deliberately has no runtime-status event. Function error reports replace earlier reports and remain authoritative through the existing terminal-transition `coalesce`. Job status is accepted only in scheduled, running or cancelling: its SQL compare-and-set ignores `observedAt`, JSON key order and numeric spelling, but detects other field additions, changes and removals. A genuine change atomically writes the status, same-state `job_status` event and Postgres hint; timestamp-only, concurrent duplicate and stale reports write nothing. The 42 new temp-file SQLite/Postgres 18 contract checks cover the full state matrix, opaque JSON keys and falsy results, replacement/error precedence, terminal races and BASIC callback consistency, event/deferred-commit rollback, notification visibility and redacted spans. The current Store gate passes 316 tests; `make check` passes 518 TypeScript tests and one Python test. A newly rebuilt non-root image verifies 21 emitted hashes and 25 integration phases, including all four compiled methods on both databases and their real production subscription pipelines. Generation, Helm, production audit and fixable-critical scanning pass. One initial full run hit the previously observed five-second allocator-test deadline; the isolated test and exact unchanged full retry pass, without changing deadlines or claiming its root cause fixed. Both independent reviews found zero confirmed material defects; exclusive integration preserved the reviewed source and reran acceptance and native adversarial/ownership controls. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40137897538) passes for `36afd4b374fe6ee0bbbecb2722d3591eca485271` in [stacked PR #16](https://github.com/xenarro/krun/pull/16) against the still-unmerged `feat/store-sqlite-dialect` parent, including 518 TypeScript tests, one Python test, frozen dependencies, generation, rebuilt non-root image/migration smoke, Helm, audit and scanning. Only then P1.10 was checked in PLAN. This is pushed/green source, not merged source; no auto-merge or protected-main approval bypass. Store interruption waits for transaction settlement; active query cancellation and the strict five-second internal HTTP deadline remain separate P3.7 acceptance, not guarantees proved by this slice. P1.11, full Store-layer assembly and complete Phase 1 acceptance remain pending; P0.9 publishing prerequisites remain independently unresolved.

P1.11 locally implements `listStale(fn, before)` with the prescribed Postgres `greatest` expression and SQLite null-safe scalar `max`: only the named function's running rows whose later status/start timestamp is strictly before the cutoff are returned. Missing status falls back to start time; a fresh start cannot be overridden by an old status. Results are normalized FULL rows; read or whole-batch decode errors remain sanitized `DatabaseError`, and client spans expose only operation/count. Existing transition support for `failure_reason` is verified through FULL/BASIC reads and the atomic heartbeat-timeout callback. With the final method present, `packages/shared/src/store/live.ts` composes all 23 real methods into `StoreLive`, backed by the provided scoped Database, plus `StorePostgres` and `StoreSqlite` constructors. Deferred `migrate()` calls retain that same Database and normalize the CLI-specific migration-history failure to the Store's declared `DatabaseError`; no placeholder operations or future-phase behavior are added. The 18 new shared SQLite/Postgres 18 checks cover stale/status/start boundaries, function/state isolation, latest-report replacement, failure/callback consistency, errors/spans, all 23 assembled methods, shared Database ownership and production subscriptions within two seconds. Independent contracts review reproduced P111-CONTRACT-1: failed transitions could commit missing or contradictory row/event classifications. Repair now derives one validated reason from either existing argument, rejects absent/unknown/conflicting classifications atomically, and writes that same reason to row, event and BASIC callback; stale CAS remains false and accepted FUNCTION errors retain precedence. Twelve new both-backend regressions include the reviewer oracle and rejection/rollback controls. The exact Store gate passes 347 tests and `make check` passes 549 TypeScript tests and one Python test. A newly rebuilt repair image verifies 23 emitted hashes and 29 integration phases, including compiled classification derivation/rejection and all prior Store integration. Both reviewers' owned native probes also pass: eight contract tests and 14 correctness groups covering 600 oracle cases and all 18 backend/reason combinations. Timing investigation reproduced five-second deadlines and measured SQLite initialization spending over eight seconds in auto-vacuum/WAL pragmas before NORMAL synchronization and the busy timeout were applied. The adapter now applies the same required NORMAL/5000 connection policy before persistent initialization writes, preserving all five pragma values and transactional behavior; a new native regression verifies fresh/reopened connections. Controlled initialization traces showed fewer synchronization calls for the corrected order; a WAL-before-auto-vacuum alternative was rejected because it lost the required auto-vacuum setting. Earlier failures and diagnostics remain retained. No deadline, assertion, worker scheduling or public contract was weakened; this is not a guarantee about arbitrary host I/O latency. Generation, generated-clean checks, Helm, workflow lint, production audit and fixable-critical scanning pass. The Phase 1 Store gate is implemented and verified on both real backends. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40145278152) passes for `5a7b2f37ef22d2baaa9899558051d3029a124cdf` in [stacked PR #17](https://github.com/xenarro/krun/pull/17), based on the still-unmerged `feat/store-runtime-status` parent, including all nine required gates and 549 TypeScript tests plus one Python test. Only after code CI passed was P1.11 checked in PLAN. This is pushed/green source, not merged source; no auto-merge or protected-main review bypass. Full application, Phase 0, cluster/e2e and publishing acceptance remain incomplete. The next product task is P2.1 from the final verified P1.11 lineage. P3.7 retains its strict handler cancellation/deadline follow-up, and P0.9 remains independently owner-blocked.

P2.1 adds reusable webhook policy, signing and single-attempt transport helpers in `packages/shared/src/webhook`; they are not yet wired into submission routes or the scheduler delivery loop. Host globs are snapshotted, case-folded and compiled with the approved picomatch grammar. Every DNS answer is checked with `ipaddr.process`: IPv4-mapped addresses are unwrapped, explicit same-family CIDRs permit exceptions, and otherwise only `unicast` is accepted. Empty or mixed disallowed answers fail closed. The runtime guard reuses the existing byte-preserving wire URI schema before parsing an HTTP(S) target, rejects unusable userinfo, preserves the supplied URL, and resolves again for every attempted send. Each attempt owns an Undici Agent whose `connect.lookup` returns only its checked address (including Node's `all` callback form), retains the original hostname for Host/SNI and normal certificate verification, disables redirect following, bounds DNS/request work to ten seconds, cancels unread response bodies and destroys the owned dispatcher on every exit. Only prescribed delivery headers can be emitted; native errors, URLs, body bytes and signatures are not retained in errors or logged.

Signing reads the Effect clock at invocation, snapshots Zod-validated active keys and computes one lowercase hex HMAC-SHA256 per key over the exact `<seconds>.<raw body bytes>`. Tests include the six required denied addresses, explicit private CIDRs, public hosts, mixed DNS answers, legacy IP spellings, mutable configuration/key/body inputs, arbitrary-byte rotation properties, send-time clock changes, inclusive receiver-side replay-window checks, actual IPv4/IPv6 sockets, DNS rebinding, native TLS identity/SNI/Host, redirect refusal and interruption/timeout cleanup. The receiver verifier is test-only, not a shipped SDK. The rebuilt non-root image verifies the compiled helpers with owned HTTP/TLS receivers and the complete previous Store integration. OpenSSL generates disposable test certificates; tests restore the native trust store and delete their generated files without disabling verification. SPEC D47 records development-only picomatch typings; no release-age policy or SDK dependency changes. Independent contracts review reproduced P21-CONTRACT-1 with a non-stable injected resolver record: validation and pin selection could read different addresses, and the excluded owned loopback receiver received a POST. No remote bypass of the stock OS resolver was demonstrated. Repair now reads resolver address strings once into a frozen, Zod-validated snapshot, checks all those values and normalizes/selects the pin from that same snapshot. Provider field-read failures are sanitized. Seven new regressions cover getter/record replacement, mapped normalization, mixed answers, malformed/throwing providers and the actual two-address receiver case without widening CIDRs. The webhook suite passes 71 tests; the current Phase 2 command passes 84 existing tests; `make check` passes 620 TypeScript tests and one Python test. Owned copies of all six contracts probes, the compiled two-key wire probe and seven correctness groups (384 address cases and 64 binary signature cases) pass after repair. A newly rebuilt repair image verifies 29 emitted hashes and 42 integration groups/phases, including the same excluded-address control in the compiled runtime. Both independent reviews were consumed; their original reports/probes remain unchanged, and no post-repair external approval is claimed. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40150535757) passes for `55bb6e1cac2ac1bacd6f1831bfeaca6332566d21` in [stacked PR #18](https://github.com/xenarro/krun/pull/18), based on the still-unmerged `feat/store-stale-runs` parent, including all nine required gates and 620 TypeScript tests plus one Python test. Only after that accepted code run passed was P2.1 checked in PLAN. This is pushed/green source, not merged source; no auto-merge, protected-main review bypass or independent GitHub approval is claimed. The Phase 2 command runs currently present Function-schema/webhook tests, but auth, Function policy validation, informer/cache and CLI validation remain later tasks, so this is not complete Phase 2 or application acceptance. A full-check attempt hit the previously observed five-second SQLite allocator-test deadline; the unchanged isolated allocator passed under native sync tracing. That retained observation does not establish the cause of the failed run or a universal host-latency fix; Store settings, assertions, deadlines and worker scheduling are unchanged.

P2.2 adds `validateFunction` in `packages/shared/src/functions/validation.ts`: one synchronous pure second-layer validator over an already parsed Function spec and explicit installation ceilings. It reads no environment, clock, DNS, files or cluster state. It reuses the source Function/duration schemas, checks literal image prefixes, allowed service accounts, reserved `krun-*` secret references, deadline/backlog ceilings and default callback hosts. The host matcher is extracted from P2.1 without changing its case-folding, dot or picomatch grammar; admission checks only the host, not runtime protocol/address policy. The runtime webhook policy still sanitizes configuration field-read failures, with a new red/green regression preserving that adapter boundary. Success returns `Valid`, an empty message, the synchronous input validator and parsed Effect queue/optional heartbeat durations. Failure uses the existing closed Ready reasons and fixed field-only messages, retaining a valid queue duration for downstream expiry handling without retaining native compiler errors, schema contents, environment values or URLs.

Input-schema size is measured as compact serialized UTF-8 bytes, accepting exactly 65536 bytes. Size, recursive local-reference checks and compilation consume the same owned JSON snapshot, leaving caller data unchanged. Non-local `$ref`/`$dynamicRef` values and asynchronous validators are rejected. Each validation uses a fresh strict Ajv2020 with the complete approved default ajv-formats plugin: duplicate IDs cannot leak between Functions/generations, no loader or async compilation exists, and input data is neither defaulted nor coerced. Own-property checks keep inherited JavaScript constructor values from satisfying JSON input requirements; compiler logging is disabled. The already-approved Ajv dependencies are now production dependencies of shared, not either SDK; no dependency-policy exception is added. Eighty-two Function tests and 72 webhook tests pass in the current 154-test Phase 2 slice; `make check` passes 690 TypeScript tests and one Python test. A newly rebuilt repair image verifies 31 emitted hashes, eight compiler/plugin dependency-file hashes and 56 combined integration groups/phases, retaining the previous Store/webhook/resolver checks and adding seven compiled Function-validation groups, including actual date-format rejection, all rule categories, byte-size boundaries, local references, snapshot ownership, bounded errors and zero DNS/fetch calls. Generation/drift, Helm, actionlint, dependency audit and the critical image scan also pass. Both independent reviews were consumed and their original reports/probes are preserved; owned reruns pass after repair, but no post-repair external approval is claimed. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40156786037) passes all nine required gates and 690 TypeScript tests plus one Python test for `4745b65838f7dd4064f3fa9852b205a1bc85abb5` in [stacked PR #19](https://github.com/xenarro/krun/pull/19), based on the still-unmerged `feat/webhook-security` parent. Only after accepted code CI passed was P2.2 checked in PLAN. Source is pushed/green, not merged; no auto-merge, protection bypass or independent GitHub approval is claimed. The informer, keys loader, real validate CLI, complete Phase 2 and application/cluster/e2e acceptance remain future work.

Independent P2.2 correctness P22-C1 and contracts P22-CONTRACT-1 reproduced the same compiler omission: a Function declared Valid could receive an own `__proto__` value violating its declared property type. This was constraint omission, not demonstrated prototype pollution or code execution. SPEC D48 records a tracked pnpm patch to Ajv 8.20.0: remove the schema-map key filter, keep property/evaluation/dependency dictionaries null-prototype and split dependency maps by own keys, with published TypeScript and runtime JavaScript changed together. It preserves original schemas and local pointers without banning/renaming fields, schema transformation, strictness relaxation or a loader. Tests cover optional/required/top-level/nested own names, boolean and regex maps, small/large additional-property paths, static/dynamic/merged unevaluated-property tracking, definitions/references, both modern and legacy dependency maps, ordinary controls and unchanged `Object.prototype`. P22-CONTRACT-2 reproduced four missing default plugin comparison keywords; the integration now calls the actual typed CommonJS plugin entrypoint rather than using only its format table, with inclusive/exclusive equality tests. All 32 new compiler regressions pass; fresh owned copies of eight contracts tests and the compiled production schema probe pass, and all 12 correctness own-key cases now have zero mismatches while six format pairs, ten reference cases and other controls remain passing. The rebuilt image runs seven additional compiled compiler-repair groups and verifies the patched runtime/source and plugin file identities. Frozen normal-policy installs apply the same tracked patch before both existing container installs; no new package, release-age exemption, supply-chain bypass or SDK runtime dependency is introduced. The first owned contracts rerun used a doubled relative config path and failed before collecting tests; the corrected invocation passes unchanged assertions, and both attempts remain recorded.

P2.3 implements reusable KubeConfig, Function-source and Function-cache layers in `packages/shared/src/k8s` and `packages/shared/src/functions/cache.ts`. The approved Kubernetes client loads its normal KUBECONFIG/user-config/service-account precedence; acquisition failures retain no native diagnostics or configuration contents. The shared request wrapper defaults to eight concurrent API acquisitions, honors the scheduler's configured limit and aborts requests at ten seconds. The authenticated, scope-owned LIST/WATCH adapter watches `functions.krun.io` only in `KRUN_NAMESPACE`, starting from the collection's resourceVersion. It owns pending requests, stream readers and native TLS/proxy dispatchers rather than relying on the installed native informer's incomplete pending-request cleanup. Every reconnect starts a fresh authoritative LIST, including HTTP 404 before CRD establishment and watch 410/error/EOF, with Effect exponential backoff from 100 ms capped at 30 seconds. No timer polling, production cluster or new dependency-policy exception is introduced.

The cache atomically replaces snapshots, handles add/update/delete events, validates through P2.2 and exposes only valid Functions through `get`/`list`; bounded invalid results remain available separately for later scheduler diagnostics. Owned, frozen specs and compiled validators are reused for the same UID/generation, while status/resourceVersion changes remain observable without recompilation. Replacements recompile, old-UID deletes cannot remove them, and relists drop vanished entries. A Deferred-backed `synced` effect resolves only after successful initial LIST, including an empty list; Readiness and `krun_functions_synced` remain false meanwhile. Scope release stops watching and clears the cache/readiness/metrics. `krun_functions` has only the two `ready` label values. Provide `TelemetryLive` to the producer layer so its process-local registry is shared, rather than merging it as an unrelated sibling. Twenty-eight task tests cover stubbed events, native owned HTTP sockets, both role-layer assemblies, actual Prometheus scrapes, retry/deadline boundaries and cancellation before/after authentication. The current Phase 2 command passes 165 tests and `make check` passes 718 TypeScript tests plus one Python test. A newly rebuilt non-root image verifies 35 emitted hashes, 12 compiler/client dependency-file hashes and 66 integration groups, including ten compiled P2.3 checks across both role layers and all previous Store/webhook/compiler integration. Generation/drift, Helm, actionlint, frozen install, production audit and fixable-critical scanning pass. P2.3 repaired source is pushed with [exact accepted-code CI](https://github.com/xenarro/krun/actions/runs/40163143968) green for `93daef9dc4e166d39110903384fabee357dc8e7a` in [stacked PR #20](https://github.com/xenarro/krun/pull/20),based on the still-unmerged `feat/function-validation` parent. PLAN checks only this task after accepted code CI;source is pushed/green,not merged or independently approved. The finite process commands, Function status writer, keys loader, validate CLI, cluster harness and complete Phase 2/application gates remain separate work.

Later unrestricted full-gate reruns hit unchanged Store five-second deadlines, and one run also exceeded existing Postgres container-startup hook limits, during measured heavy host I/O pressure. The complete 347-test Store control and the pre-P2.3 shared-suite control pass. The final complete gate passes with this test process explicitly restricted to two CPUs, reducing automatic file-level concurrency without editing test configuration, deadlines, assertions or within-test races. The earlier unrestricted complete gate also passed; all failed attempts remain recorded. This verifies the implementation, not a universal repair of native/filesystem timing. Delivery must rerun its required gate before committing.

Exclusive P2.3 repair consumed both independent reviews: correctness `P23-C1` and contracts `P23-CONTRACT-1` describe the same confirmed snapshot-width failure. After pure validation correctly returned `SchemaTooLarge`, spreading a wide array/dictionary into `stack.push` exceeded Node's argument limit. A startup LIST then hid valid neighbors and never synchronized; an invalid update left its old Valid generation served. The shared freezing traversal now pushes children individually, preserving full own-key snapshots, immutable specs/status/policy, the 64 KiB limit, invalid-entry queue durations and atomic authoritative LIST replacement. No schema truncation, key ban, swallowed decode failure, dependency or test-policy change is used. Four new array/dictionary startup/update regressions fail on the original source and pass after repair; resync reuse, own `__proto__`/`constructor` names and valid neighbors are checked too. Owned reruns of the four contracts cases, both compiled correctness regressions and all eight additional reviewer native transport/isolation groups pass. Their input/contract assertions are preserved, with explicit owned-harness adaptations for a successful update no longer causing a retry. Original peer reports/probes and every prior failed receipt remain unchanged; no external post-repair approval is claimed. Current task acceptance passes 32 tests, the existing Phase 2 slice passes 169 and an unrestricted `make check` passes 722 TypeScript tests plus one Python test. A newly rebuilt repair image verifies 35 emitted hashes, 12 dependency-file hashes and 70 integration groups, including 14 compiled native-cache groups across both role layers. The historical filesystem/timing caveats above are not claimed fixed by this repair. Delivery first reproduced three hosted failures caused by requiring the agent-specific TMPDIR variable. Both credential-free fixture paths now use Node's standard temporary-directory API,which honors the configured scratch directory locally and works with the CI runner defaults. Owned mkdtemp names,cleanup and every assertion remain intact;the missing-TMPDIR control and the corrected exact-head hosted full gate pass. The failed first run is preserved. This bounded task is pushed/green,not merged;process wiring,status writer,keys/CLI and complete application acceptance remain later work.

P2.4 implements reusable `Keys`/`KeysLive` and strict Zod `keys.yaml` schemas in `packages/shared/src/auth`. A string or non-empty rotation list authenticates as one immutable named principal; duplicate names reject the whole load. Names are Kubernetes label values, not lowercased resource names. All five documented scopes are recognized, including explicit `runs:priority`; `admin` grants every scope and function without requiring globs. Other scopes do not imply each other. The optional positive-integer `maxQueued` is carried as metadata for later CreateRun enforcement, not enforced by this loader. Platform teams must generate secrets from at least 32 random bytes, as required by SPEC; tests generate their own credentials and no key-management API is added.

Function globs compile once per accepted content change with native picomatch, case-sensitive and dot-enabled. Arrays are OR grants, with braces, classes and extglobs supported. A leading `!` negates that individual grant: `["!billing-*"]` permits other functions; it is not a deny-list override on other globs. Lookup hashes the presented bearer and compares every configured fixed-width SHA-256 digest with native `timingSafeEqual`, without a secret-indexed map, unequal-length fast path or early match return. Returned metadata contains neither secrets nor digests. A credential shared across different names is ambiguous and fails lookup rather than granting whichever identity appears first or last; duplicate rotation members for the same name remain unambiguous.

The gateway-only scoped layer reads `KRUN_API_KEYS_PATH` on acquisition and reopens it every 30 seconds, following Secret directory symlink swaps. An unchanged raw-content hash preserves compiled principal identity; a complete valid changed file atomically replaces the snapshot, and explicit `keys: []` revokes every key. Startup read/parse/validation failure fails acquisition. Later failures keep the last complete snapshot and log only bounded reason/field/entry metadata, never native diagnostics, file contents or credentials. Invalid UTF-8, duplicate YAML mapping fields, parser warnings and multiple documents reject without source-snippet logging. Scope closure cancels the poll and an in-flight Effect read. The scheduler refuses this gateway-only layer before attempting a mount read.

P2.4 acceptance passes 44 auth tests, including real production-layer file reads, atomic Secret-style symlink rotation, constant-time comparison call/width controls, allowed/denied/admin/priority cases, duplicate identities, rotation/removal, unchanged/invalid reloads and scoped cancellation. The exact current Phase 2 test command passes 213 tests; unrestricted `make check` passes 766 TypeScript tests plus one Python test. A newly rebuilt non-root image verifies 38 current emitted-module hashes, 19 dependency-file hashes and 80 integration groups, retaining all prior Store/webhook/compiler/native-cache assertions and adding ten compiled auth groups. Generation/drift, Helm, actionlint, frozen install, production dependency audit and fixable-critical scanning pass. Both independent local reviews found no confirmed material defect; exclusive repair preserved the reviewed source and reran the additional correctness/contracts/native lifecycle probes. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40167721878) passes all nine required gates for `3367ae070b255fac27450a291c4c6afb9ab4ab3d` in [stacked PR #21](https://github.com/xenarro/krun/pull/21), based on the still-unmerged `feat/function-informer-cache` parent. Only after accepted code CI passed was P2.4 checked in PLAN. Source is pushed/green, not merged or formally independently approved; no auto-merge or protection bypass is claimed. Original implementation red/green receipts and the reviewer-only optional-peer import failures remain preserved; the corrected reviewer harness uses the actual narrow NodeRuntime subpath without adding an optional package or changing product code. P2.5 CLI validation, actual auth hooks/routes, per-key queue-cap enforcement and complete application/Phase 2 acceptance remain separate work. The finite gateway/scheduler commands are still not wired to these reusable layers.

## Offline Function validation (P2.5)

`node bin/krun.js validate <path>...` and the container `validate` command now run the source Function resource schema followed by the same pure second-layer validator used by the runtime cache. Explicit files may contain multiple YAML documents; directory arguments visit immediate lowercase `.yaml`/`.yml` files in sorted order, without recursive traversal. Other kinds are skipped, repeated resolved paths are deduplicated, and unsupported Function versions fail schema validation. Each decoded Function produces one `OK` or `FAIL` stdout line. File/parser/config errors go to stderr; any error or an empty Function set exits 1. `--help` exits 0 without requiring configuration. SPEC D49 records discovery, output and empty-set decisions.

Only the five Function ceilings are parsed and their actual defaulted values are printed as one JSON line on stderr: `KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`, `KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS` and `KRUN_WEBHOOK_ALLOWED_HOSTS`. No database, Kubernetes client, mounted namespace, API-key file or generated CRD/editor artifact is consulted. Callback validation fails `CallbackNotAllowed` with the default empty host allowlist; supplying an explicit allowed host passes without requiring a delivery secret or making a network request. Output never echoes parser snippets, arbitrary field names, environment values from Function manifests, input-schema contents or callback URLs. Invalid UTF-8, malformed/duplicate/tag-warning YAML and invalid documents fail with bounded diagnostics; quoted paths cannot inject physical output lines. A `REPLACE_WITH_DIGEST` image gets an actionable error.

```sh
make build
node bin/krun.js validate --help
node bin/krun.js validate path/to/function.yaml path/to/manifests
# After make docker; bind only the manifests being validated:
docker run --rm --read-only --network none -v "$PWD/path/to/manifests:/f:ro" krun:local validate /f/function.yaml
```

Initial P2.5 implementation acceptance passed 17 CLI tests and the exact Phase 2 gate (213 tests), without a cluster. The subsequent P25-C1 repair and current counts are recorded below. Two unrestricted `make check` runs, including one with shared/CLI build outputs preserved aside and rebuilt from scratch, pass 782 TypeScript tests plus one Python test. SPEC D50 and STACK document the internal workspace build ordering needed for clean consumer type checks. The rebuilt non-root image verifies 40 current emitted-module hashes, 19 dependency-file hashes, all 80 inherited integration groups and five dedicated real CLI cases: valid, tag-image, mixed documents, callback denied and callback explicitly allowed. The read-only tag-image mount prints one Function line and exits 1. One attempted cold gate hit the unchanged SQLite rollback test's five-second timeout; its failure receipt is retained, while all ten isolated dialect controls and fresh unrestricted reruns pass without changing Store code, timeouts or worker settings. CI now runs these real checks instead of expecting the obsolete finite `validate` stub. Generation/drift, Helm, actionlint, frozen installation, production dependency audit and fixable-critical scanning pass. At that implementation checkpoint P2.5 remained unchecked pending independent review, repair/integration and delivery; no commit, push, PR or hosted CI was claimed. No auth route, scheduler serving process or end-to-end platform is claimed.

## P2.5 review repair: schema-reference context

Independent correctness review confirmed P25-C1: the shared local-reference guard treated ordinary property/definition names and default/enum instance data named `$ref` or `$dynamicRef` as active schema keywords. The real CLI and informer therefore rejected legitimate schemas. Exclusive repair changes that shared guard, not CLI delegation: distinguish schema-map entries and opaque instance/annotation data, inspect every actual nested/unused schema, and inspect targets explicitly promoted by local JSON Pointers. Preserve conservative scanning for object keywords whose anchors the installed compiler can index before strict compilation. Iterative identity/resource tracking handles local recursive references without rewriting schemas; source own keys, strict synchronous Ajv2020, the complete formats plugin, the 64 KiB bound and no-loader/no-network policy are unchanged. SPEC D51 records the rationale.

The original correctness probe now accepts all five formerly rejected schemas, retains its local-reference control, and validates native good/bad inputs. Seventy-two shared regressions cover ordinary names/data, schema applicators/maps/arrays, pointer escaping/promotion, unused definitions, registered-meta-schema remote rejection and strict/synchronous controls. Eight additional real-dispatch regressions bring CLI acceptance to 25 tests. The exact Phase 2 gate passes 285 tests; unrestricted `make check` passes 862 TypeScript tests plus one Python test. The five additional contracts-reviewer cases also pass against the actual repaired dispatcher, preserving cyclic/wide/UTF-8/own-name/private-warning continuation controls. These are repair-owner reruns, not a new independent approval.

The separately rebuilt `krun-test-p2-5-repair:local` image passes all 80 inherited integration groups and seven CLI groups, retaining original mixed/tag-image/callback behavior and adding a five-Function reference-context fixture plus actual unused-definition remote-reference rejection. Forty emitted-module hashes and nineteen dependency-file hashes match current host build artifacts; runtime uid/gid are 65532 and CLI mounts remain read-only with networking disabled. Generation/drift, Helm, actionlint, frozen install, production audit and fixable-critical scan pass. Original reviewer reports, implementation evidence/image and all red reproduction/control receipts remain preserved. No further material contracts finding was reported. At that repair checkpoint P2.5 remained unchecked and source uncommitted, with no delivery/hosted-task-head CI or merged/application completion claimed.

P2.5 delivery now has [exact code-head CI](https://github.com/xenarro/krun/actions/runs/40174400276) passing all nine required gates for `a0d16b02b2b799127aa341f47866de4c9420666c` in [stacked PR #22](https://github.com/xenarro/krun/pull/22), based on the still-unmerged `feat/api-key-loader` parent. Fresh delivery CLI/Phase2/full gates pass 25/285/862 TypeScript tests plus one Python test respectively; the hosted container stage executes all seven real CLI groups, including the repaired reference contexts and retained remote rejection. Two local tracking full-check attempts hit the unchanged five-second SQLite migration/dialect deadlines while isolated migration controls passed. Measured host I/O pressure was severe; a full run with per-command best-effort I/O priority 0 (`ionice -c 2 -n 0 make check`) passes without changing assertions, deadlines, workers, CPU affinity, source or global settings. Original failures and diagnostics are retained; no universal timing or product-race repair is claimed. Only after this accepted code CI passed was P2.5 checked in PLAN. The declared Phase2 helper/cache/keys/offline-CLI gate is verified, not an operational serving application. Source is pushed/green, not merged or formally independently approved; no auto-merge, protection bypass, publication or full application/e2e completion is claimed. Next independent task is P3.1a from the final committed verified P2.5 lineage.

## Dependency policy

[docs/STACK.md](docs/STACK.md) is the dependency allowlist. Automatic peer installation is disabled so unused Redis integration is not pulled in by the platform package. Process entrypoints import its public `NodeRuntime` subpath. Vite is development-only because Vitest 5 requires it (SPEC D37); neither Vite nor Redis belongs in the production image.

The release-age guard remains enabled. Repository-local exceptions cover only the explicitly approved Effect 4.0.6 packages, and strict mode prevents installs from silently adding other exceptions. SPEC D38 caps the OpenTelemetry API at `~1.9.0` for SDK 2.12 compatibility; it does not waive installation policy. SPEC D39 records a reproducible declaration-only pnpm patch for pino's transitive `thread-stream@4.2.0`, whose published types otherwise fail with Node 26; no runtime JavaScript or compiler checks are weakened.

## Design and operations

- [Problem and boundaries](docs/PROBLEM.md)
- [Behavioral specification and decisions](SPEC.md)
- [Public API contract](docs/API.md)
- [Internal container API contract](docs/INTERNAL-API.md)
- [Technology stack](docs/STACK.md)
- [Build plan](PLAN.md)
- [Operations](docs/OPERATIONS.md)

Non-goals include workflows/DAGs, a product web UI, automatic retries and a pool executor. The private local agent dashboard and orchestration checkpoints are Git-excluded development tooling, not part of krun or its container image.

P3.1c adds `docs/api/openapi-public.json`, generated by `make generate` from shared Zod public method descriptors through the installed `@fastify/swagger` dynamic plugin and Zod transforms. All nine normative methods, paths, scopes, FULL/BASIC resources, canonical errors, pagination, custom-method colons, JSON/redirect/SSE responses and correlation headers are represented. Response enums remain open strings with known-value descriptions; unset owned fields are optional, not nullable. An isolated registry preserves nested read-only/description annotations, unsupported conversions fail closed, and canonical JSON is deterministic. The generator uses a scoped, non-listening development-only Fastify app; its documentary routes fail closed and are never installed in the production factory. No business method, listener, Swagger UI or endpoint is implemented by this slice. SPEC D56 records the integration choices.

P3.1c implementation acceptance passes nine focused OpenAPI tests, the existing 73-test gateway factory phase gate and `make check` with 955 TypeScript tests and one Python test. Tests compare the normative method table, independent emissions and the checked-in artifact; resolve every local schema reference; verify open response enums and non-nullable owned schemas; and validate real FULL/BASIC JSON shapes with strict AJV2020. An initial unchanged real-disk retention test exceeded its existing five-second bound; its isolated control and two subsequent full checks passed without changing deadlines, assertions or Store code. This is local implementation evidence pending independent review and delivery, not hosted CI, merged source, current-image integration or completed Phase 3/end-to-end serving acceptance.

Independent P3.1c review found two reusable-contract defects: record parsing dropped an own `__proto__` key in opaque JSON, and CreateRun inherited response validators for fields that requests must ignore. D57 repairs both. Exact supported opaque leaves preserve object identity and have explicit JSON Schema projections; unrelated custom schemas still fail closed. Nested bidirectional codecs discard recognized output-only non-null values while preserving strict writable, unknown-field and null checks; output resource validation is unchanged. Permanent regressions cover the affected DTO/provider paths, every output-only member, generated request-schema parity and unrelated-custom failure. Reviewer-native consumers of the real factory, SQLite and canonical mapper pass; they remain test-owned consumers, not implementations of later business methods.

Repaired P3.1c acceptance passes 41 focused tests, the 97-test gateway phase gate and `make check` with 987 TypeScript tests plus one Python test. Two actual `make generate` runs are byte-identical. The freshly rebuilt `krun-test-p3-1c-repair:local` non-root, read-only, network-isolated image passes opaque-response/native request-validation regressions, 7 CLI validation groups and 57 emitted-module hashes; its development generator is absent. Helm, frozen install, production audit, workflow lint and fixable-critical image scan pass. The branch includes the latest fetched main through a content-preserving normal merge pending the delivery owner's commit. No commit, push, PLAN closure, publication or complete Phase 3/e2e serving claim is made by this repair.

P3.1c code `58db616e628e3b6e6c0a2db52df5340ca5681a08` is pushed and green in [PR #26](https://github.com/xenarro/krun/pull/26) against main. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40209410324) passes all nine required gates, including 987 TypeScript tests and one Python test, deterministic generated-clean checks, the rebuilt container, Helm, audit and scanning. Only P3.1c is newly closed in PLAN after that hosted acceptance. Independent protected-main approval remains required; this is delivered source, not approved or merged source. No auto-merge or complete Phase 3/public serving claim.

P3.2 implements real `ListFunctions` and `GetFunction` handlers in `apps/gateway/src/function-routes.ts`. Compose `functionReadRoutes(parsedGatewayConfig)` beneath `makePublicApp`'s authenticated service scope. The plugin uses the actual validated Function cache and current key globs, returns only Ready public definitions, preserves callback/heartbeat omission and configured zero/nonzero byte caps, and emits no private Kubernetes spec/status fields. Lists use name-keyset pagination, default/zero page size 50, cap 200, canonical bounded opaque cursors tied to the method and principal grants, and fresh visibility checks on every request. Missing, invalid and forbidden definitions share the generic error; unsynced cache reads are retryable 503. D58 records caller-owned parsed configuration, duration rendering and cursor choices. The public DTO's byte-cap minimum now matches valid zero configuration, with a reproduced native serializer regression and regenerated OpenAPI.

P3.2 independent reviews reproduced one canonical-admission defect across `maxConcurrency`, `maxQueued` and `activeDeadlineSeconds`: values above the existing public int32 range could become cache-valid and turn GetFunction and whole mixed lists into 500 responses. D59 aligns the canonical Zod admission and generated CRD/editor bounds with that existing contract, preserving minima/defaults and exact in-range values rather than clamping, widening public types or hiding healthy neighbors. Permanent regressions cover all three maximum/outside boundaries, mixed-page isolation, cache/key reload, keyset mutation and generated/public schema parity.

Repaired P3.2 local acceptance passes 20 focused gateway tests plus three schema-parity tests, the 117-test gateway factory gate and `make check` with 1010 TypeScript tests and one Python test. The freshly rebuilt non-root, read-only, network-isolated `krun-test-p3-2-repair:local` image passes the original 11 native real-handler groups, three int32 boundary cases plus seven independent native control groups, seven CLI validation groups and 58 module hashes. Native API-server admission in a dedicated disposable kind cluster passes all 12 boundary cases against the generated CRD; the cluster is deleted and its exact container is absent. Double generation is byte-identical; Helm, frozen install, audit, workflow lint and fixable-critical image scan pass. PR26 is now merged; a content-preserving normal merge of verified main is pending the delivery owner's commit. These repairs and the original implementation remain uncommitted for delivery; no PLAN closure, new PR/hosted-CI claim, listener/process startup, production write or complete Phase 3/application-e2e claim.

P3.2 code `22edfcc408e1b784f194fd58b761e2c1113401c0` is independently approved and merged in [PR #27](https://github.com/xenarro/krun/pull/27) against main. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40218290772) passes all nine required gates with 1010 TypeScript tests and one Python test, generated-clean validation, rebuilt-container checks, Helm, audit and scanning. Only P3.2 is newly closed in PLAN after that acceptance. Unrestricted-host Store timing failures remain recorded rather than accepted as green. The tracking pre-commit gate runs the entire unchanged `make check` in a disposable two-CPU verifier with default parallelism, file-backed SQLite temporary files on tmpfs and normal Postgres Testcontainers. Node 26.7.0, pnpm 12.14.0 and Python 3.13.15 match the project; assertions, deadlines, repository worker configuration, Store code and supply-chain guards are unchanged. This scoped verification profile does not claim that unrestricted-host timing flakiness is repaired. PR27 merged while the delivery tracking update was being verified. The follow-up changes only PLAN/README tracking, preserves the reviewed runtime source and reconciles current main normally. No agent auto-merge or protection bypass occurred; complete Phase 3/public-process/e2e acceptance remains later work.

### P3.4 Run reads (reviewed source delivery)

The public gateway factory now composes real Store-backed `GetRun` and `ListRuns` handlers. `GetRun` defaults to FULL, accepts `view=BASIC` and resolves the `-` wildcard from the stored Run. Current key globs and ownership apply before projection; other-owner, forbidden, absent and wrong-parent Runs share generic `RUN_NOT_FOUND`. Admin reads retain the requested-parent check. Persisted Run history remains readable independently of a current Ready Function or synced informer; no Function-resource visibility or startup readiness policy changes.

`ListRuns` returns canonical BASIC summaries, never `input`, `result`, `logTail` or error details. Typed Store filtering handles state, failure reason and precise RFC3339 creation-time terms. Invalid filters return `FILTER_INVALID`; malformed or mismatched navigation returns `REQUEST_INVALID`, including malformed inner Store cursors without masking real database failures. Page size defaults/zero to 50, caps at 200, rejects negative/fractional values and may change between pages. Versioned opaque tokens bind parent, exact filter, principal and current grants. D65 records bounded-batch visibility-before-pagination and lookahead: hidden Runs neither shorten full visible pages nor create a hidden-tail continuation. Worst-case scans traverse scoped history, with request interruption between Store batches; tokens never replace current authorization.

Final local acceptance passes 26 new handler/native tests, 36 extended dual-dialect Store-query regression tests and the standalone 185-test gateway factory gate. The entire unchanged `make check` passes 1088 TypeScript tests and one Python test under the documented disposable two-CPU verifier; existing assertions, deadlines and repository workers are unchanged. Actual native sockets compose CreateRun with GetRun/ListRuns on real SQLite and PostgreSQL, including lossless NUL input and opaque JSON keys. The newly rebuilt non-root, read-only `krun-test-p3-4-verified:local` image passes 26 native groups per backend, 64 exact runtime-module hashes, seven CLI validation groups and the fixable-critical scan. Frozen install, all four generated artifacts unchanged across two generation runs, Helm, production audit and workflow lint pass.

Final self-review reproduced successful wildcard GetRun audit metadata reporting the literal `-` instead of the authorized stored Function. The minimal post-authorization metadata fix has a retained failing regression and all 24 handler tests pass. Complete post-fix `make check`, the exact gateway gate and rebuilt-image native/identity/CLI/scan checks also pass. Native image controls assert successful wildcard audit records name the actual stored Function, without private input or credentials in logs.

Both independent P3.4 correctness and contracts reviews are complete with no confirmed findings. Exclusive repair/integration revalidation passes the 62-test handler/native/dual-dialect Store slice, the 185-test gateway gate and complete `make check` with 1088 TypeScript tests and one Python test. The reviewed runtime, tests and SPEC remain byte-identical: no code repair was justified. The existing immutable implementation-built image was revalidated, not rebuilt, with the same 64 module hashes, 26 native groups per backend, seven CLI groups and fixable-critical scan; generation, frozen install, Helm, production audit and workflow lint also pass.

P3.4 code `394792cb474635cc7e466ba1cf77394d24a21c61` is committed and pushed in [PR #31](https://github.com/xenarro/krun/pull/31) against main. [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40246285257) attempt 1 passes all nine required gates, including 1088 TypeScript tests and one Python test, before this P3.4-only PLAN closure. The separate documentation tracking update has its own required pre-commit full check and exact-head hosted verification. At code acceptance PR31 was OPEN/REVIEW_REQUIRED; the independent source reviews do not replace protected-main repository approval. No agent auto-merge, protection bypass, publication or production-use claim is made. Listener/process assembly and complete Phase 3/application end-to-end acceptance remain later PLAN work.

### P3.5 Run cancellation (reviewed source delivery)

`apps/gateway/src/cancel-run-routes.ts` composes real `CancelRun` under the existing scoped public factory. Register `cancelRunRoutes` alongside the other method plugins; this slice does not wire the serving process. Strict declared POST/body/query schemas and `runs:write` authentication apply before mutation. Current stored Function/glob and owner checks preserve generic `RUN_NOT_FOUND` for hidden, missing or wrong-parent Runs, including `-`; admin retains parent correctness. A deleted/not-Ready Function or unsynced informer does not hide stored Runs.

For QUEUED, SCHEDULED or RUNNING, cancellation uses the existing transactional Store CAS with the authenticated key name as event `actor`. The gateway requests CANCELLING but never finalizes the Job or prematurely queues terminal callbacks. Both winning and losing CAS re-read the current authorized row: CANCELLING/CANCELLED return canonical FULL with no duplicate transition; a concurrently SUCCEEDED/FAILED Run returns HTTP 400 `FAILED_PRECONDITION` / `RUN_TERMINAL` and current public `metadata.state`. Actual Store failures remain INTERNAL. D66 records the CAS/re-read decision; there is no new Store API, raw gateway SQL, response synthesized from a stale snapshot, replica-local cancellation lock or timer polling. Successful wildcard audit metadata names the stored Function and Run.

P3.5 local acceptance passes 20 focused handler tests and two actual native CreateRun/GetRun/CancelRun backend matrix tests. Real SQLite CAS interleavings cover scheduler advancement, terminal completion, a peer cancellation and completion after a winning cancellation; every read, update and returned state uses the actual Store. Native SQLite/PostgreSQL exercise all seven states and twenty concurrent cancellation requests per backend with exactly one actor event. Complete unchanged `make check` passes 1110 TypeScript tests and one Python test; the standalone phase gateway gate passes 207 tests. Existing assertions, workers and deadlines remain unchanged under the documented owned two-CPU verifier.

The implementation-built `krun-test-p3-5:local` image passes 38 actual native groups per backend, 65 matching emitted-module hashes, seven CLI groups and fixable-critical scanning as nonroot 65532:65532 under read-only controls. Its native groups retain the prior real Create/Get/List controls and add the full cancellation state matrix, idempotency, twenty-way concurrency, strict validation, ownership/scope, admin actor and stored-resource audit checks. Double generation leaves all four generated artifacts byte-identical; frozen install, Helm, production audit and workflow lint pass. Initial test-fixture event ordering and image-probe layer-exposure errors are retained with their corrected passing runs; neither required a product-code repair or dependency change.

Both independent P3.5 correctness and contracts reviews are complete with no confirmed findings. Exclusive repair/integration revalidation passes 65 focused handler/native/dual-dialect Store-transition tests (20 handler, two native and 43 Store), nine OpenAPI tests, the exact 207-test gateway gate and complete `make check` with 1110 TypeScript tests and one Python test. Reviewed runtime, tests and SPEC remain byte-identical; no code repair was justified. The exact immutable implementation image is revalidated, not rebuilt, because runtime and dependencies are unchanged: 38 native groups per backend, 65 module hashes and seven CLI groups plus scanning pass. Reviewer harness-only failures and corrected controls remain preserved and are not reclassified as product defects.

P3.5 code `46712f2f29448dc324d81ad43d2fbd19deaac148` is committed and pushed in [PR #32](https://github.com/xenarro/krun/pull/32) against its immediate unmerged parent `feat/gateway-run-reads` / [PR #31](https://github.com/xenarro/krun/pull/31). [Exact code-head CI](https://github.com/xenarro/krun/actions/runs/40251974274) attempt 1 passes all nine hosted gates with 1110 TypeScript tests and one Python test before this P3.5-only PLAN closure. The separate documentation tracking update requires its own fresh full pre-commit check and exact-head hosted verification. The initial pre-commit check hit the unchanged PostgreSQL leasing five-second deadline; the original two-backend control and fresh complete unchanged recovery pass. Failed evidence remains retained; no assertion, deadline or worker change or universal timing repair is claimed. At code acceptance PR32 remains OPEN and not merged; parent PR31 remains OPEN / REVIEW_REQUIRED. Source peer reviews do not replace actual protected-main repository approval. No auto-merge, protection bypass, publication or production use occurred. Continue from the current committed verified task lineage, not obsolete main. Result reads, listener/process/scheduler assembly and full Phase 3/application end-to-end acceptance remain later PLAN work.

### P3.6 Run result reads (pushed and verified; not merged)

`apps/gateway/src/run-result-routes.ts` implements real `GetRunResult` through the scoped public factory and Store. Register `runResultRoutes(objectStore?)`; its narrow effectful `presignGet(reference, 300)` port is explicit, optional configuration, not a fake production implementation. Concrete S3 signing/client lifetime remains P6.1. Current stored Function/owner/glob and requested-parent authorization precedes state, result or signing work; missing/hidden/wrong-parent Runs share generic `RUN_NOT_FOUND`. Stored history works without current informer readiness, and wildcard audits name the stored Function/Run.

Terminal inline results return the JSON document itself, not a Run wrapper, with `application/json`; false, zero, empty strings/arrays/objects, own opaque keys and nested nulls survive. FAILED and CANCELLED may retain inline results. D67 uses the existing compiled Zod response serializer explicitly because Fastify otherwise skips it for root strings. Nonterminal state returns `RUN_NOT_TERMINAL` before inspecting an already accepted result; terminal absence returns `RESULT_MISSING`. Reference-only success validates the canonical stored S3 reference, asks the port for a fresh fixed-300-second URL on each request and returns bodyless 307 with exact different-origin HTTP(S) Location and `Cache-Control: no-store`. No proxy, object HEAD or signing URL cache is added; malformed infrastructure state, unavailable configuration and signer/database failures stay generic INTERNAL without private signing data in logs.

Independent review found two native boundary defects, repaired as D69/D70 without changing the public contract. The shared factory now uses Fastify's supported bounded GET parser override so Content-Length and chunked bodies reach the existing strict empty-object policy before handlers/signing; unknown fields, literal null and malformed JSON fail `REQUEST_INVALID`. Omission, JSON-header/zero-length omission and `{}` still work; authentication/scope checks, media-type errors and parser size caps retain their ordering. Permanent SQLite/PostgreSQL socket matrices cover List/Get Functions, List/Get Runs and inline/offloaded GetRunResult, not only the reported route.

Redirect validation now requires an explicitly authority-qualified HTTP(S) target and checks the exact raw Location's base-origin client resolution against standalone parsing. Same-scheme authority-less/single-backslash forms fail generic INTERNAL before setting Location rather than redirecting back into a gateway path. Valid cross-origin signed URLs keep their exact path, percent escapes, duplicate query parameters and query bytes; native manual and automatic-follow controls exercise rejection without application-side object fetching.

Native PostgreSQL acceptance exposed a real inherited result-domain defect: jsonb rejects valid JSON strings containing Unicode NUL. D68 adds forward-only `0003_opaque_results`, changing only PostgreSQL `runs.result` to native json, like opaque input in D64. Both report and terminal-CAS result writers infer that column type and now retain the documented JSON domain. Shipped 0001/0002 and SQLite remain unchanged. Both-dialect regressions cover both write entrypoints; a real two-migration-schema upgrade test checks result/event preservation, injected post-DDL rollback and successful retry. Only exact PostgreSQL migration-history expectations change; there is no sentinel encoding, dependency change or public-value restriction.

Acceptance passes 32 handler tests and two actual native SQLite/PostgreSQL CreateRun/GetRun/GetRunResult matrices, including NUL results, all seven states, all five result branches and explicit credential-free manual follow to an owned fake object-server listener. The fake signer is the boundary PLAN P3.6 explicitly requests; no actual S3 cryptographic signing/expiry claim is made. The 33-test complete Unicode/migration/CLI control slice includes three new shared regressions. Full unchanged `make check` passes 1147 TypeScript tests and one Python test; the exact gateway phase gate passes 241 tests. Existing workers, assertions and deadlines remain unchanged under the documented owned two-CPU verifier.

The newly rebuilt `krun-test-p3-6-repair:local` image passes 137 actual native groups per backend, 67 matching emitted-module hashes, seven CLI groups and fixable-critical scanning as nonroot 65532:65532 under read-only controls. Three additional compatibility groups use the actual previous P3.5 image against the upgraded PostgreSQL schema to verify complete-history handling and NUL-result write/read/terminal preservation. Four generated artifacts remain byte-identical across double generation; frozen install, Helm, production audit, OpenAPI tests and workflow lint pass. Five additional native redirect-image controls verify both ambiguous forms with manual/automatic follow and exact encoded-URL preservation. Original route/result-domain reds, both review reproductions and corrected fixture/lint attempts remain retained.

The source is delivered as `8325f9366d6319c832c9e3f520ffe011de249a20` in [PR #33](https://github.com/xenarro/krun/pull/33), explicitly based on immediate unmerged `feat/gateway-cancel-run`/[PR #32](https://github.com/xenarro/krun/pull/32). [Exact source CI](https://github.com/xenarro/krun/actions/runs/40260319575) passed all nine gates on attempt 1, including 1147 TypeScript tests and one Python test. Both independent review findings are reproduced, repaired and dispositioned by lens; the original reports/evidence remain unchanged, and no reviewer approval of the repaired snapshot is fabricated. P3.6 is closed only after that exact source acceptance; the separate tracking commit receives its own fresh precommit and exact-head hosted checks, recorded in the private delivery report.

This is pushed source, not a merged-main or complete-application claim. PR33 and parent PR32 remain OPEN with their actual empty reviewDecision, and PR31 retains its protected-main independent-review dependency. No stack auto-merge, protection bypass, package publication or tags. Preserve `feat/gateway-run-results` on recovery; P3.7 starts a new typed feature only from the current committed verified lineage after refreshing actual parent/main state. Serving-process/listener wiring, concrete ObjectStore/P6.1 and complete later Phase3/application end-to-end acceptance remain future PLAN work.
