import type { MiddlewareHandler } from "hono";
import { getRedis } from "@lib/redis";
import { getAppName } from "@lib/appConfig";
import type { AppEnv } from "@lib/context";
import { appConnection, mongoose } from "@lib/mongo";
import { isSqliteReady, sqliteGetCache, sqliteSetCache, sqliteDelCache, sqliteDelCachePattern } from "../adapters/sqliteAuth";
import { memoryGetCache, memorySetCache, memoryDelCache, memoryDelCachePattern } from "../adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Mongo cache model (lazy — only registered when "mongo" store is used)
// ---------------------------------------------------------------------------

interface CacheDoc {
  key: string;
  value: string;
  expiresAt?: Date;
}

export function getCacheModel() {
  if (appConnection.models["CacheEntry"]) return appConnection.models["CacheEntry"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const cacheSchema = new Schema<CacheDoc>(
    {
      key: { type: String, required: true, unique: true },
      value: { type: String, required: true },
      expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
    },
    { collection: "cache_entries" }
  );
  return appConnection.model<CacheDoc>("CacheEntry", cacheSchema);
}

function isMongoReady(): boolean {
  return appConnection.readyState === 1;
}

function isRedisReady(): boolean {
  try { getRedis(); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Shared payload type
// ---------------------------------------------------------------------------

type CachePayload = { status: number; headers: Record<string, string>; body: string };

// ---------------------------------------------------------------------------
// Store adapters
// ---------------------------------------------------------------------------

type CacheStore = "redis" | "mongo" | "sqlite" | "memory";

let _defaultCacheStore: CacheStore = "redis";
export const setCacheStore = (store: CacheStore) => { _defaultCacheStore = store; };

async function storeGet(store: CacheStore, cacheKey: string): Promise<string | null> {
  if (store === "memory") return memoryGetCache(cacheKey);
  if (store === "sqlite") {
    if (!isSqliteReady()) throw new Error(`cacheResponse: store is "sqlite" but SQLite is not initialized. Call setSqliteDb(path) or pass sqliteDb to createServer.`);
    return sqliteGetCache(cacheKey);
  }
  if (store === "mongo") {
    if (!isMongoReady())
      throw new Error(`cacheResponse: store is "mongo" but appConnection is not connected. Ensure connectMongo() or connectAppMongo() is called before handling requests.`);
    const doc = await getCacheModel().findOne({ key: cacheKey }, "value").lean();
    return doc ? doc.value : null;
  }
  return getRedis().get(cacheKey);
}

async function storeSet(store: CacheStore, cacheKey: string, value: string, ttl?: number): Promise<void> {
  if (store === "memory") { memorySetCache(cacheKey, value, ttl); return; }
  if (store === "sqlite") {
    if (!isSqliteReady()) throw new Error(`cacheResponse: store is "sqlite" but SQLite is not initialized. Call setSqliteDb(path) or pass sqliteDb to createServer.`);
    sqliteSetCache(cacheKey, value, ttl);
    return;
  }
  if (store === "mongo") {
    if (!isMongoReady())
      throw new Error(`cacheResponse: store is "mongo" but appConnection is not connected. Ensure connectMongo() or connectAppMongo() is called before handling requests.`);
    const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : undefined;
    await getCacheModel().updateOne(
      { key: cacheKey },
      { $set: { value, ...(expiresAt ? { expiresAt } : {}) } },
      { upsert: true }
    );
    return;
  }
  if (ttl) {
    await getRedis().setex(cacheKey, ttl, value);
  } else {
    await getRedis().set(cacheKey, value);
  }
}

async function storeDel(store: CacheStore, cacheKey: string): Promise<void> {
  if (store === "memory") { memoryDelCache(cacheKey); return; }
  if (store === "sqlite") {
    if (!isSqliteReady()) return;
    sqliteDelCache(cacheKey);
    return;
  }
  if (store === "mongo") {
    if (!isMongoReady()) return;
    await getCacheModel().deleteOne({ key: cacheKey });
    return;
  }
  if (!isRedisReady()) return;
  await getRedis().del(cacheKey);
}

async function storeDelPattern(store: CacheStore, fullPattern: string): Promise<void> {
  if (store === "memory") { memoryDelCachePattern(fullPattern); return; }
  if (store === "sqlite") {
    if (!isSqliteReady()) return;
    sqliteDelCachePattern(fullPattern);
    return;
  }
  if (store === "mongo") {
    if (!isMongoReady()) return;
    const regex = new RegExp("^" + fullPattern.replace(/\*/g, ".*") + "$");
    await getCacheModel().deleteMany({ key: regex });
    return;
  }
  if (!isRedisReady()) return;
  const redis = getRedis();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", fullPattern, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const bustCache = async (key: string) => {
  const cacheKey = `cache:${getAppName()}:${key}`;
  await Promise.all([storeDel("redis", cacheKey), storeDel("mongo", cacheKey), storeDel("sqlite", cacheKey), storeDel("memory", cacheKey)]);
};

export const bustCachePattern = async (pattern: string) => {
  const fullPattern = `cache:${getAppName()}:${pattern}`;
  await Promise.all([storeDelPattern("redis", fullPattern), storeDelPattern("mongo", fullPattern), storeDelPattern("sqlite", fullPattern), storeDelPattern("memory", fullPattern)]);
};

/** Headers that must never be cached — storing these can cause session fixation or auth bypass. */
const UNCACHEABLE_HEADERS = new Set([
  "set-cookie",
  "www-authenticate",
  "authorization",
  "x-csrf-token",
  "proxy-authenticate",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeyFn = (c: Parameters<MiddlewareHandler<any>>[0]) => string;

interface CacheOptions {
  ttl?: number; // seconds — omit for indefinite
  key: string | KeyFn;
  store?: CacheStore; // default: inherits from db.cache config (setCacheStore), falls back to "redis"
}

export const cacheResponse = ({ ttl, key, store = _defaultCacheStore }: CacheOptions): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const appName = getAppName();
    const rawKey = typeof key === "function" ? key(c) : key;
    // Per-tenant namespacing: prevents two tenants caching the same key from colliding
    const tenantId = c.get("tenantId");
    const tenantSegment = tenantId ? `${tenantId}:` : "";
    const cacheKey = `cache:${appName}:${tenantSegment}${rawKey}`;

    const cached = await storeGet(store, cacheKey);
    if (cached) {
      const { status, headers, body } = JSON.parse(cached) as CachePayload;
      return new Response(body, {
        status,
        headers: { ...headers, "x-cache": "HIT" },
      });
    }

    await next();

    const res = c.res;
    if (res.status >= 200 && res.status < 300) {
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        if (!UNCACHEABLE_HEADERS.has(name.toLowerCase())) {
          headers[name] = value;
        }
      });

      await storeSet(store, cacheKey, JSON.stringify({ status: res.status, headers, body }), ttl);

      c.res = new Response(body, {
        status: res.status,
        headers: { ...headers, "x-cache": "MISS" },
      });
    }
  };
};
