import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicSchemas } from "../../../apps/gateway/src/public-contracts.js";

type Receipt = Readonly<{
  deliveryId: string;
  runId: string;
  timestamp: number;
  v1Count: number;
  valid: boolean;
  sameBody: boolean;
  responseStatus: number;
  traceparent: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const trace = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

// Test receiver only. Do not reuse the sender's signer: independently verify
// exact incoming bytes with both rotation keys, retaining sanitized verdicts only.
export const makeWebhookReceiver = (
  secrets: readonly [string, string],
  expectedFunction: string,
  nowMillis = () => performance.timeOrigin + performance.now(),
) => {
  const receipts: Receipt[] = [];
  let firstBody: Buffer | undefined;
  let verified = 0;
  const snapshot = () => receipts.map((receipt) => ({ ...receipt }));
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/healthz") {
      response.end("ok");
      return;
    }
    if (request.method === "GET" && path === "/observations") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (request.method !== "POST" || path !== "/hook") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("error", () => response.destroy());
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const signature = request.headers["x-krun-signature"];
      const parts = typeof signature === "string" ? signature.split(",") : [];
      const times = parts.filter((part) => /^t=\d+$/.test(part));
      const timestamp = Number(times[0]?.slice(2));
      const digests = parts.filter((part) => /^v1=[a-f0-9]{64}$/.test(part));
      const signed =
        times.length === 1 &&
        Number.isSafeInteger(timestamp) &&
        Math.abs(Math.floor(nowMillis() / 1000) - timestamp) <= 300 &&
        parts.length === 3 &&
        digests.length === 2 &&
        secrets.every((secret) => {
          const expected = createHmac("sha256", secret)
            .update(`${timestamp}.`)
            .update(bytes)
            .digest();
          return digests.some((part) =>
            timingSafeEqual(Buffer.from(part.slice(3), "hex"), expected),
          );
        });
      const deliveryHeader = request.headers["x-krun-delivery"];
      const runHeader = request.headers["x-krun-run-id"];
      const deliveryId =
        typeof deliveryHeader === "string" && uuid.test(deliveryHeader) ? deliveryHeader : "";
      const runId = typeof runHeader === "string" && uuid.test(runHeader) ? runHeader : "";
      let basic = false;
      try {
        const body = publicSchemas.RunSummary.safeParse(JSON.parse(bytes.toString("utf8")));
        basic =
          body.success &&
          body.data.state === "SUCCEEDED" &&
          body.data.name === `functions/${expectedFunction}/runs/${runId}`;
      } catch {
        // No raw body, URL, key, signature or native error reaches diagnostics.
      }
      const valid =
        signed &&
        basic &&
        Boolean(deliveryId && runId) &&
        request.headers["content-type"] === "application/json";
      if (valid) verified++;
      const responseStatus = valid ? (verified === 1 ? 500 : 200) : 401;
      const context = request.headers.traceparent;
      receipts.push({
        deliveryId,
        runId,
        timestamp: Number.isSafeInteger(timestamp) ? timestamp : 0,
        v1Count: digests.length,
        valid,
        sameBody: firstBody === undefined || firstBody.equals(bytes),
        responseStatus,
        traceparent: typeof context === "string" && trace.test(context) ? context : "",
      });
      firstBody ??= bytes;
      response.writeHead(responseStatus).end();
    });
  });
  return { server, snapshot };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receiver = makeWebhookReceiver(
      [readFileSync("/keys/current", "utf8"), readFileSync("/keys/previous", "utf8")],
      process.env.KRUN_TEST_FUNCTION ?? "",
    );
    receiver.server.on("error", () => {
      console.error("Owned webhook receiver listener failed; private diagnostics withheld");
      process.exitCode = 1;
    });
    receiver.server.listen(8080, "0.0.0.0");
    process.once("SIGTERM", () => {
      receiver.server.closeAllConnections();
      receiver.server.close();
    });
  } catch {
    console.error("Owned webhook receiver startup failed; private diagnostics withheld");
    process.exitCode = 1;
  }
}
