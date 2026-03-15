// :memory: is connection-scoped; tests must run serially (Bun's default).
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
  });
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM users");
  db.run("DELETE FROM sessions");
  clearMemoryStore(); // rate limits use memory store
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// SQLite Adapter Parity Tests
// ---------------------------------------------------------------------------

describe("SQLite adapter", () => {
  test("register creates user and returns token", async () => {
    const res = await app.request("/auth/register", json({ email: "sq@example.com", password: "password123" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test("login with valid credentials", async () => {
    await app.request("/auth/register", json({ email: "sqlogin@example.com", password: "password123" }));

    const res = await app.request("/auth/login", json({ email: "sqlogin@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test("login rejects invalid password", async () => {
    await app.request("/auth/register", json({ email: "sqbad@example.com", password: "password123" }));

    const res = await app.request("/auth/login", json({ email: "sqbad@example.com", password: "wrongpassword" }));
    expect(res.status).toBe(401);
  });

  test("session listing works", async () => {
    const regRes = await app.request("/auth/register", json({ email: "sqsess@example.com", password: "password123" }));
    const { token } = await regRes.json();

    const res = await app.request("/auth/sessions", { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(1);
  });

  test("logout invalidates session", async () => {
    const regRes = await app.request("/auth/register", json({ email: "sqout@example.com", password: "password123" }));
    const { token } = await regRes.json();

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: authHeader(token),
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await app.request("/auth/me", { headers: authHeader(token) });
    expect(meRes.status).toBe(401);
  });
});
