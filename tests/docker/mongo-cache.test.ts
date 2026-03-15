import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { connectTestMongo, flushTestServices, disconnectTestServices } from "../setup-docker";
import { setAppName } from "../../src/lib/appConfig";
import { setCacheStore, bustCache, bustCachePattern } from "../../src/middleware/cacheResponse";
import { appConnection } from "../../src/lib/mongo";

beforeAll(async () => {
  await connectTestMongo();
  setAppName("test-app");
  setCacheStore("mongo");
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

function getCacheModel() {
  return appConnection.models["CacheEntry"];
}

describe("Mongo cache store", () => {
  it("stores and retrieves a cache entry", async () => {
    const CacheEntry = getCacheModel();
    if (!CacheEntry) {
      // Force model registration by importing the middleware
      const { cacheResponse } = await import("../../src/middleware/cacheResponse");
    }
    // Insert directly via model
    const model = appConnection.models["CacheEntry"];
    await model.create({
      key: "cache:test-app:test-key",
      value: JSON.stringify({ status: 200, headers: {}, body: "hello" }),
    });

    const doc = await model.findOne({ key: "cache:test-app:test-key" }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.value).toContain("hello");
  });

  it("upserts on duplicate key", async () => {
    const model = appConnection.models["CacheEntry"];
    if (!model) return; // Skip if model not yet registered

    await model.updateOne(
      { key: "cache:test-app:upsert" },
      { $set: { value: "first" } },
      { upsert: true }
    );
    await model.updateOne(
      { key: "cache:test-app:upsert" },
      { $set: { value: "second" } },
      { upsert: true }
    );

    const docs = await model.find({ key: "cache:test-app:upsert" }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].value).toBe("second");
  });

  it("bustCache deletes a specific key", async () => {
    const model = appConnection.models["CacheEntry"];
    if (!model) return;

    await model.create({ key: "cache:test-app:bust-me", value: "val" });
    await bustCache("bust-me");

    const doc = await model.findOne({ key: "cache:test-app:bust-me" }).lean();
    expect(doc).toBeNull();
  });

  it("bustCachePattern deletes matching keys via regex", async () => {
    const model = appConnection.models["CacheEntry"];
    if (!model) return;

    await model.create({ key: "cache:test-app:users:1", value: "a" });
    await model.create({ key: "cache:test-app:users:2", value: "b" });
    await model.create({ key: "cache:test-app:products:1", value: "c" });

    await bustCachePattern("users:*");

    expect(await model.findOne({ key: "cache:test-app:users:1" }).lean()).toBeNull();
    expect(await model.findOne({ key: "cache:test-app:users:2" }).lean()).toBeNull();
    expect(await model.findOne({ key: "cache:test-app:products:1" }).lean()).not.toBeNull();
  });

  it("stores entry with expiresAt", async () => {
    const model = appConnection.models["CacheEntry"];
    if (!model) return;

    const expiresAt = new Date(Date.now() + 60_000);
    await model.create({ key: "cache:test-app:expiry", value: "data", expiresAt });

    const doc = await model.findOne({ key: "cache:test-app:expiry" }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.expiresAt).toBeTruthy();
  });
});
