import { afterEach, beforeEach, it } from "vitest";
import { scenario } from "./lib/harness.js";

let h: ReturnType<typeof scenario>;
beforeEach(async () => {
  h = scenario("security");
  await h.up();
});
afterEach(() => h.close());
it("enforces Pod, network, token, Function, principal and callback security boundaries", async () => {
  await h.security();
  await h.privacy();
});
