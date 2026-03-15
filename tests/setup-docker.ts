// Preloaded by bunfig.docker.toml / bunfig.ci.toml — runs before any test module initialization.
// Sets env vars for BOTH memory tests (so they still work under this preload) and Docker tests.

// Memory / JWT env vars (same as setup.ts)
process.env.JWT_SECRET_DEV = "test-secret-key-must-be-at-least-32-chars!!";
process.env.BEARER_TOKEN_DEV = "test-bearer-token";
process.env.NODE_ENV = "development";

// Redis env vars — port 6380 maps to Docker container (clear credentials so
// the no-auth Docker Redis isn't sent the .env file's production creds)
process.env.REDIS_HOST_DEV = "localhost:6380";
delete process.env.REDIS_USER_DEV;
delete process.env.REDIS_PW_DEV;

// Mongo env vars — not used directly (we connect with plain URI), but set for completeness
process.env.MONGO_HOST_DEV = "localhost:27018";
process.env.MONGO_DB_DEV = "bunshot_test";

// Re-export everything from setup.ts so memory tests work unchanged
export { createTestApp, authHeader, clearMemoryStore } from "./setup";

// ---------------------------------------------------------------------------
// Docker service helpers
// ---------------------------------------------------------------------------

import { connectRedis, disconnectRedis, getRedis } from "../src/lib/redis";
import { authConnection, appConnection, disconnectMongo } from "../src/lib/mongo";

const EXPECTED_REDIS_PORT = 6380;
const EXPECTED_MONGO_DB = "bunshot_test";
const MONGO_URI = "mongodb://localhost:27018/bunshot_test";

let _redisConnected = false;
let _mongoConnected = false;

/** Connect to Docker Redis (port 6380). Idempotent. */
export async function connectTestRedis(): Promise<void> {
  if (_redisConnected) return;
  await connectRedis();
  _redisConnected = true;
}

/** Connect to Docker MongoDB (port 27018). Idempotent.
 *  Uses plain mongodb:// URI (not SRV) since this is local Docker. */
export async function connectTestMongo(): Promise<void> {
  if (_mongoConnected) return;
  // The connection proxies lazily create connections on first property access.
  // We open both auth + app connections against the same local DB.
  await authConnection.openUri(MONGO_URI);
  await appConnection.openUri(MONGO_URI);
  _mongoConnected = true;
}

/** Flush all test data. Includes safety guards to prevent wiping non-test services. */
export async function flushTestServices(): Promise<void> {
  // Redis safety guard
  if (_redisConnected) {
    const redis = getRedis();
    const port = (redis as any).options?.port;
    if (port !== EXPECTED_REDIS_PORT) {
      throw new Error(
        `SAFETY: Expected Redis on port ${EXPECTED_REDIS_PORT}, got port ${port}. Refusing to FLUSHDB.`
      );
    }
    await redis.flushdb();
  }

  // Mongo safety guard
  if (_mongoConnected) {
    const dbName = authConnection.db?.databaseName;
    if (dbName !== EXPECTED_MONGO_DB) {
      throw new Error(
        `SAFETY: Expected MongoDB database "${EXPECTED_MONGO_DB}", got "${dbName}". Refusing to drop collections.`
      );
    }
    const collections = await authConnection.db!.listCollections().toArray();
    await Promise.all(
      collections.map((c) => authConnection.db!.collection(c.name).deleteMany({}))
    );
  }
}

/** Gracefully disconnect from Docker services. Call in afterAll. */
export async function disconnectTestServices(): Promise<void> {
  if (_redisConnected) {
    await disconnectRedis();
    _redisConnected = false;
  }
  if (_mongoConnected) {
    await disconnectMongo();
    _mongoConnected = false;
  }
}
