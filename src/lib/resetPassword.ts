import { getRedis } from "./redis";
import { appConnection } from "./mongo";
import { getAppName, getResetTokenExpiry } from "./appConfig";
import { Schema } from "mongoose";
import {
  sqliteCreateResetToken,
  sqliteGetResetToken,
  sqliteDeleteResetToken,
} from "../adapters/sqliteAuth";
import {
  memoryCreateResetToken,
  memoryGetResetToken,
  memoryDeleteResetToken,
} from "../adapters/memoryAuth";

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

export const createResetToken = async (userId: string, email: string): Promise<string> => {
  const token = crypto.randomUUID();
  const ttl = getResetTokenExpiry();
  if (_store === "memory") { memoryCreateResetToken(token, userId, email, ttl); return token; }
  if (_store === "sqlite") { sqliteCreateResetToken(token, userId, email, ttl); return token; }
  if (_store === "mongo") {
    await getResetModel().create({
      token,
      userId,
      email,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return token;
  }
  await getRedis().set(
    `reset:${getAppName()}:${token}`,
    JSON.stringify({ userId, email }),
    "EX",
    ttl
  );
  return token;
};

export const getResetToken = async (token: string): Promise<{ userId: string; email: string } | null> => {
  if (_store === "memory") return memoryGetResetToken(token);
  if (_store === "sqlite") return sqliteGetResetToken(token);
  if (_store === "mongo") {
    const doc = await getResetModel()
      .findOne({ token, expiresAt: { $gt: new Date() } })
      .lean();
    if (!doc) return null;
    return { userId: doc.userId, email: doc.email };
  }
  const raw = await getRedis().get(`reset:${getAppName()}:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; email: string };
};

export const deleteResetToken = async (token: string): Promise<void> => {
  if (_store === "memory") { memoryDeleteResetToken(token); return; }
  if (_store === "sqlite") { sqliteDeleteResetToken(token); return; }
  if (_store === "mongo") {
    await getResetModel().deleteOne({ token });
    return;
  }
  await getRedis().del(`reset:${getAppName()}:${token}`);
};
