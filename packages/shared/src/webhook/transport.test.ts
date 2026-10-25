import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { LookupAddress } from "node:dns";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, getCACertificates, setDefaultCACertificates } from "node:tls";
import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import ipaddr from "ipaddr.js";
import { describe, expect, it, vi } from "vitest";
import {
  DnsLookup,
  makeWebhookPolicy,
  postWebhook,
  sign,
  type WebhookHeaders,
  type WebhookSigningError,
  WebhookTransportError,
} from "./index.js";

const body = new TextEncoder().encode(
  '{"name":"functions/test/runs/019a1c11-5c2e-7a3b-8d4f-0e1f2a3b4c5d","result": "é"}\n',
);
const listen = (server: Server, hostname = "127.0.0.1") =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("Missing test receiver port"));
      else resolve(address.port);
    });
  });
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
const policy = () =>
  makeWebhookPolicy({
    KRUN_WEBHOOK_ALLOWED_HOSTS: ["*.krun-test.invalid"],
    KRUN_WEBHOOK_ALLOWED_CIDRS: [ipaddr.parseCIDR("127.0.0.0/8")],
  });
const lookup = (get: () => readonly LookupAddress[]) =>
  Layer.succeed(DnsLookup, { lookup: () => Effect.sync(get) });
const headers = (): Effect.Effect<WebhookHeaders, WebhookSigningError> =>
  Effect.map(sign(body, [randomBytes(32).toString("base64")]), (signature) => ({
    deliveryId: "019a1c11-5c2e-7a3b-8d4f-0e1f2a3b4c5d",
    runId: "019a1c11-5c2e-7a3b-8d4f-0e1f2a3b4c5e",
    signature,
  }));

describe("actual pinned webhook HTTP and TLS sockets", () => {
  it("dials only the checked address, retains Host/raw bytes and resolves again before a second attempt", async () => {
    let hits = 0;
    let host = "";
    let path = "";
    let raw = Buffer.alloc(0);
    let contentType = "";
    let calls = 0;
    const server = createServer((req, res) => {
      hits++;
      host = req.headers.host ?? "";
      path = req.url ?? "";
      contentType = String(req.headers["content-type"]);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        raw = Buffer.concat(chunks);
        res.writeHead(204).end();
      });
    });
    const port = await listen(server);
    const fallback = vi.spyOn(dns, "lookup").mockImplementation(() => {
      throw new Error("Unexpected unpinned OS resolver");
    });
    try {
      const cfg = await Effect.runPromise(policy());
      const h = await Effect.runPromise(headers());
      const layer = lookup(() => [
        { address: ++calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 },
      ]);
      const url = `http://receiver.krun-test.invalid:${port}/%2f?input=%41`;
      expect(
        await Effect.runPromise(postWebhook(url, cfg, body, h).pipe(Effect.provide(layer))),
      ).toBe(204);
      expect(
        await Effect.runPromise(
          Effect.flip(postWebhook(url, cfg, body, h)).pipe(Effect.provide(layer)),
        ),
      ).toMatchObject({ _tag: "CallbackNotAllowed", reason: "address" });
      expect(hits).toBe(1);
      expect(calls).toBe(2);
      expect(raw.equals(Buffer.from(body))).toBe(true);
      expect(host).toBe(`receiver.krun-test.invalid:${port}`);
      expect(path).toBe("/%2f?input=%41");
      expect(contentType).toBe("application/json");
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
      await close(server);
    }
  });

  it("pins native IPv6 TCP sockets without using the OS resolver", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(204).end();
    });
    const port = await listen(server, "::1");
    const fallback = vi.spyOn(dns, "lookup").mockImplementation(() => {
      throw new Error("Unexpected OS lookup");
    });
    try {
      const cfg = await Effect.runPromise(
        makeWebhookPolicy({
          KRUN_WEBHOOK_ALLOWED_HOSTS: ["*.krun-test.invalid"],
          KRUN_WEBHOOK_ALLOWED_CIDRS: [ipaddr.parseCIDR("::1/128")],
        }),
      );
      const h = await Effect.runPromise(headers());
      expect(
        await Effect.runPromise(
          postWebhook(`http://ipv6.krun-test.invalid:${port}/`, cfg, body, h).pipe(
            Effect.provide(lookup(() => [{ address: "::1", family: 6 }])),
          ),
        ),
      ).toBe(204);
      expect(hits).toBe(1);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
      await close(server);
    }
  });

  it("explicitly allowed mapped IP literals dial the same checked IPv4 address without DNS", async () => {
    let hits = 0;
    let calls = 0;
    const server = createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(204).end();
    });
    const port = await listen(server);
    try {
      const cfg = await Effect.runPromise(
        makeWebhookPolicy({
          KRUN_WEBHOOK_ALLOWED_HOSTS: ["*"],
          KRUN_WEBHOOK_ALLOWED_CIDRS: [ipaddr.parseCIDR("127.0.0.0/8")],
        }),
      );
      const h = await Effect.runPromise(headers());
      expect(
        await Effect.runPromise(
          postWebhook(`http://[::ffff:127.0.0.1]:${port}/`, cfg, body, h).pipe(
            Effect.provide(
              lookup(() => {
                calls++;
                return [];
              }),
            ),
          ),
        ),
      ).toBe(204);
      expect(hits).toBe(1);
      expect(calls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("copies outgoing bytes before resolution and does not allow overriding authority headers", async () => {
    let raw = Buffer.alloc(0);
    let signaturePresent = false;
    let tracePresent = false;
    let calls = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        raw = Buffer.concat(chunks);
        signaturePresent = typeof req.headers["x-krun-signature"] === "string";
        tracePresent =
          req.headers.traceparent === "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
        res.writeHead(204).end();
      });
    });
    const port = await listen(server);
    try {
      const cfg = await Effect.runPromise(policy());
      const h = {
        ...(await Effect.runPromise(headers())),
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      };
      const outgoing = Buffer.from(body);
      const layer = lookup(() => {
        calls++;
        outgoing.fill(0);
        return [{ address: "127.0.0.1", family: 4 }];
      });
      const url = `http://receiver.krun-test.invalid:${port}/`;
      expect(
        await Effect.runPromise(postWebhook(url, cfg, outgoing, h).pipe(Effect.provide(layer))),
      ).toBe(204);
      expect(raw.equals(Buffer.from(body))).toBe(true);
      expect(signaturePresent && tracePresent).toBe(true);
      const invalidHeaders = { ...h, host: "evil.invalid" };
      const error = await Effect.runPromise(
        Effect.flip(postWebhook(url, cfg, body, invalidHeaders)).pipe(Effect.provide(layer)),
      );
      expect(error).toMatchObject({ _tag: "WebhookTransportError", reason: "headers" });
      expect(calls).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("never follows a redirect even when its destination would be reachable", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.writeHead(200).end();
    });
    const targetPort = await listen(target);
    let redirectHits = 0;
    const source = createServer((_req, res) => {
      redirectHits++;
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/private` }).end();
    });
    const port = await listen(source);
    try {
      const cfg = await Effect.runPromise(policy());
      const h = await Effect.runPromise(headers());
      const error = await Effect.runPromise(
        Effect.flip(postWebhook(`http://receiver.krun-test.invalid:${port}/`, cfg, body, h)).pipe(
          Effect.provide(lookup(() => [{ address: "127.0.0.1", family: 4 }])),
        ),
      );
      expect(error).toBeInstanceOf(WebhookTransportError);
      expect(error).toMatchObject({ _tag: "WebhookTransportError", reason: "status", status: 302 });
      expect(redirectHits).toBe(1);
      expect(targetHits).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  });

  it("retains SNI and certificate identity for the original DNS host; rejects a mismatched certificate", async () => {
    const scratch = tmpdir();
    const dir = mkdtempSync(join(scratch, "krun-test-p2-1-tls-"));
    const defaults = getCACertificates("default");
    let server: ReturnType<typeof createHttpsServer> | undefined;
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-subj",
          "/CN=receiver.krun-test.invalid",
          "-addext",
          "subjectAltName=DNS:receiver.krun-test.invalid",
          "-days",
          "1",
        ],
        { stdio: "ignore" },
      );
      const key = readFileSync(join(dir, "key.pem"));
      const cert = readFileSync(join(dir, "cert.pem"));
      const context = createSecureContext({ key, cert });
      let servername = "";
      let host = "";
      let hits = 0;
      server = createHttpsServer(
        {
          key,
          cert,
          SNICallback: (name, callback) => {
            servername = name;
            callback(null, context);
          },
        },
        (req, res) => {
          hits++;
          host = req.headers.host ?? "";
          req.resume();
          res.writeHead(204).end();
        },
      );
      server.on("tlsClientError", () => {});
      const port = await listen(server);
      setDefaultCACertificates([...defaults, cert.toString("utf8")]);
      const cfg = await Effect.runPromise(policy());
      const h = await Effect.runPromise(headers());
      const layer = lookup(() => [{ address: "127.0.0.1", family: 4 }]);
      expect(
        await Effect.runPromise(
          postWebhook(`https://receiver.krun-test.invalid:${port}/`, cfg, body, h).pipe(
            Effect.provide(layer),
          ),
        ),
      ).toBe(204);
      expect(servername).toBe("receiver.krun-test.invalid");
      expect(host).toBe(`receiver.krun-test.invalid:${port}`);
      const error = await Effect.runPromise(
        Effect.flip(postWebhook(`https://wrong.krun-test.invalid:${port}/`, cfg, body, h)).pipe(
          Effect.provide(layer),
        ),
      );
      expect(error).toMatchObject({ _tag: "WebhookTransportError", reason: "request" });
      expect(hits).toBe(1);
    } finally {
      setDefaultCACertificates(defaults);
      if (server?.listening) await close(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupting an active request closes the owned connection before returning", async () => {
    const started = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const server = createServer((req) => {
      req.resume();
      req.socket.once("close", () => disconnected.resolve());
      started.resolve();
    });
    const port = await listen(server);
    try {
      const cfg = await Effect.runPromise(policy());
      const h = await Effect.runPromise(headers());
      const fiber = Effect.runFork(
        postWebhook(`http://receiver.krun-test.invalid:${port}/`, cfg, body, h).pipe(
          Effect.provide(lookup(() => [{ address: "127.0.0.1", family: 4 }])),
        ),
      );
      await started.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      await disconnected.promise;
      expect(server.listening).toBe(true);
    } finally {
      await close(server);
    }
  });

  effectIt.effect("ten-second timeout aborts an active native HTTP socket", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const server = createServer((req) => {
        req.resume();
        req.socket.once("close", () => disconnected.resolve());
        started.resolve();
      });
      const port = yield* Effect.acquireRelease(
        Effect.promise(() => listen(server)),
        () => Effect.promise(() => close(server)),
      );
      const cfg = yield* policy();
      const h = yield* headers();
      const fiber = yield* Effect.forkChild(
        Effect.flip(postWebhook(`http://receiver.krun-test.invalid:${port}/`, cfg, body, h)).pipe(
          Effect.provide(lookup(() => [{ address: "127.0.0.1", family: 4 }])),
        ),
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "WebhookTransportError",
        reason: "timeout",
      });
      yield* Effect.promise(() => disconnected.promise);
    }),
  );

  effectIt.effect("the whole attempt including DNS is bounded by ten seconds", () =>
    Effect.gen(function* () {
      const cfg = yield* policy();
      const h = yield* headers();
      const fiber = yield* Effect.forkChild(
        Effect.flip(postWebhook("http://receiver.krun-test.invalid/", cfg, body, h)).pipe(
          Effect.provide(Layer.succeed(DnsLookup, { lookup: () => Effect.never })),
        ),
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "WebhookTransportError",
        reason: "timeout",
      });
    }),
  );
});
