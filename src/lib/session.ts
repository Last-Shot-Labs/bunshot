import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName, getPersistSessionMetadata, getIncludeInactiveSessions } from "./appConfig";
import {
  sqliteCreateSession,
  sqliteGetSession,
  sqliteDeleteSession,
  sqliteGetUserSessions,
  sqliteGetActiveSessionCount,
  sqliteEvictOldestSession,
  sqliteUpdateSessionLastActive,
} from "../adapters/sqliteAuth";
import {
  memoryCreateSession,
  memoryGetSession,
  memoryDeleteSession,
  memoryGetUserSessions,
  memoryGetActiveSessionCount,
  memoryEvictOldestSession,
  memoryUpdateSessionLastActive,
} from "../adapters/memoryAuth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Mongo session model
// ---------------------------------------------------------------------------

interface SessionDoc {
  sessionId: string;
  userId: string;
  token: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

function getSessionModel() {
  if (appConnection.models["Session"]) return appConnection.models["Session"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const sessionSchema = new Schema<SessionDoc>(
    {
      sessionId:    { type: String, required: true, unique: true },
      userId:       { type: String, required: true, index: true },
      token:        { type: String, default: null },
      createdAt:    { type: Date,   required: true },
      lastActiveAt: { type: Date,   required: true },
      expiresAt:    { type: Date,   required: true },
      ipAddress:    { type: String },
      userAgent:    { type: String },
    },
    { collection: "sessions", timestamps: false }
  );
  // Add TTL index only when metadata is not persisted — docs auto-delete at expiresAt.
  // When persisting, token is nulled (soft-delete) but the row is kept indefinitely.
  if (!getPersistSessionMetadata()) {
    sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  return appConnection.model<SessionDoc>("Session", sessionSchema);
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
const TTL_MS = TTL_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

function redisSessionKey(sessionId: string) {
  return `session:${getAppName()}:${sessionId}`;
}
function redisUserSessionsKey(userId: string) {
  return `usersessions:${getAppName()}:${userId}`;
}

async function redisCreateSession(userId: string, token: string, sessionId: string, metadata?: SessionMetadata): Promise<void> {
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  const record = JSON.stringify({
    sessionId, userId, token,
    createdAt: now, lastActiveAt: now, expiresAt,
    ipAddress: metadata?.ipAddress,
    userAgent: metadata?.userAgent,
  });
  const redis = getRedis();
  const persist = getPersistSessionMetadata();
  if (persist) {
    await redis.set(redisSessionKey(sessionId), record);
  } else {
    await redis.set(redisSessionKey(sessionId), record, "EX", TTL_SECONDS);
  }
  // Sorted set: score = createdAt (oldest first)
  await redis.zadd(redisUserSessionsKey(userId), now, sessionId);
}

async function redisGetSession(sessionId: string): Promise<string | null> {
  const raw = await getRedis().get(redisSessionKey(sessionId));
  if (!raw) return null;
  const rec = JSON.parse(raw) as { token: string | null; expiresAt: number };
  if (!rec.token) return null;
  if (rec.expiresAt <= Date.now()) return null;
  return rec.token;
}

async function redisDeleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(redisSessionKey(sessionId));
  if (!raw) return;
  const rec = JSON.parse(raw) as { userId: string; expiresAt: number };
  const persist = getPersistSessionMetadata();
  if (persist) {
    const updated = { ...JSON.parse(raw), token: null };
    await redis.set(redisSessionKey(sessionId), JSON.stringify(updated));
  } else {
    await redis.del(redisSessionKey(sessionId));
  }
  if (!persist) {
    await redis.zrem(redisUserSessionsKey(rec.userId), sessionId);
  }
}

async function redisGetUserSessions(userId: string): Promise<SessionInfo[]> {
  const redis = getRedis();
  const sessionIds = await redis.zrange(redisUserSessionsKey(userId), 0, -1);
  if (!sessionIds.length) return [];
  const now = Date.now();
  const raws = await redis.mget(...sessionIds.map(redisSessionKey));
  const results: SessionInfo[] = [];
  const toRemove: string[] = [];
  for (let i = 0; i < sessionIds.length; i++) {
    const raw = raws[i];
    if (!raw) {
      toRemove.push(sessionIds[i]);
      continue;
    }
    const rec = JSON.parse(raw) as SessionDoc & { createdAt: number; lastActiveAt: number; expiresAt: number };
    const isActive = !!rec.token && rec.expiresAt > now;
    if (!isActive && !getPersistSessionMetadata()) {
      toRemove.push(sessionIds[i]);
      continue;
    }
    if (!isActive && !getIncludeInactiveSessions()) continue;
    results.push({
      sessionId: rec.sessionId,
      createdAt: Number(rec.createdAt),
      lastActiveAt: Number(rec.lastActiveAt),
      expiresAt: Number(rec.expiresAt),
      ipAddress: rec.ipAddress,
      userAgent: rec.userAgent,
      isActive,
    });
  }
  if (toRemove.length) {
    await redis.zrem(redisUserSessionsKey(userId), ...toRemove);
  }
  return results;
}

async function redisGetActiveSessionCount(userId: string): Promise<number> {
  const sessions = await redisGetUserSessions(userId);
  return sessions.filter((s) => s.isActive).length;
}

async function redisEvictOldestSession(userId: string): Promise<void> {
  const redis = getRedis();
  // Sorted set is ordered oldest-first (score = createdAt)
  const sessionIds = await redis.zrange(redisUserSessionsKey(userId), 0, -1);
  const now = Date.now();
  for (const sessionId of sessionIds) {
    const raw = await redis.get(redisSessionKey(sessionId));
    if (!raw) { await redis.zrem(redisUserSessionsKey(userId), sessionId); continue; }
    const rec = JSON.parse(raw) as { token: string | null; expiresAt: number };
    if (rec.token && rec.expiresAt > now) {
      await redisDeleteSession(sessionId);
      return;
    }
  }
}

async function redisUpdateSessionLastActive(sessionId: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(redisSessionKey(sessionId));
  if (!raw) return;
  const rec = JSON.parse(raw);
  rec.lastActiveAt = Date.now();
  if (getPersistSessionMetadata()) {
    await redis.set(redisSessionKey(sessionId), JSON.stringify(rec));
  } else {
    const now = Date.now();
    if (rec.expiresAt <= now) {
      await redisDeleteSession(sessionId);
      return;
    }
    const ttlRemaining = Math.max(1, Math.ceil((rec.expiresAt - now) / 1000));
    await redis.set(redisSessionKey(sessionId), JSON.stringify(rec), "EX", ttlRemaining);
  }
}

// ---------------------------------------------------------------------------
// Mongo helpers
// ---------------------------------------------------------------------------

async function mongoGetUserSessions(userId: string): Promise<SessionInfo[]> {
  const now = new Date();
  const includeInactive = getIncludeInactiveSessions();
  const persist = getPersistSessionMetadata();
  const query: Record<string, unknown> = { userId };
  if (!includeInactive) {
    query.token = { $ne: null };
    query.expiresAt = { $gt: now };
  }
  const docs = await getSessionModel().find(query).lean();
  const results: SessionInfo[] = [];
  for (const doc of docs) {
    const isActive = !!doc.token && doc.expiresAt > now;
    if (!isActive && !persist) continue;
    if (!isActive && !includeInactive) continue;
    results.push({
      sessionId: doc.sessionId,
      createdAt: doc.createdAt.getTime(),
      lastActiveAt: doc.lastActiveAt.getTime(),
      expiresAt: doc.expiresAt.getTime(),
      ipAddress: doc.ipAddress,
      userAgent: doc.userAgent,
      isActive,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createSession = async (
  userId: string,
  token: string,
  sessionId: string,
  metadata?: SessionMetadata,
): Promise<void> => {
  if (_store === "memory") { memoryCreateSession(userId, token, sessionId, metadata); return; }
  if (_store === "sqlite") { sqliteCreateSession(userId, token, sessionId, metadata); return; }
  if (_store === "redis")  { await redisCreateSession(userId, token, sessionId, metadata); return; }

  // mongo
  const now = new Date();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await getSessionModel().create({
    sessionId, userId, token,
    createdAt: now, lastActiveAt: now, expiresAt,
    ipAddress: metadata?.ipAddress,
    userAgent: metadata?.userAgent,
  });
};

export const getSession = async (sessionId: string): Promise<string | null> => {
  if (_store === "memory") return memoryGetSession(sessionId);
  if (_store === "sqlite") return sqliteGetSession(sessionId);
  if (_store === "redis")  return redisGetSession(sessionId);

  // mongo
  const doc = await getSessionModel()
    .findOne({ sessionId, expiresAt: { $gt: new Date() } }, "token")
    .lean();
  return doc?.token ?? null;
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  if (_store === "memory") { memoryDeleteSession(sessionId); return; }
  if (_store === "sqlite") { sqliteDeleteSession(sessionId); return; }
  if (_store === "redis")  { await redisDeleteSession(sessionId); return; }

  // mongo
  if (getPersistSessionMetadata()) {
    await getSessionModel().updateOne({ sessionId }, { $set: { token: null } });
  } else {
    await getSessionModel().deleteOne({ sessionId });
  }
};

export const getUserSessions = async (userId: string): Promise<SessionInfo[]> => {
  if (_store === "memory") return memoryGetUserSessions(userId);
  if (_store === "sqlite") return sqliteGetUserSessions(userId);
  if (_store === "redis")  return redisGetUserSessions(userId);
  return mongoGetUserSessions(userId);
};

export const getActiveSessionCount = async (userId: string): Promise<number> => {
  if (_store === "memory") return memoryGetActiveSessionCount(userId);
  if (_store === "sqlite") return sqliteGetActiveSessionCount(userId);
  if (_store === "redis")  return redisGetActiveSessionCount(userId);

  // mongo
  const now = new Date();
  return getSessionModel().countDocuments({ userId, token: { $ne: null }, expiresAt: { $gt: now } });
};

export const evictOldestSession = async (userId: string): Promise<void> => {
  if (_store === "memory") { memoryEvictOldestSession(userId); return; }
  if (_store === "sqlite") { sqliteEvictOldestSession(userId); return; }
  if (_store === "redis")  { await redisEvictOldestSession(userId); return; }

  // mongo — oldest active session by createdAt
  const now = new Date();
  const oldest = await getSessionModel()
    .findOne({ userId, token: { $ne: null }, expiresAt: { $gt: now } }, "sessionId")
    .sort({ createdAt: 1 })
    .lean();
  if (oldest) await deleteSession(oldest.sessionId);
};

export const deleteUserSessions = async (userId: string): Promise<void> => {
  const sessions = await getUserSessions(userId);
  await Promise.all(sessions.map((s) => deleteSession(s.sessionId)));
};

export const updateSessionLastActive = async (sessionId: string): Promise<void> => {
  if (_store === "memory") { memoryUpdateSessionLastActive(sessionId); return; }
  if (_store === "sqlite") { sqliteUpdateSessionLastActive(sessionId); return; }
  if (_store === "redis")  { await redisUpdateSessionLastActive(sessionId); return; }

  // mongo
  await getSessionModel().updateOne({ sessionId }, { $set: { lastActiveAt: new Date() } });
};
