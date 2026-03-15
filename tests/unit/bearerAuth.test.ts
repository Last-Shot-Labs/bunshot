import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore } from "../setup";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;

beforeAll(async () => {
  app = await createTestApp({
    security: {
      bearerAuth: true,
      rateLimit: { windowMs: 60_000, max: 1000 },
    },
    auth: { enabled: false },
  });
});

beforeEach(() => {
  clearMemoryStore();
});

describe("bearerAuth middleware", () => {
  test("valid bearer token passes", async () => {
    const res = await app.request("/cached", {
      headers: { Authorization: "Bearer test-bearer-token" },
    });
    expect(res.status).toBe(200);
  });

  test("invalid token returns 401", async () => {
    const res = await app.request("/cached", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("missing Authorization header returns 401", async () => {
    const res = await app.request("/cached");
    expect(res.status).toBe(401);
  });

  test("malformed header without Bearer prefix returns 401", async () => {
    const res = await app.request("/cached", {
      headers: { Authorization: "Token test-bearer-token" },
    });
    expect(res.status).toBe(401);
  });
});
