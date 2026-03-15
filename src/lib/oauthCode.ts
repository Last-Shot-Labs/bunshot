import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName } from "./appConfig";
import { sha256 } from "./crypto";
import {
  memoryStoreOAuthCode,
  memoryConsumeOAuthCode,
} from "../adapters/memoryAuth";
import {
  sqliteStoreOAuthCode,
  sqliteConsumeOAuthCode,
} from "../adapters/sqliteAuth";

// ---------------------------------------------------------------------------
// Mongo model
// ---------------------------------------------------------------------------

interface OAuthCodeDoc {
  codeHash: string;
  token: string;
  userId: string;
  email?: string;
  refreshToken?: string;
  expiresAt: Date;
}

function getOAuthCodeModel() {
  if (appConnection.models["OAuthCode"]) return appConnection.models["OAuthCode"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const schema = new Schema<OAuthCodeDoc>(
    {
      codeHash:     { type: String, required: true, unique: true },
      token:        { type: String, required: true },
      userId:       { type: String, required: true },
      email:        { type: String },
      refreshToken: { type: String },
      expiresAt:    { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { collection: "oauth_codes" }
  );
  return appConnection.model<OAuthCodeDoc>("OAuthCode", schema);
}

// ---------------------------------------------------------------------------
// Store configuration — mirrors the OAuth state store
// ---------------------------------------------------------------------------

type OAuthCodeStore = "redis" | "mongo" | "sqlite" | "memory";
let _store: OAuthCodeStore = "redis";
export const setOAuthCodeStore = (store: OAuthCodeStore) => { _store = store; };

const CODE_TTL = 60; // 60 seconds

export interface OAuthCodePayload {
  token: string;
  userId: string;
  email?: string;
  refreshToken?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Store a one-time authorization code. Returns the raw code (for the redirect URL).
 *  Only the SHA-256 hash is persisted. */
export const storeOAuthCode = async (payload: OAuthCodePayload): Promise<string> => {
  const code = crypto.randomUUID();
  const hash = sha256(code);

  if (_store === "memory") {
    memoryStoreOAuthCode(hash, payload, CODE_TTL);
    return code;
  }
  if (_store === "sqlite") {
    sqliteStoreOAuthCode(hash, payload, CODE_TTL);
    return code;
  }
  if (_store === "mongo") {
    await getOAuthCodeModel().create({
      codeHash: hash,
      ...payload,
      expiresAt: new Date(Date.now() + CODE_TTL * 1000),
    });
    return code;
  }
  // Redis
  await getRedis().set(
    `oauthcode:${getAppName()}:${hash}`,
    JSON.stringify(payload),
    "EX",
    CODE_TTL
  );
  return code;
};

/** Atomically consume an authorization code — returns its payload and deletes it.
 *  Returns null if invalid, expired, or already used. */
export const consumeOAuthCode = async (code: string): Promise<OAuthCodePayload | null> => {
  const hash = sha256(code);

  if (_store === "memory") return memoryConsumeOAuthCode(hash);
  if (_store === "sqlite") return sqliteConsumeOAuthCode(hash);
  if (_store === "mongo") {
    const doc = await getOAuthCodeModel()
      .findOneAndDelete({ codeHash: hash, expiresAt: { $gt: new Date() } })
      .lean();
    if (!doc) return null;
    return { token: doc.token, userId: doc.userId, email: doc.email, refreshToken: doc.refreshToken };
  }
  // Redis
  const key = `oauthcode:${getAppName()}:${hash}`;
  const redis = getRedis() as any;
  let raw: string | null = null;
  if (typeof redis.getdel === "function") {
    try { raw = await redis.getdel(key); } catch {
      raw = await redis.get(key);
      if (raw) await redis.del(key);
    }
  } else {
    raw = await redis.get(key);
    if (raw) await redis.del(key);
  }
  if (!raw) return null;
  return JSON.parse(raw) as OAuthCodePayload;
};
