import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import { requestId } from "./http.js";

it.each([
  undefined,
  "",
  "x".repeat(129),
  "invalid\r\nvalue",
  "invalid\u0000value",
  "outside-\u0100",
  "pair-🍓",
])("replaces absent,oversized or non-wire request IDs without echoing unsafe values", (value) => {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.headers = value === undefined ? {} : { "x-request-id": value };
  request.rawHeaders = value === undefined ? [] : ["X-Request-Id", value];
  try {
    const id = requestId(request, 1000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(1000);
  } finally {
    socket.destroy();
  }
});
it.each(["single", "x".repeat(128), "comma,value", "opaque\tvalue", "latin-\u00e9"])(
  "preserves a single legal opaque ID exactly",
  (value) => {
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.headers = { "x-request-id": value };
    request.rawHeaders = ["x-request-id", value];
    try {
      expect(requestId(request, 1000)).toBe(value);
    } finally {
      socket.destroy();
    }
  },
);
