import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import { getDb } from "../../src/adapters/sqliteAuth";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;
const captured: { email: string; token: string }[] = [];

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
      emailVerification: {
        onSend: async (email, token) => {
          captured.push({ email, token });
        },
        required: true,
        tokenExpiry: 300,
      },
    },
  });
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM users");
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM email_verifications");
  clearMemoryStore();
  captured.length = 0;
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("SQLite email verification", () => {
  test("register triggers verification email", async () => {
    const res = await app.request("/auth/register", json({ email: "ev@example.com", password: "password123" }));
    expect(res.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0].email).toBe("ev@example.com");
    expect(captured[0].token).toBeString();
  });

  test("login before verification returns 403", async () => {
    await app.request("/auth/register", json({ email: "ev2@example.com", password: "password123" }));
    const res = await app.request("/auth/login", json({ email: "ev2@example.com", password: "password123" }));
    expect(res.status).toBe(403);
  });

  test("verify with valid token succeeds", async () => {
    await app.request("/auth/register", json({ email: "ev3@example.com", password: "password123" }));
    const token = captured[0].token;

    const res = await app.request("/auth/verify-email", json({ token }));
    expect(res.status).toBe(200);
  });

  test("login after verification succeeds", async () => {
    await app.request("/auth/register", json({ email: "ev4@example.com", password: "password123" }));
    await app.request("/auth/verify-email", json({ token: captured[0].token }));

    const res = await app.request("/auth/login", json({ email: "ev4@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test("resend verification sends new token", async () => {
    const reg = await app.request("/auth/register", json({ email: "ev5@example.com", password: "password123" }));
    const { token } = await reg.json();
    captured.length = 0;

    const res = await app.request("/auth/resend-verification", {
      method: "POST",
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });
});
