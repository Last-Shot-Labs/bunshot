// Preloaded by bunfig.toml — runs before any test module initialization.
// Sets env vars that jwt.ts reads at module load time.
process.env.JWT_SECRET_DEV = "test-secret-key-must-be-at-least-32-chars!!";
process.env.BEARER_TOKEN_DEV = "test-bearer-token";
process.env.NODE_ENV = "development";

import { createApp } from "../src/app";
import type { CreateAppConfig } from "../src/app";
import { clearMemoryStore } from "../src/adapters/memoryAuth";

const baseConfig: CreateAppConfig = {
  routesDir: import.meta.dir + "/fixtures/routes",
  app: { name: "Test App" },
  db: {
    mongo: false,
    redis: false,
    sessions: "memory",
    cache: "memory",
    auth: "memory",
  },
  security: {
    bearerAuth: false,
    rateLimit: { windowMs: 60_000, max: 1000 },
  },
  auth: {
    enabled: true,
    roles: ["admin", "user"],
    defaultRole: "user",
  },
};

export async function createTestApp(overrides?: Partial<CreateAppConfig>) {
  const config: CreateAppConfig = {
    ...baseConfig,
    ...overrides,
    app: { ...baseConfig.app, ...overrides?.app },
    db: { ...baseConfig.db, ...overrides?.db },
    security: { ...baseConfig.security, ...overrides?.security },
    auth: { ...baseConfig.auth, ...overrides?.auth },
  };
  return createApp(config);
}

export function authHeader(token: string): Record<string, string> {
  return { "x-user-token": token };
}

export { clearMemoryStore };
