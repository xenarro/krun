# Lessons from KEDA, Knative and Dapr

Citations are `repo path:line` at the pinned commits the krun-* research
used; the reports live outside the repository. Each bullet ends with the
krun form of the lesson.

- Ordered want-lists with induced failures: each table row declares
  initial objects, the key, and the exact `wantCreates/wantDeletes/
  wantPatches`; `induceFailure("create", "jobs")` returns a deterministic
  error the assertion embeds verbatim (knative-serving
  `vendor/knative.dev/pkg/reconciler/testing/table.go:44-113`,
  `pkg/reconciler/revision/table_test.go:62-135`). krun: the fake `Kube`
  layer rows in `fake-kube.md` part 1.
- A fixed clock: "we don't care about the value, but that it does not
  change, since it leads to flakes" (knative-serving `table_test.go:130-133`).
  krun: `TestClock.setTime(FIXED_EPOCH)` at the top of every row.
- Tri-state polling predicate `(done, err)`: `Ready=False` with the current
  generation fails immediately with reason and message (knative-serving
  `test/v1/revision.go:33-86`). krun: `eventually` in `kind-recipe.md`.
- HA test: scale to 2, delete the Lease holder pod, assert a queued run
  still gets exactly one Job within lease + retry (knative-serving
  `test/ha/controller_test.go:48-76`). krun: P7.6 `leader_election.e2e.ts`.
- Deadline propagation is asserted on the fake: the recorded call carries
  `now + timeout` (keda `pkg/scaling/executor/scale_jobs_test.go:479-534`).
  krun: a fake `Kube` call that never answers, `TestClock.adjust("10
  seconds")`, then assert the timeout failure and that the slot was freed
  (P4.3a).
- `eventually` remembers a thrown read and keeps polling; the final error
  shows the last throw; `WaitForAllJobsSuccess` requires `len > 0` (keda
  `tests/helper/helper.go:304-386,1348-1423`). krun: SKILL.md rules 11-12.
- One namespace per e2e file labelled for a global sweep, bounded retries
  with retry counts recorded, krun logs dumped on failure (keda
  `tests/run-all.go:28-34,302-330`). krun: e2e harness `retry: 1` and
  `onTestFailed` dumps.
- CLI tests run the real command with injected deps from a scrubbed temp
  dir: clear `KRUN_*` from a copied env, pass `env` explicitly, read
  `function.yaml` back from disk (knative-func `pkg/testing/testing.go:
  332-385`, `cmd/deploy_test.go:1287-1333`). krun: P2.5, P8.4, P8.7.
- e2e drives the real binary with `child_process.spawn`, echoes each
  command, polls 5 s up to 2 min, warns after 30 s at most every 10 s,
  stops on 5xx; an update test proves the digest changed (knative-func
  `e2e/e2e_test.go:592-619,803-863`, `e2e/e2e_core_test.go:164-206`).
  krun: `deploy_update.e2e.ts`.
- Process-level integration: start the real process, poll TCP then the
  health route, assert log lines and the exit code on SIGTERM, drain pipes
  before asserting (dapr `tests/integration/framework/process/exec/
  exec.go:159-236`, `daprd.go:256-307`). krun: P3.7 and P4.11 against
  `test/fake-kube`.
- A fake kube-apiserver streams one chunked watch response per watcher;
  "one event per connection" cost seconds per event via reflector backoff
  (dapr `tests/integration/framework/process/kubernetes/informer/
  informer.go:34-70`). krun: `test/fake-kube` watch streaming.
- Fake clocks: wait for the timer to be registered before stepping (dapr
  `pkg/apphealth/health_test.go:135-145`). krun: fork the loop and let it
  reach its first sleep (`Effect.yieldNow`) before the first
  `TestClock.adjust`.
