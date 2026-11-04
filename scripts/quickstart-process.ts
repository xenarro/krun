import type { ChildProcess } from "node:child_process";

export const stopForward = async (child: ChildProcess, graceMs = 1000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(escalation);
      clearTimeout(deadline);
      child.removeListener("exit", exited);
      child.removeListener("error", errored);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => finish();
    const errored = () =>
      finish(child.pid === undefined ? undefined : new Error("Forward shutdown failed"));
    child.once("exit", exited);
    child.once("error", errored);
    escalation = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish(new Error("Forward shutdown failed"));
        return;
      }
      deadline = setTimeout(() => finish(new Error("Forward shutdown did not join")), graceMs);
    }, graceMs);
    try {
      child.kill("SIGTERM");
    } catch {
      finish(new Error("Forward shutdown failed"));
    }
  });
};

export const cleanupAfterForward = async (
  child: ChildProcess | undefined,
  cleanup: () => Promise<void>,
) => {
  let failed = false;
  try {
    if (child) await stopForward(child);
  } catch {
    failed = true;
  } finally {
    await cleanup();
  }
  if (failed) throw new Error("Forward shutdown failed; remaining cleanup attempted");
};
