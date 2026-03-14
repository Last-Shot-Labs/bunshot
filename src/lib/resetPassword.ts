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
  // Redis: GETDEL atomically returns and removes the key
  const raw = await getRedis().getdel(`reset:${getAppName()}:${hash}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; email: string };
};
