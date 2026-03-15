/**
 * Verifies that optional peer dependencies (mongoose, ioredis, bullmq) are
 * NOT loaded when the configuration doesn't require them.
 *
 * Uses mock.module() to make the optional packages throw on import/require,
 * simulating an environment where they aren't installed. If createApp()
 * accidentally triggers a require() for an unneeded package, the test fails.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock optional packages BEFORE any app imports — makes require() throw
// just like it would if the package were not installed.
// ---------------------------------------------------------------------------

mock.module("mongoose", () => {
  throw new Error("mongoose is not installed (mocked for test)");
});
mock.module("ioredis", () => {
  throw new Error("ioredis is not installed (mocked for test)");
});
mock.module("bullmq", () => {
  throw new Error("bullmq is not installed (mocked for test)");
});

// Now import app code — these imports must succeed despite the mocks above,
// because all optional deps use lazy require() inside guarded functions.
import { createApp } from "../../src/app";
import type { CreateAppConfig } from "../../src/app";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: CreateAppConfig = {
  routesDir: import.meta.dir + "/../fixtures/routes",
  app: { name: "Optional Deps Test" },
  security: {
    bearerAuth: false,
    rateLimit: { windowMs: 60_000, max: 1000 },
  },
};

function authHeader(token: string): Record<string, string> {
  return { "x-user-token": token };
}

async function smokeTestAuth(app: any) {
  const regRes = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nodeps@test.com", password: "password123" }),
  });
  expect(regRes.status).toBe(201);
  const { token } = await regRes.json();
  expect(token).toBeDefined();

  const meRes = await app.request("/auth/me", { headers: authHeader(token) });
  expect(meRes.status).toBe(200);

  const logoutRes = await app.request("/auth/logout", {
    method: "POST",
    headers: authHeader(token),
  });
  expect(logoutRes.status).toBe(200);
}

beforeEach(() => {
  clearMemoryStore();
});

// ---------------------------------------------------------------------------
// Tests: app starts without mongoose, ioredis, or bullmq
// ---------------------------------------------------------------------------

describe("no optional deps installed", () => {
  it("starts with all-memory stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: "memory", cache: "memory", auth: "memory" },
      auth: { enabled: true, roles: ["user"], defaultRole: "user" },
    });
    await smokeTestAuth(app);
  });

  it("starts with all-sqlite stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sqlite: ":memory:", sessions: "sqlite", cache: "sqlite", auth: "sqlite" },
      auth: { enabled: true, roles: ["user"], defaultRole: "user" },
    });
    await smokeTestAuth(app);
  });

  it("starts with mixed sqlite + memory stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sqlite: ":memory:", sessions: "sqlite", cache: "memory", auth: "memory" },
      auth: { enabled: true, roles: ["user"], defaultRole: "user" },
    });
    await smokeTestAuth(app);
  });

  it("starts with auth disabled and memory cache", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false },
      auth: { enabled: false },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("starts with auth disabled and sqlite cache", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sqlite: ":memory:", cache: "sqlite" },
      auth: { enabled: false },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("starts with email verification on memory stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: "memory", cache: "memory", auth: "memory" },
      auth: {
        enabled: true,
        emailVerification: { required: false, onSend: async () => {} },
      },
    });
    expect(app).toBeTruthy();
  });

  it("starts with password reset on memory stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: "memory", cache: "memory", auth: "memory" },
      auth: {
        enabled: true,
        passwordReset: { onSend: async () => {} },
      },
    });
    expect(app).toBeTruthy();
  });

  it("starts with MFA on sqlite stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sqlite: ":memory:", sessions: "sqlite", cache: "sqlite", auth: "sqlite" },
      auth: {
        enabled: true,
        mfa: { issuer: "TestApp" },
      },
    });
    expect(app).toBeTruthy();
  });

  it("starts with refresh tokens on memory stores", async () => {
    const app = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: "memory", cache: "memory", auth: "memory" },
      auth: {
        enabled: true,
        refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
      },
    });
    await smokeTestAuth(app);
  });
});
