import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono<any>;
let capturedToken: string | undefined;

const onSend = async (_email: string, token: string) => {
  capturedToken = token;
};

beforeAll(async () => {
  // Create the required app last so the global config has required: true
  app = await createTestApp({
    auth: {
      enabled: true,
      roles: ["admin", "user"],
      defaultRole: "user",
      emailVerification: { required: true, onSend },
    },
  });
});

beforeEach(() => {
  clearMemoryStore();
  capturedToken = undefined;
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Email Verification (required: true)
// ---------------------------------------------------------------------------

describe("email verification (required)", () => {
  test("register triggers onSend with verification token", async () => {
    await app.request("/auth/register", json({ email: "verify@example.com", password: "password123" }));
    expect(capturedToken).toBeString();
  });

  test("login blocked when email not verified", async () => {
    await app.request("/auth/register", json({ email: "blocked@example.com", password: "password123" }));

    const res = await app.request("/auth/login", json({ email: "blocked@example.com", password: "password123" }));
    expect(res.status).toBe(403);
  });

  test("verify-email succeeds with valid token", async () => {
    await app.request("/auth/register", json({ email: "tok@example.com", password: "password123" }));
    const token = capturedToken!;

    const res = await app.request("/auth/verify-email", json({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Email verified");
  });

  test("login succeeds after verification", async () => {
    await app.request("/auth/register", json({ email: "success@example.com", password: "password123" }));
    await app.request("/auth/verify-email", json({ token: capturedToken! }));

    const res = await app.request("/auth/login", json({ email: "success@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test("resend-verification sends new token", async () => {
    await app.request("/auth/register", json({ email: "resend@example.com", password: "password123" }));
    const firstToken = capturedToken!;

    const res = await app.request("/auth/resend-verification", json({ email: "resend@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    expect(capturedToken).toBeString();
    expect(capturedToken).not.toBe(firstToken);
  });

  test("resend returns 400 when already verified", async () => {
    await app.request("/auth/register", json({ email: "already@example.com", password: "password123" }));
    await app.request("/auth/verify-email", json({ token: capturedToken! }));

    const res = await app.request("/auth/resend-verification", json({ email: "already@example.com", password: "password123" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Email Verification (required: false — soft gate)
// ---------------------------------------------------------------------------

describe("email verification (soft gate)", () => {
  test("login succeeds but returns emailVerified false", async () => {
    // Create a separate app with required: false for the soft gate test
    const softApp = await createTestApp({
      auth: {
        enabled: true,
        roles: ["admin", "user"],
        defaultRole: "user",
        emailVerification: { required: false, onSend },
      },
    });
    clearMemoryStore();

    await softApp.request("/auth/register", json({ email: "soft@example.com", password: "password123" }));

    const res = await softApp.request("/auth/login", json({ email: "soft@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.emailVerified).toBe(false);

    // Restore required: true config for any subsequent tests
    await createTestApp({
      auth: {
        enabled: true,
        roles: ["admin", "user"],
        defaultRole: "user",
        emailVerification: { required: true, onSend },
      },
    });
  });
});
