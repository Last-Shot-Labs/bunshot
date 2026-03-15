import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import { addUserRole } from "../../src/lib/roles";
import { bustCache } from "../../src/middleware/cacheResponse";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;

beforeAll(async () => {
  app = await createTestApp();
});

beforeEach(() => {
  clearMemoryStore();
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function registerUser(email = "mw@example.com", password = "password123") {
  const res = await app.request("/auth/register", json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe("requireRole middleware", () => {
  test("returns 401 without auth", async () => {
    const res = await app.request("/protected/admin");
    expect(res.status).toBe(401);
  });

  test("returns 403 without admin role", async () => {
    const { token } = await registerUser();

    const res = await app.request("/protected/admin", { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });

  test("returns 200 with admin role", async () => {
    const { token, userId } = await registerUser();
    await addUserRole(userId, "admin");

    const res = await app.request("/protected/admin", { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("admin only");
  });
});

// ---------------------------------------------------------------------------
// cacheResponse
// ---------------------------------------------------------------------------

describe("cacheResponse middleware", () => {
  test("first request returns x-cache MISS", async () => {
    const res = await app.request("/cached");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("MISS");
  });

  test("second request returns x-cache HIT with same body", async () => {
    const res1 = await app.request("/cached");
    const body1 = await res1.json();

    const res2 = await app.request("/cached");
    expect(res2.headers.get("x-cache")).toBe("HIT");
    const body2 = await res2.json();
    expect(body2.time).toBe(body1.time);
  });

  test("bustCache clears the cache", async () => {
    // Prime the cache
    await app.request("/cached");
    const res1 = await app.request("/cached");
    expect(res1.headers.get("x-cache")).toBe("HIT");

    // Bust it
    await bustCache("test-cached");

    // Should be a MISS now
    const res2 = await app.request("/cached");
    expect(res2.headers.get("x-cache")).toBe("MISS");
  });
});
