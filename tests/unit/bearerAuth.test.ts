import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { bearerAuth } from "../../src/middleware/bearerAuth";

const app = new Hono();
app.use("/protected/*", bearerAuth);
app.get("/protected/data", (c) => c.json({ ok: true }));

describe("bearerAuth middleware", () => {
  test("valid bearer token passes", async () => {
    const res = await app.request("/protected/data", {
      headers: { Authorization: "Bearer test-bearer-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("invalid token returns 401", async () => {
    const res = await app.request("/protected/data", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("missing Authorization header returns 401", async () => {
    const res = await app.request("/protected/data");
    expect(res.status).toBe(401);
  });

  test("malformed header without Bearer prefix returns 401", async () => {
    const res = await app.request("/protected/data", {
      headers: { Authorization: "Token test-bearer-token" },
    });
    expect(res.status).toBe(401);
  });
});
