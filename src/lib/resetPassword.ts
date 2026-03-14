import { createHash } from "crypto";
import { getRedis } from "./redis";
import { appConnection } from "./mongo";
import { getAppName, getResetTokenExpiry } from "./appConfig";
import { Schema } from "mongoose";
import {
  sqliteCreateResetToken,
  sqliteConsumeResetToken,
} from "../adapters/sqliteAuth";
import {
  memoryCreateResetToken,
  memoryConsumeResetToken,
} from "../adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Token hashing — store SHA-256(token); raw token is only in the email link.
// If the store is ever leaked, outstanding tokens cannot be replayed directly.
// ---------------------------------------------------------------------------

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

// ---------------------------------------------------------------------------
// Mongo model
// ---------------------------------------------------------------------------

interface ResetDoc {
  token: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

const resetSchema = new Schema<ResetDoc>(
  {
    token:     { type: String, required: true, unique: true },
    userId:    { type: String, required: true },
    email:     { type: String, required: true },
    expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
  },
  { collection: "password_resets" }
);

function getResetModel() {
  return appConnection.models["PasswordReset"] ??
    appConnection.model<ResetDoc>("PasswordReset", resetSchema);
}

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

/** Atomically GET+DEL a key. Uses native GETDEL (Redis >= 6.2) with a Lua fallback. */
async function redisGetDel(key: string): Promise<string | null> {
  const redis = getRedis() as any;
  if (typeof redis.getdel === "function") {
    try {
      return await redis.getdel(key);
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      if (!/unknown command|ERR unknown command/i.test(msg)) throw err;
      // Fall through to Lua on "unknown command"
    }
  }
  const result = await redis.eval(
    "local v = redis.call('GET', KEYS[1])\nif v then redis.call('DEL', KEYS[1]) end\nreturn v",
    1,
    key
  );
  return result ?? null;
}

// ---------------------------------------------------------------------------
// Store configuration
// ---------------------------------------------------------------------------

type ResetStore = "redis" | "mongo" | "sqlite" | "memory";
let _store: ResetStore = "redis";
export const setPasswordResetStore = (store: ResetStore) => { _store = store; };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a reset token. Returns the raw token (to embed in the email link).
 *  Only the SHA-256 hash is persisted in the store. */
export const createResetToken = async (userId: string, email: string): Promise<string> => {
  const token = crypto.randomUUID();
  const hash  = hashToken(token);
  const ttl   = getResetTokenExpiry();
  if (_store === "memory") { memoryCreateResetToken(hash, userId, email, ttl); return token; }
  if (_store === "sqlite") { sqliteCreateResetToken(hash, userId, email, ttl); return token; }
  if (_store === "mongo") {
    await getResetModel().create({
      token: hash,
      userId,
      email,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return token;
  }
  await getRedis().set(
    `reset:${getAppName()}:${hash}`,
    JSON.stringify({ userId, email }),
    "EX",
    ttl
  );
  return token;
};

/** Atomically consume a reset token — returns its payload and deletes it in one operation.
 *  Returns null if the token is invalid, expired, or already used. */
export const consumeResetToken = async (token: string): Promise<{ userId: string; email: string } | null> => {
  const hash = hashToken(token);
  if (_store === "memory") return memoryConsumeResetToken(hash);
  if (_store === "sqlite") return sqliteConsumeResetToken(hash);
  if (_store === "mongo") {
    const doc = await getResetModel()
      .findOneAndDelete({ token: hash, expiresAt: { $gt: new Date() } })
      .lean();
    if (!doc) return null;
    return { userId: doc.userId, email: doc.email };
  }
  // Redis: atomically return and remove the key (GETDEL or Lua fallback)
  const raw = await redisGetDel(`reset:${getAppName()}:${hash}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; email: string };
};
