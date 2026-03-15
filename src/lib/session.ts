import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName, getPersistSessionMetadata, getIncludeInactiveSessions, getRefreshTokenConfig, getRotationGraceSeconds, getRefreshTokenExpiry } from "./appConfig";
import {
  sqliteCreateSession,
  sqliteGetSession,
  sqliteDeleteSession,
  sqliteGetUserSessions,
  sqliteGetActiveSessionCount,
  sqliteEvictOldestSession,
  sqliteUpdateSessionLastActive,
  sqliteSetRefreshToken,
  sqliteGetSessionByRefreshToken,
  sqliteRotateRefreshToken,
} from "../adapters/sqliteAuth";
import {
  memoryCreateSession,
  memoryGetSession,
  memoryDeleteSession,
  memoryGetUserSessions,
  memoryGetActiveSessionCount,
  memoryEvictOldestSession,
  memoryUpdateSessionLastActive,
  memorySetRefreshToken,
  memoryGetSessionByRefreshToken,
  memoryRotateRefreshToken,
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
  refreshToken?: string | null;
  prevRefreshToken?: string | null;
  prevTokenExpiresAt?: Date | null;
}

export interface RefreshResult {
  sessionId: string;
  userId: string;
  newRefreshToken: string;
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
      refreshToken:      { type: String, default: null, sparse: true },
      prevRefreshToken:  { type: String, default: null },
      prevTokenExpiresAt:{ type: Date,   default: null },
    },
    { collection: "sessions", timestamps: false }
  );
  sessionSchema.index({ refreshToken: 1 }, { sparse: true, unique: true });
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
function redisRefreshTokenKey(refreshToken: string) {
  return `refreshtoken:${getAppName()}:${refreshToken}`;
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
  const rec = JSON.parse(raw) as { userId: string; expiresAt: number; refreshToken?: string; prevRefreshToken?: string };
  const persist = getPersistSessionMetadata();

  // Clean up refresh token reverse-lookup keys
  if (rec.refreshToken) await redis.del(redisRefreshTokenKey(rec.refreshToken));
  if (rec.prevRefreshToken) await redis.del(redisRefreshTokenKey(rec.prevRefreshToken));

  if (persist) {
    const updated = { ...rec, token: null, refreshToken: null, prevRefreshToken: null, prevTokenExpiresAt: null };
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

async function redisSetRefreshToken(sessionId: string, refreshToken: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(redisSessionKey(sessionId));
  if (!raw) return;
  const rec = JSON.parse(raw);
  rec.refreshToken = refreshToken;
  const refreshExpiry = getRefreshTokenExpiry();
  await redis.set(redisSessionKey(sessionId), JSON.stringify(rec));
  await redis.set(redisRefreshTokenKey(refreshToken), sessionId, "EX", refreshExpiry);
}

async function redisGetSessionByRefreshToken(refreshToken: string): Promise<RefreshResult | null> {
  const redis = getRedis();
  const sessionId = await redis.get(redisRefreshTokenKey(refreshToken));
  if (!sessionId) return null;
  const raw = await redis.get(redisSessionKey(sessionId));
  if (!raw) return null;
  const rec = JSON.parse(raw) as { sessionId: string; userId: string; refreshToken?: string; prevRefreshToken?: string; prevTokenExpiresAt?: number; token?: string | null };

  // Current refresh token matches
  if (rec.refreshToken === refreshToken) {
    return { sessionId: rec.sessionId, userId: rec.userId, newRefreshToken: refreshToken };
  }

  // Check grace window: old token used within grace period
  if (rec.prevRefreshToken === refreshToken && rec.prevTokenExpiresAt && rec.prevTokenExpiresAt > Date.now()) {
    // Return current refresh token — client missed the rotation response
    return { sessionId: rec.sessionId, userId: rec.userId, newRefreshToken: rec.refreshToken! };
  }

  // Old token used after grace window — token family theft detected, invalidate session
  if (rec.prevRefreshToken === refreshToken) {
    await redisDeleteSession(sessionId);
    return null;
  }

  return null;
}

async function redisRotateRefreshToken(sessionId: string, newRefreshToken: string, newAccessToken: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(redisSessionKey(sessionId));
  if (!raw) return;
  const rec = JSON.parse(raw);
  const graceSeconds = getRotationGraceSeconds();
  const refreshExpiry = getRefreshTokenExpiry();

  // Move current to prev with grace window
  const oldRefreshToken = rec.refreshToken;
  rec.prevRefreshToken = oldRefreshToken;
  rec.prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
  rec.refreshToken = newRefreshToken;
  rec.token = newAccessToken;

  await redis.set(redisSessionKey(sessionId), JSON.stringify(rec));
  // Set new reverse-lookup with full refresh expiry
  await redis.set(redisRefreshTokenKey(newRefreshToken), sessionId, "EX", refreshExpiry);
  // Update old reverse-lookup to expire after grace window
  if (oldRefreshToken) {
    await redis.expire(redisRefreshTokenKey(oldRefreshToken), graceSeconds);
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

async function mongoSetRefreshToken(sessionId: string, refreshToken: string): Promise<void> {
  await getSessionModel().updateOne({ sessionId }, { $set: { refreshToken } });
}

async function mongoGetSessionByRefreshToken(refreshToken: string): Promise<RefreshResult | null> {
  const Session = getSessionModel();

  // Check current refresh token
  let doc = await Session.findOne({ refreshToken }).lean() as SessionDoc | null;
  if (doc) {
    return { sessionId: doc.sessionId, userId: doc.userId, newRefreshToken: refreshToken };
  }

  // Check previous refresh token (grace window)
  doc = await Session.findOne({ prevRefreshToken: refreshToken }).lean() as SessionDoc | null;
  if (!doc) return null;

  if (doc.prevTokenExpiresAt && doc.prevTokenExpiresAt > new Date()) {
    // Within grace window — return current refresh token
    return { sessionId: doc.sessionId, userId: doc.userId, newRefreshToken: doc.refreshToken! };
  }

  // Grace window expired — token family theft detected, invalidate session
  if (getPersistSessionMetadata()) {
    await Session.updateOne({ sessionId: doc.sessionId }, { $set: { token: null, refreshToken: null, prevRefreshToken: null, prevTokenExpiresAt: null } });
  } else {
    await Session.deleteOne({ sessionId: doc.sessionId });
  }
  return null;
}

async function mongoRotateRefreshToken(sessionId: string, newRefreshToken: string, newAccessToken: string): Promise<void> {
  const graceSeconds = getRotationGraceSeconds();
  const Session = getSessionModel();
  const doc = await Session.findOne({ sessionId });
  if (!doc) return;

  doc.prevRefreshToken = doc.refreshToken;
  doc.prevTokenExpiresAt = new Date(Date.now() + graceSeconds * 1000);
  doc.refreshToken = newRefreshToken;
  doc.token = newAccessToken;
  await doc.save();
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
    await getSessionModel().updateOne({ sessionId }, { $set: { token: null, refreshToken: null, prevRefreshToken: null, prevTokenExpiresAt: null } });
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

// ---------------------------------------------------------------------------
// Refresh token API
// ---------------------------------------------------------------------------

/** Store a refresh token on an existing session (called after session creation). */
export const setRefreshToken = async (sessionId: string, refreshToken: string): Promise<void> => {
  if (_store === "memory") { memorySetRefreshToken(sessionId, refreshToken); return; }
  if (_store === "sqlite") { sqliteSetRefreshToken(sessionId, refreshToken); return; }
  if (_store === "redis")  { await redisSetRefreshToken(sessionId, refreshToken); return; }
  await mongoSetRefreshToken(sessionId, refreshToken);
};

/** Look up a session by refresh token. Handles grace window and theft detection. */
export const getSessionByRefreshToken = async (refreshToken: string): Promise<RefreshResult | null> => {
  if (_store === "memory") return memoryGetSessionByRefreshToken(refreshToken);
  if (_store === "sqlite") return sqliteGetSessionByRefreshToken(refreshToken);
  if (_store === "redis")  return redisGetSessionByRefreshToken(refreshToken);
  return mongoGetSessionByRefreshToken(refreshToken);
};

/** Rotate the refresh token: move current to prev with grace window, set new token + access token. */
export const rotateRefreshToken = async (sessionId: string, newRefreshToken: string, newAccessToken: string): Promise<void> => {
  if (_store === "memory") { memoryRotateRefreshToken(sessionId, newRefreshToken, newAccessToken); return; }
  if (_store === "sqlite") { sqliteRotateRefreshToken(sessionId, newRefreshToken, newAccessToken); return; }
  if (_store === "redis")  { await redisRotateRefreshToken(sessionId, newRefreshToken, newAccessToken); return; }
  await mongoRotateRefreshToken(sessionId, newRefreshToken, newAccessToken);
};
