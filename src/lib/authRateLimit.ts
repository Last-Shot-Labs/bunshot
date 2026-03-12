import { getAppName } from "@lib/appConfig";

interface AuthRateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

interface AuthRateLimitStore {
  get(key: string): Promise<AuthRateLimitEntry | null>;
  set(key: string, entry: AuthRateLimitEntry, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

const _memoryStore = new Map<string, AuthRateLimitEntry>();

const memoryStore: AuthRateLimitStore = {
  async get(key) {
    const entry = _memoryStore.get(key);
    if (!entry) return null;
    if (entry.resetAt <= Date.now()) {
      _memoryStore.delete(key);
      return null;
    }
    return entry;
  },
  async set(key, entry) {
    _memoryStore.set(key, entry);
  },
  async delete(key) {
    _memoryStore.delete(key);
  },
};

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

const redisStore: AuthRateLimitStore = {
  async get(key) {
    const { getRedis } = await import("@lib/redis");
    const raw = await getRedis().get(`rl:${getAppName()}:${key}`);
    if (!raw) return null;
    const entry: AuthRateLimitEntry = JSON.parse(raw);
    if (entry.resetAt <= Date.now()) return null;
    return entry;
  },
  async set(key, entry, ttlMs) {
    const { getRedis } = await import("@lib/redis");
    await getRedis().set(`rl:${getAppName()}:${key}`, JSON.stringify(entry), "PX", ttlMs);
  },
  async delete(key) {
    const { getRedis } = await import("@lib/redis");
    await getRedis().del(`rl:${getAppName()}:${key}`);
  },
};

// ---------------------------------------------------------------------------
// Active store + setter
// ---------------------------------------------------------------------------

let _store: AuthRateLimitStore = memoryStore;

export const setAuthRateLimitStore = (store: "memory" | "redis"): void => {
  _store = store === "redis" ? redisStore : memoryStore;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LimitOpts {
  windowMs: number;
  max: number;
}

/** Returns true if the key is currently over the limit (read-only, no increment). */
export const isLimited = async (key: string, opts: LimitOpts): Promise<boolean> => {
  const entry = await _store.get(key);
  if (!entry) return false;
  return entry.count >= opts.max;
};

/** Increments the counter and returns true if now over the limit. */
export const trackAttempt = async (key: string, opts: LimitOpts): Promise<boolean> => {
  const now = Date.now();
  const existing = await _store.get(key);
  if (!existing) {
    await _store.set(key, { count: 1, resetAt: now + opts.windowMs }, opts.windowMs);
    return 1 >= opts.max;
  }
  const updated: AuthRateLimitEntry = { count: existing.count + 1, resetAt: existing.resetAt };
  const remaining = Math.max(1, existing.resetAt - now);
  await _store.set(key, updated, remaining);
  return updated.count >= opts.max;
};

/** Resets a rate limit key. Use on login success or for admin unlock. */
export const bustAuthLimit = async (key: string): Promise<void> => {
  await _store.delete(key);
};
