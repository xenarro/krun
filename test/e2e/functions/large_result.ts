import { largeResult } from "../lib/large-result.ts";

// This is author code, not the scheduler: only the per-Run token and signed PUT
// capability enter its environment. No S3 account credentials or inline result.
try {
  const base = `${process.env.KRUN_GATEWAY_URL}/internal/v1/runs/${process.env.KRUN_RUN_ID}`;
  const input = await fetch(`${base}/input`, {
    headers: { authorization: `Bearer ${process.env.KRUN_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!input.ok || !process.env.KRUN_RESULT_UPLOAD_URL) throw new Error("Input or PUT unavailable");
  const uploaded = await fetch(process.env.KRUN_RESULT_UPLOAD_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: largeResult(await input.json()),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await uploaded.arrayBuffer();
  if (!uploaded.ok) throw new Error("Native upload rejected");
} catch {
  // URLs, input, credentials and HTTP bodies must not enter container logs.
  process.stderr.write("Native large-result function failed\n");
  process.exitCode = 1;
}
