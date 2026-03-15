import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName, getTokenExpiry } from "./appConfig";
import { sha256 } from "./crypto";
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

function getVerificationModel() {
  if (appConnection.models["EmailVerification"]) return appConnection.models["EmailVerification"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const verificationSchema = new Schema<VerificationDoc>(
    {
      token:     { type: String, required: true, unique: true },
      userId:    { type: String, required: true },
      email:     { type: String, required: true },
      expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
    },
    { collection: "email_verifications" }
  );
  return appConnection.model<VerificationDoc>("EmailVerification", verificationSchema);
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

/** Create a verification token. Returns the raw token (for the email link).
 *  Only the SHA-256 hash is persisted in the store. */
export const createVerificationToken = async (userId: string, email: string): Promise<string> => {
  const token = crypto.randomUUID();
  const hash = sha256(token);
  const ttl = getTokenExpiry();
  if (_store === "memory") { memoryCreateVerificationToken(hash, userId, email, ttl); return token; }
  if (_store === "sqlite") { sqliteCreateVerificationToken(hash, userId, email, ttl); return token; }
  if (_store === "mongo") {
    await getVerificationModel().create({
      token: hash,
      userId,
      email,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return token;
  }
  await getRedis().set(
    `verify:${getAppName()}:${hash}`,
    JSON.stringify({ userId, email }),
    "EX",
    ttl
  );
  return token;
};

/** Look up a verification token by its raw value. Hashes before lookup. */
export const getVerificationToken = async (token: string): Promise<{ userId: string; email: string } | null> => {
  const hash = sha256(token);
  if (_store === "memory") return memoryGetVerificationToken(hash);
  if (_store === "sqlite") return sqliteGetVerificationToken(hash);
  if (_store === "mongo") {
    const doc = await getVerificationModel()
      .findOne({ token: hash, expiresAt: { $gt: new Date() } })
      .lean();
    if (!doc) return null;
    return { userId: doc.userId, email: doc.email };
  }
  const raw = await getRedis().get(`verify:${getAppName()}:${hash}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; email: string };
};

/** Delete a verification token by its raw value. Hashes before lookup. */
export const deleteVerificationToken = async (token: string): Promise<void> => {
  const hash = sha256(token);
  if (_store === "memory") { memoryDeleteVerificationToken(hash); return; }
  if (_store === "sqlite") { sqliteDeleteVerificationToken(hash); return; }
  if (_store === "mongo") {
    await getVerificationModel().deleteOne({ token: hash });
    return;
  }
  await getRedis().del(`verify:${getAppName()}:${hash}`);
};
