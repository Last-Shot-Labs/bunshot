import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import type { Hono } from "hono";
import { storeOAuthCode } from "../../src/lib/oauthCode";
import { setOAuthCodeStore } from "../../src/lib/oauthCode";

let app: Hono;

// Helper to create a JSON POST request
const json = (path: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("OAuth exchange endpoint", () => {
  beforeAll(async () => {
    app = await createTestApp({
      auth: {
        enabled: true,
        roles: ["user"],
        defaultRole: "user",
        // OAuth exchange route is always mounted when auth is enabled
        // even without providers configured
      },
    });
  });

  beforeEach(() => {
    clearMemoryStore();
    setOAuthCodeStore("memory");
  });

  it("exchanges a valid code for session token", async () => {
    // Pre-store a code in the memory store
    const code = await storeOAuthCode({
      token: "jwt-token-abc",
      userId: "user-123",
      email: "oauth@example.com",
    });

    const res = await app.request(
      json("/auth/oauth/exchange", { code })
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.token).toBe("jwt-token-abc");
    expect(data.userId).toBe("user-123");
    expect(data.email).toBe("oauth@example.com");
  });

  it("code is single-use", async () => {
    const code = await storeOAuthCode({
      token: "jwt-token",
      userId: "user-1",
    });

    const res1 = await app.request(json("/auth/oauth/exchange", { code }));
    expect(res1.status).toBe(200);

    const res2 = await app.request(json("/auth/oauth/exchange", { code }));
    expect(res2.status).toBe(401);
    const data = await res2.json();
    expect(data.error).toBe("Invalid or expired code");
  });

  it("returns 401 for invalid code", async () => {
    const res = await app.request(
      json("/auth/oauth/exchange", { code: "totally-invalid" })
    );
    expect(res.status).toBe(401);
  });

  it("includes refreshToken when configured", async () => {
    const appWithRefresh = await createTestApp({
      auth: {
        enabled: true,
        roles: ["user"],
        defaultRole: "user",
        refreshTokens: {
          accessTokenExpiry: "15m",
          refreshTokenExpiry: 86400,
          rotationGraceSeconds: 30,
        },
      },
    });

    const code = await storeOAuthCode({
      token: "jwt-with-rt",
      userId: "user-rt",
      refreshToken: "refresh-token-xyz",
    });

    const res = await appWithRefresh.request(
      json("/auth/oauth/exchange", { code })
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.refreshToken).toBe("refresh-token-xyz");
  });

  it("sets session cookies in response", async () => {
    const code = await storeOAuthCode({
      token: "jwt-cookie",
      userId: "user-cookie",
    });

    const res = await app.request(
      json("/auth/oauth/exchange", { code })
    );
    expect(res.status).toBe(200);

    const cookies = res.headers.get("set-cookie");
    expect(cookies).toContain("token=");
  });

  it("rate limits exchange attempts per IP", async () => {
    // Make 20 attempts to exhaust the rate limit
    for (let i = 0; i < 20; i++) {
      await app.request(
        json("/auth/oauth/exchange", { code: `invalid-${i}` })
      );
    }

    const res = await app.request(
      json("/auth/oauth/exchange", { code: "one-more" })
    );
    expect(res.status).toBe(429);
  });
});
