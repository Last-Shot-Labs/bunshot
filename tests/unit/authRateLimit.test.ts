import { describe, test, expect, beforeEach } from "bun:test";
import { trackAttempt, isLimited, bustAuthLimit } from "@lib/authRateLimit";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";

beforeEach(() => {
  clearMemoryStore();
});

const opts = { windowMs: 60_000, max: 3 };

describe("trackAttempt", () => {
  test("returns false when under the limit", async () => {
    const key = "test:under";
    expect(await trackAttempt(key, opts)).toBe(false);
    expect(await trackAttempt(key, opts)).toBe(false);
  });

  test("returns true when reaching the limit", async () => {
    const key = "test:atmax";
    await trackAttempt(key, opts);
    await trackAttempt(key, opts);
    expect(await trackAttempt(key, opts)).toBe(true); // 3rd = max
  });

  test("stays limited after exceeding the limit", async () => {
    const key = "test:over";
    for (let i = 0; i < 5; i++) await trackAttempt(key, opts);
    expect(await isLimited(key, opts)).toBe(true);
  });
});

describe("isLimited", () => {
  test("returns false for unknown key", async () => {
    expect(await isLimited("nonexistent", opts)).toBe(false);
  });

  test("returns false when under the limit", async () => {
    const key = "test:check";
    await trackAttempt(key, opts);
    expect(await isLimited(key, opts)).toBe(false);
  });

  test("returns true when at the limit", async () => {
    const key = "test:limited";
    for (let i = 0; i < 3; i++) await trackAttempt(key, opts);
    expect(await isLimited(key, opts)).toBe(true);
  });
});

describe("bustAuthLimit", () => {
  test("resets the counter so the key is no longer limited", async () => {
    const key = "test:bust";
    for (let i = 0; i < 3; i++) await trackAttempt(key, opts);
    expect(await isLimited(key, opts)).toBe(true);
    await bustAuthLimit(key);
    expect(await isLimited(key, opts)).toBe(false);
  });

  test("is safe to call on a non-existent key", async () => {
    await bustAuthLimit("test:missing");
    expect(await isLimited("test:missing", opts)).toBe(false);
  });
});

describe("window expiry", () => {
  const shortOpts = { windowMs: 1000, max: 2 };

  test("counter resets after window expires", async () => {
    const key = "test:expiry";
    await trackAttempt(key, shortOpts);
    await trackAttempt(key, shortOpts);
    expect(await isLimited(key, shortOpts)).toBe(true);
    await Bun.sleep(1100);
    // After window, counter should be reset
    expect(await isLimited(key, shortOpts)).toBe(false);
    expect(await trackAttempt(key, shortOpts)).toBe(false); // fresh counter
  });

  test("isLimited does not increment the counter", async () => {
    const key = "test:readonly";
    await trackAttempt(key, opts);
    await trackAttempt(key, opts);
    // 2 attempts, limit is 3 — not limited yet
    expect(await isLimited(key, opts)).toBe(false);
    expect(await isLimited(key, opts)).toBe(false);
    expect(await isLimited(key, opts)).toBe(false);
    // Still not limited — isLimited didn't increment
    expect(await trackAttempt(key, opts)).toBe(true); // 3rd attempt hits limit
  });
});
