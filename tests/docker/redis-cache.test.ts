import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { connectTestRedis, flushTestServices, disconnectTestServices } from "../setup-docker";
import { setAppName } from "../../src/lib/appConfig";
import { setCacheStore, bustCache, bustCachePattern } from "../../src/middleware/cacheResponse";
import { getRedis } from "../../src/lib/redis";

beforeAll(async () => {
  await connectTestRedis();
  setAppName("test-app");
  setCacheStore("redis");
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe("Redis cache store", () => {
  // We test the internal store functions indirectly via the Redis client,
  // since storeGet/storeSet/storeDel are not exported. We test them through
  // the bustCache and bustCachePattern public APIs + direct Redis inspection.

  it("sets and gets a cache entry via Redis", async () => {
    const redis = getRedis();
    const key = "cache:test-app:test-key";
    const value = JSON.stringify({ status: 200, headers: {}, body: "hello" });
    await redis.setex(key, 60, value);

    const stored = await redis.get(key);
    expect(stored).toBe(value);
  });

  it("sets entry with TTL", async () => {
    const redis = getRedis();
    const key = "cache:test-app:ttl-key";
    await redis.setex(key, 2, "data");
    expect(await redis.get(key)).toBe("data");

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2);
  });

  it("bustCache deletes a specific key", async () => {
    const redis = getRedis();
    const key = "cache:test-app:bust-me";
    await redis.set(key, "value");
    expect(await redis.get(key)).toBe("value");

    await bustCache("bust-me");
    expect(await redis.get(key)).toBeNull();
  });

  it("bustCachePattern deletes matching keys via SCAN", async () => {
    const redis = getRedis();
    await redis.set("cache:test-app:users:1", "a");
    await redis.set("cache:test-app:users:2", "b");
    await redis.set("cache:test-app:products:1", "c");

    await bustCachePattern("users:*");

    expect(await redis.get("cache:test-app:users:1")).toBeNull();
    expect(await redis.get("cache:test-app:users:2")).toBeNull();
    // Non-matching key should remain
    expect(await redis.get("cache:test-app:products:1")).toBe("c");
  });

  it("bustCachePattern handles no matching keys", async () => {
    // Should not throw
    await bustCachePattern("nonexistent:*");
  });

  it("set without TTL (indefinite)", async () => {
    const redis = getRedis();
    const key = "cache:test-app:no-ttl";
    await redis.set(key, "forever");

    const ttl = await redis.ttl(key);
    expect(ttl).toBe(-1); // -1 means no expiry
  });
});
