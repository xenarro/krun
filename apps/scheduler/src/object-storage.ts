import type { ObjectStore } from "@krun/shared/dist/objstore/index.js";
import type { Run } from "@krun/shared/dist/store/index.js";
import { Effect } from "effect";
import { ResultCheckError } from "./job-controller.js";

/** The controller calls this only on Complete, before the terminal CAS. */
export const checkObjectResult =
  (objectStore: ObjectStore["Service"] | undefined) =>
  (run: Run): Effect.Effect<string | null, ResultCheckError> =>
    objectStore === undefined || run.result !== null
      ? Effect.succeed(null)
      : objectStore.exists(run.id).pipe(
          Effect.map((exists) => (exists ? objectStore.ref(run.id) : null)),
          Effect.mapError(() => new ResultCheckError({ reason: "request_failed" })),
        );
