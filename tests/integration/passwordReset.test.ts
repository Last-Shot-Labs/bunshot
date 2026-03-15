import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore } from "../setup";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;
let capturedResetToken: string | undefined;
let resolveToken: (token: string) => void;
let tokenPromise: Promise<string>;

beforeAll(async () => {
  app = await createTestApp({
    auth: {
      enabled: true,
      roles: ["admin", "user"],
      defaultRole: "user",
      passwordReset: {
        onSend: async (_email, token) => {
          capturedResetToken = token;
          resolveToken(token);
        },
      },
    },
  });
});

beforeEach(() => {
  clearMemoryStore();
  capturedResetToken = undefined;
  tokenPromise = new Promise<string>((r) => {
    resolveToken = r;
  });
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Forgot Password
// ---------------------------------------------------------------------------

describe("POST /auth/forgot-password", () => {
  test("returns 200 for registered email and sends token", async () => {
    await app.request("/auth/register", json({ email: "reset@example.com", password: "password123" }));

    const res = await app.request("/auth/forgot-password", json({ email: "reset@example.com" }));
    expect(res.status).toBe(200);

    // Wait for fire-and-forget to complete
    await tokenPromise;
    expect(capturedResetToken).toBeString();
  });

  test("returns 200 for non-existent email without sending token", async () => {
    const res = await app.request("/auth/forgot-password", json({ email: "nobody@example.com" }));
    expect(res.status).toBe(200);

    // Give microtask a chance — token should remain undefined
    await Bun.sleep(50);
    expect(capturedResetToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reset Password Flow
// ---------------------------------------------------------------------------

describe("password reset flow", () => {
  test("reset-password changes password", async () => {
    await app.request("/auth/register", json({ email: "flow@example.com", password: "password123" }));
    await app.request("/auth/forgot-password", json({ email: "flow@example.com" }));
    const token = await tokenPromise;

    const res = await app.request("/auth/reset-password", json({ token, password: "newpass12345" }));
    expect(res.status).toBe(200);
  });

  test("login with new password succeeds", async () => {
    await app.request("/auth/register", json({ email: "newpw@example.com", password: "password123" }));
    await app.request("/auth/forgot-password", json({ email: "newpw@example.com" }));
    const token = await tokenPromise;

    await app.request("/auth/reset-password", json({ token, password: "newpass12345" }));

    const loginRes = await app.request("/auth/login", json({ email: "newpw@example.com", password: "newpass12345" }));
    expect(loginRes.status).toBe(200);
  });

  test("login with old password fails after reset", async () => {
    await app.request("/auth/register", json({ email: "oldpw@example.com", password: "password123" }));
    await app.request("/auth/forgot-password", json({ email: "oldpw@example.com" }));
    const token = await tokenPromise;

    await app.request("/auth/reset-password", json({ token, password: "newpass12345" }));

    const loginRes = await app.request("/auth/login", json({ email: "oldpw@example.com", password: "password123" }));
    expect(loginRes.status).toBe(401);
  });

  test("reset token is single-use", async () => {
    await app.request("/auth/register", json({ email: "single@example.com", password: "password123" }));
    await app.request("/auth/forgot-password", json({ email: "single@example.com" }));
    const token = await tokenPromise;

    await app.request("/auth/reset-password", json({ token, password: "newpass12345" }));

    const res = await app.request("/auth/reset-password", json({ token, password: "anotherpass123" }));
    expect(res.status).toBe(400);
  });
});
