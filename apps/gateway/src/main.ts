import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

NodeRuntime.runMain(Effect.sync(() => console.log("gateway")));
