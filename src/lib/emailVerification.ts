import { getRedis } from "./redis";
import { appConnection } from "./mongo";
import { getAppName, getTokenExpiry } from "./appConfig";
import { Schema } from "mongoose";
import {
  sqliteCreateVerificationToken,
  sqliteGetVerificationToken,
  sqliteDeleteVerificationToken,
} from "../adapters/sqliteAuth";
import {
  memoryCreateVerificationToken,
  memoryGetVerificationToken,
  memoryDeleteVerificationToken,
} from "../adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Mongo model
// ---------------------------------------------------------------------------

interface VerificationDoc {
  token: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

const verificationSchema = new Schema<VerificationDoc>(
  {
    token:     { type: String, required: true, unique: true },
    userId:    { type: String, required: true },
    email:     { type: String, required: true },
    expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
  },
  { collection: "email_verifications" }
);

function getVerificationModel() {
  return appConnection.models["EmailVerification"] ??
    appConnection.model<VerificationDoc>("EmailVerification", verificationSchema);
}

// ---------------------------------------------------------------------------
// Store configuration
// ---------------------------------------------------------------------------

type VerificationStore = "redis" | "mongo" | "sqlite" | "memory";
let _store: VerificationStore = "redis";
export const setEmailVerificationStore = (store: VerificationStore) => { _store = store; };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createVerificationToken = async (userId: string, email: string): Promise<string> => {
  const token = crypto.randomUUID();
  const ttl = getTokenExpiry();
  if (_store === "memory") { memoryCreateVerificationToken(token, userId, email, ttl); return token; }
  if (_store === "sqlite") { sqliteCreateVerificationToken(token, userId, email, ttl); return token; }
  if (_store === "mongo") {
    await getVerificationModel().create({
      token,
      userId,
      email,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return token;
  }
  await getRedis().set(
    `verify:${getAppName()}:${token}`,
    JSON.stringify({ userId, email }),
    "EX",
    ttl
  );
  return token;
};

export const getVerificationToken = async (token: string): Promise<{ userId: string; email: string } | null> => {
  if (_store === "memory") return memoryGetVerificationToken(token);
  if (_store === "sqlite") return sqliteGetVerificationToken(token);
  if (_store === "mongo") {
    const doc = await getVerificationModel()
      .findOne({ token, expiresAt: { $gt: new Date() } })
      .lean();
    if (!doc) return null;
    return { userId: doc.userId, email: doc.email };
  }
  const raw = await getRedis().get(`verify:${getAppName()}:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; email: string };
};

export const deleteVerificationToken = async (token: string): Promise<void> => {
  if (_store === "memory") { memoryDeleteVerificationToken(token); return; }
  if (_store === "sqlite") { sqliteDeleteVerificationToken(token); return; }
  if (_store === "mongo") {
    await getVerificationModel().deleteOne({ token });
    return;
  }
  await getRedis().del(`verify:${getAppName()}:${token}`);
};
