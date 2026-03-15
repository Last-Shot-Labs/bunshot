import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import { getDb } from "../../src/adapters/sqliteAuth";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;

beforeAll(async () => {
  app = await createTestApp({
    db: {
      mongo: false,
      redis: false,
      sessions: "sqlite",
      cache: "sqlite",
      auth: "sqlite",
      sqlite: ":memory:",
    },
    auth: {
      enabled: true,
      roles: ["admin", "user"],
      defaultRole: "user",
      refreshTokens: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 2,
      },
    },
  });
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM users");
  db.run("DELETE FROM sessions");
  clearMemoryStore();
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("SQLite refresh tokens", () => {
  test("register returns refreshToken", async () => {
    const res = await app.request("/auth/register", json({ email: "rt@example.com", password: "password123" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.refreshToken).toBeString();
  });

  test("POST /auth/refresh rotates tokens", async () => {
    const reg = await app.request("/auth/register", json({ email: "rt2@example.com", password: "password123" }));
    const { refreshToken } = await reg.json();

    const res = await app.request("/auth/refresh", json({ refreshToken }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.refreshToken).toBeString();
    expect(body.refreshToken).not.toBe(refreshToken);
  });

  test("grace window: old refresh token still works within window", async () => {
    const reg = await app.request("/auth/register", json({ email: "rt3@example.com", password: "password123" }));
    const { refreshToken } = await reg.json();

    // Rotate
    const r1 = await app.request("/auth/refresh", json({ refreshToken }));
    expect(r1.status).toBe(200);

    // Old token should still work within grace window
    const r2 = await app.request("/auth/refresh", json({ refreshToken }));
    expect(r2.status).toBe(200);
  });

  test("theft detection: old token after grace window invalidates session", async () => {
    const reg = await app.request("/auth/register", json({ email: "rt4@example.com", password: "password123" }));
    const { refreshToken } = await reg.json();

    // Rotate
    await app.request("/auth/refresh", json({ refreshToken }));

    // Wait for grace window to expire
    await Bun.sleep(2100);

    // Old token should now fail and invalidate session
    const res = await app.request("/auth/refresh", json({ refreshToken }));
    expect(res.status).toBe(401);
  });

  test("invalid refresh token returns 401", async () => {
    const res = await app.request("/auth/refresh", json({ refreshToken: "invalid-token" }));
    expect(res.status).toBe(401);
  });
});
