import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import type { OpenAPIHono } from "@hono/zod-openapi";
import * as OTPAuth from "otpauth";

let app: OpenAPIHono<any>;

beforeAll(async () => {
  app = await createTestApp({
    auth: {
      enabled: true,
      roles: ["admin", "user"],
      defaultRole: "user",
      mfa: { issuer: "TestApp" },
    },
  });
});

beforeEach(() => {
  clearMemoryStore();
});

const json = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function generateTotpCode(secret: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    issuer: "TestApp",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }).generate();
}

async function registerUser(email = "mfa@example.com", password = "password123") {
  const res = await app.request("/auth/register", json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function registerAndSetupMfa(email = "mfa@example.com", password = "password123") {
  const { token, userId } = await registerUser(email, password);

  // Setup MFA
  const setupRes = await app.request("/auth/mfa/setup", {
    method: "POST",
    headers: authHeader(token),
  });
  const { secret, uri } = await setupRes.json();

  // Verify setup with valid TOTP code
  const code = generateTotpCode(secret);
  const verifyRes = await app.request("/auth/mfa/verify-setup", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { recoveryCodes } = await verifyRes.json();

  return { token, userId, secret, uri, recoveryCodes };
}

// ---------------------------------------------------------------------------
// MFA Setup
// ---------------------------------------------------------------------------

describe("POST /auth/mfa/setup", () => {
  test("returns secret and URI", async () => {
    const { token } = await registerUser();

    const res = await app.request("/auth/mfa/setup", {
      method: "POST",
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBeString();
    expect(body.secret).toMatch(/^[A-Z2-7]+=*$/); // base32
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
  });
});

// ---------------------------------------------------------------------------
// MFA Verify Setup
// ---------------------------------------------------------------------------

describe("POST /auth/mfa/verify-setup", () => {
  test("enables MFA and returns recovery codes", async () => {
    const { token } = await registerUser();

    const setupRes = await app.request("/auth/mfa/setup", {
      method: "POST",
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();

    const code = generateTotpCode(secret);
    const res = await app.request("/auth/mfa/verify-setup", {
      method: "POST",
      headers: { ...authHeader(token), "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("MFA enabled");
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
  });

  test("rejects invalid code", async () => {
    const { token } = await registerUser();

    await app.request("/auth/mfa/setup", {
      method: "POST",
      headers: authHeader(token),
    });

    const res = await app.request("/auth/mfa/verify-setup", {
      method: "POST",
      headers: { ...authHeader(token), "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MFA Login Flow
// ---------------------------------------------------------------------------

describe("MFA login flow", () => {
  test("login returns mfaRequired when MFA enabled", async () => {
    await registerAndSetupMfa();

    const loginRes = await app.request("/auth/login", json({ email: "mfa@example.com", password: "password123" }));
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaToken).toBeString();
    expect(body.mfaMethods).toContain("totp");
    expect(body.token).toBe("");
  });

  test("verify completes login with valid TOTP", async () => {
    const { secret } = await registerAndSetupMfa();

    const loginRes = await app.request("/auth/login", json({ email: "mfa@example.com", password: "password123" }));
    const { mfaToken } = await loginRes.json();

    const code = generateTotpCode(secret);
    const verifyRes = await app.request("/auth/mfa/verify", json({ mfaToken, code }));
    expect(verifyRes.status).toBe(200);
    const { token, userId } = await verifyRes.json();
    expect(token).toBeString();
    expect(userId).toBeString();

    // Verify the session works
    const meRes = await app.request("/auth/me", { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
  });

  test("verify accepts recovery code as fallback", async () => {
    const { recoveryCodes } = await registerAndSetupMfa();

    // Login to get MFA challenge
    const loginRes = await app.request("/auth/login", json({ email: "mfa@example.com", password: "password123" }));
    const { mfaToken } = await loginRes.json();

    // Use recovery code
    const verifyRes = await app.request("/auth/mfa/verify", json({ mfaToken, code: recoveryCodes[0] }));
    expect(verifyRes.status).toBe(200);
    const { token } = await verifyRes.json();
    expect(token).toBeString();

    // Same recovery code should not work again (need a new login + mfaToken)
    const loginRes2 = await app.request("/auth/login", json({ email: "mfa@example.com", password: "password123" }));
    const { mfaToken: mfaToken2 } = await loginRes2.json();

    const verifyRes2 = await app.request("/auth/mfa/verify", json({ mfaToken: mfaToken2, code: recoveryCodes[0] }));
    expect(verifyRes2.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Disable MFA
// ---------------------------------------------------------------------------

describe("DELETE /auth/mfa", () => {
  test("disables MFA", async () => {
    const { token, secret } = await registerAndSetupMfa();

    const code = generateTotpCode(secret);
    const delRes = await app.request("/auth/mfa", {
      method: "DELETE",
      headers: { ...authHeader(token), "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(delRes.status).toBe(200);

    // Login should no longer require MFA
    const loginRes = await app.request("/auth/login", json({ email: "mfa@example.com", password: "password123" }));
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(0);
  });
});
