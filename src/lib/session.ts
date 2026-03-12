import { getRedis } from "./redis";
import { appConnection } from "./mongo";
import { getAppName } from "./appConfig";
import { Schema } from "mongoose";
import { sqliteCreateSession, sqliteGetSession, sqliteDeleteSession } from "../adapters/sqliteAuth";
import { memoryCreateSession, memoryGetSession, memoryDeleteSession } from "../adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Mongo session model
// ---------------------------------------------------------------------------

interface SessionDoc {
  userId: string;
  token: string;
  expiresAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    userId:    { type: String, required: true, unique: true },
    token:     { type: String, required: true },
    expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
  },
  { collection: "sessions" }
);

function getSessionModel() {
  return appConnection.models["Session"] ??
    appConnection.model<SessionDoc>("Session", sessionSchema);
}

// ---------------------------------------------------------------------------
// Store configuration — set once at startup via setSessionStore()
// ---------------------------------------------------------------------------

type SessionStore = "redis" | "mongo" | "sqlite" | "memory";
let _store: SessionStore = "redis";
export const setSessionStore = (store: SessionStore) => { _store = store; };

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createSession = async (userId: string, token: string) => {
  if (_store === "memory") { memoryCreateSession(userId, token); return; }
  if (_store === "sqlite") {
    sqliteCreateSession(userId, token);
    return;
  }
  if (_store === "mongo") {
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    await getSessionModel().updateOne(
      { userId },
      { $set: { token, expiresAt } },
      { upsert: true }
    );
    return;
  }
  await getRedis().set(`session:${getAppName()}:${userId}`, token, "EX", TTL_SECONDS);
};

export const getSession = async (userId: string) => {
  if (_store === "memory") return memoryGetSession(userId);
  if (_store === "sqlite") return sqliteGetSession(userId);
  if (_store === "mongo") {
    const doc = await getSessionModel()
      .findOne({ userId, expiresAt: { $gt: new Date() } }, "token")
      .lean();
    return doc ? doc.token : null;
  }
  return getRedis().get(`session:${getAppName()}:${userId}`);
};

export const deleteSession = async (userId: string) => {
  if (_store === "memory") { memoryDeleteSession(userId); return; }
  if (_store === "sqlite") {
    sqliteDeleteSession(userId);
    return;
  }
  if (_store === "mongo") {
    await getSessionModel().deleteOne({ userId });
    return;
  }
  await getRedis().del(`session:${getAppName()}:${userId}`);
};
