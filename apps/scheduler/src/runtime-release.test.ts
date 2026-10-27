import { expect, it } from "@effect/vitest";
import { Readiness } from "@krun/shared/dist/health/readiness.js";
import { Effect, Exit, Ref } from "effect";
import { runLeaderElection } from "./k8s/leader-election.js";
import { LeaseApi } from "./k8s/lease-api.js";

it.effect(
  "process Function cleanup precedes Lease release even when elected work is interrupted before startup",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const podName = "krun-test-p411-pod";
      let holder = "";
      const state = yield* Ref.make({
        ready: true,
        functionsSynced: true,
        draining: false,
        leader: false,
      });
      const api = LeaseApi.of({
        read: () =>
          Effect.succeed({ metadata: { resourceVersion: "1" }, spec: { holderIdentity: holder } }),
        create: (_namespace, body) => Effect.succeed(body),
        replace: (_namespace, body) =>
          Effect.sync(() => {
            holder = body.spec?.holderIdentity ?? "";
            events.push(holder ? "acquired" : "released");
            return body;
          }),
      });
      const exit = yield* Effect.exit(
        runLeaderElection(
          { namespace: "krun-test-p411", podName },
          // There is no entered leader-work finalizer to stop the process informer.
          Effect.interrupt,
          Effect.sync(() => {
            events.push("functions-stopped");
          }),
        ).pipe(
          Effect.provideService(LeaseApi, api),
          Effect.provideService(Readiness, {
            state,
            check: Effect.succeed({ status: "ok", leader: false }),
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(events).toEqual(["acquired", "functions-stopped", "released"]);
    }),
);
