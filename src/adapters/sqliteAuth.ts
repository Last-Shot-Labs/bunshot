import { Database } from "bun:sqlite";
import { HttpError } from "@lib/HttpError";
import type { AuthAdapter } from "@lib/authAdapter";

// ---------------------------------------------------------------------------
// DB singleton — call setSqliteDb(path) once at startup
// ---------------------------------------------------------------------------

let _db: Database | null = null;

export const setSqliteDb = (path: string): void => {
  _db = new Database(path, { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  initSchema(_db);
};

function getDb(): Database {
  if (!_db) throw new Error("SQLite not initialized — call setSqliteDb(path) before using sqliteAuthAdapter or sessionStore: 'sqlite'");
  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    passwordHash  TEXT,
    providerIds   TEXT NOT NULL DEFAULT '[]',
    roles         TEXT NOT NULL DEFAULT '[]',
    emailVerified INTEGER NOT NULL DEFAULT 0
  )`);
  // Add emailVerified to pre-existing databases that lack the column
  try { db.run("ALTER TABLE users ADD COLUMN emailVerified INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  // Migrate legacy sessions table (userId PK) to new multi-session schema (sessionId PK)
  try { db.run("ALTER TABLE sessions RENAME TO sessions_legacy"); } catch { /* already migrated */ }
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    sessionId    TEXT PRIMARY KEY,
    userId       TEXT NOT NULL,
    token        TEXT,
    createdAt    INTEGER NOT NULL,
    lastActiveAt INTEGER NOT NULL,
    expiresAt    INTEGER NOT NULL,
    ipAddress    TEXT,
    userAgent    TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId)");
  db.run(`CREATE TABLE IF NOT EXISTS oauth_states (
    state        TEXT PRIMARY KEY,
    codeVerifier TEXT,
    linkUserId   TEXT,
    expiresAt    INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS cache_entries (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    expiresAt INTEGER  -- NULL = indefinite
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
    token     TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    email     TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    token     TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    email     TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);
}

// ---------------------------------------------------------------------------
// Auth adapter
// ---------------------------------------------------------------------------

export const sqliteAuthAdapter: AuthAdapter = {
  async findByEmail(email) {
    const row = getDb().query<{ id: string; passwordHash: string }, [string]>(
      "SELECT id, passwordHash FROM users WHERE email = ?"
    ).get(email);
    return row ?? null;
  },

  async create(email, passwordHash) {
    const id = crypto.randomUUID();
    try {
      getDb().run("INSERT INTO users (id, email, passwordHash) VALUES (?, ?, ?)", [id, email, passwordHash]);
      return { id };
    } catch (err: any) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") throw new HttpError(409, "Email already registered");
      throw err;
    }
  },

  async setPassword(userId, passwordHash) {
    getDb().run("UPDATE users SET passwordHash = ? WHERE id = ?", [passwordHash, userId]);
  },

  async findOrCreateByProvider(provider, providerId, profile) {
    const key = `${provider}:${providerId}`;
    const db = getDb();

    // Find by provider key using json_each
    const existing = db.query<{ id: string }, [string]>(
      "SELECT u.id FROM users u, json_each(u.providerIds) p WHERE p.value = ?"
    ).get(key);
    if (existing) return { id: existing.id, created: false };

    // Reject if email belongs to a credential account
    if (profile.email) {
      const emailUser = db.query<{ id: string }, [string]>(
        "SELECT id FROM users WHERE email = ?"
      ).get(profile.email);
      if (emailUser) throw new HttpError(409, "An account with this email already exists. Sign in with your credentials, then link Google from your account settings.");
    }

    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO users (id, email, providerIds) VALUES (?, ?, ?)",
      [id, profile.email ?? null, JSON.stringify([key])]
    );
    return { id, created: true };
  },

  async linkProvider(userId, provider, providerId) {
    const key = `${provider}:${providerId}`;
    const db = getDb();
    const row = db.query<{ id: string; providerIds: string }, [string]>(
      "SELECT id, providerIds FROM users WHERE id = ?"
    ).get(userId);
    if (!row) throw new HttpError(404, "User not found");
    const ids: string[] = JSON.parse(row.providerIds);
    if (!ids.includes(key)) {
      db.run("UPDATE users SET providerIds = ? WHERE id = ?", [JSON.stringify([...ids, key]), userId]);
    }
  },

  async getRoles(userId) {
    const row = getDb().query<{ roles: string }, [string]>(
      "SELECT roles FROM users WHERE id = ?"
    ).get(userId);
    return row ? JSON.parse(row.roles) : [];
  },

  async setRoles(userId, roles) {
    getDb().run("UPDATE users SET roles = ? WHERE id = ?", [JSON.stringify(roles), userId]);
  },

  async addRole(userId, role) {
    const db = getDb();
    const row = db.query<{ roles: string }, [string]>("SELECT roles FROM users WHERE id = ?").get(userId);
    if (!row) return;
    const roles: string[] = JSON.parse(row.roles);
    if (!roles.includes(role)) {
      db.run("UPDATE users SET roles = ? WHERE id = ?", [JSON.stringify([...roles, role]), userId]);
    }
  },

  async removeRole(userId, role) {
    const db = getDb();
    const row = db.query<{ roles: string }, [string]>("SELECT roles FROM users WHERE id = ?").get(userId);
    if (!row) return;
    const roles: string[] = JSON.parse(row.roles);
    db.run("UPDATE users SET roles = ? WHERE id = ?", [JSON.stringify(roles.filter((r) => r !== role)), userId]);
  },

  async getUser(userId) {
    const row = getDb().query<{ email: string | null; providerIds: string; emailVerified: number }, [string]>(
      "SELECT email, providerIds, emailVerified FROM users WHERE id = ?"
    ).get(userId);
    if (!row) return null;
    return {
      email: row.email ?? undefined,
      providerIds: JSON.parse(row.providerIds),
      emailVerified: row.emailVerified === 1,
    };
  },

  async unlinkProvider(userId, provider) {
    const db = getDb();
    const row = db.query<{ providerIds: string }, [string]>(
      "SELECT providerIds FROM users WHERE id = ?"
    ).get(userId);
    if (!row) throw new HttpError(404, "User not found");
    const ids: string[] = JSON.parse(row.providerIds);
    db.run(
      "UPDATE users SET providerIds = ? WHERE id = ?",
      [JSON.stringify(ids.filter((id) => !id.startsWith(`${provider}:`))), userId]
    );
  },

  async findByIdentifier(value) {
    const row = getDb().query<{ id: string; passwordHash: string }, [string]>(
      "SELECT id, passwordHash FROM users WHERE email = ?"
    ).get(value);
    return row ?? null;
  },

  async setEmailVerified(userId, verified) {
    getDb().run("UPDATE users SET emailVerified = ? WHERE id = ?", [verified ? 1 : 0, userId]);
  },

  async getEmailVerified(userId) {
    const row = getDb().query<{ emailVerified: number }, [string]>(
      "SELECT emailVerified FROM users WHERE id = ?"
    ).get(userId);
    return row?.emailVerified === 1;
  },
};

// ---------------------------------------------------------------------------
// Session helpers (used by src/lib/session.ts)
// ---------------------------------------------------------------------------

import type { SessionMetadata, SessionInfo } from "@lib/session";
import { getPersistSessionMetadata, getIncludeInactiveSessions } from "@lib/appConfig";

const SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000; // 7 days

export const sqliteCreateSession = (userId: string, token: string, sessionId: string, metadata?: SessionMetadata): void => {
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getDb().run(
    "INSERT INTO sessions (sessionId, userId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [sessionId, userId, token, now, now, expiresAt, metadata?.ipAddress ?? null, metadata?.userAgent ?? null]
  );
};

export const sqliteGetSession = (sessionId: string): string | null => {
  const row = getDb().query<{ token: string | null }, [string, number]>(
    "SELECT token FROM sessions WHERE sessionId = ? AND expiresAt > ?"
  ).get(sessionId, Date.now());
  if (!row || !row.token) return null;
  return row.token;
};

export const sqliteDeleteSession = (sessionId: string): void => {
  if (getPersistSessionMetadata()) {
    getDb().run("UPDATE sessions SET token = NULL WHERE sessionId = ?", [sessionId]);
  } else {
    getDb().run("DELETE FROM sessions WHERE sessionId = ?", [sessionId]);
  }
};

export const sqliteGetUserSessions = (userId: string): SessionInfo[] => {
  const now = Date.now();
  const rows = getDb().query<{
    sessionId: string; createdAt: number; lastActiveAt: number; expiresAt: number;
    token: string | null; ipAddress: string | null; userAgent: string | null;
  }, [string]>(
    "SELECT sessionId, token, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent FROM sessions WHERE userId = ? ORDER BY createdAt ASC"
  ).all(userId);

  const includeInactive = getIncludeInactiveSessions();
  const persist = getPersistSessionMetadata();
  const results: SessionInfo[] = [];
  for (const row of rows) {
    const isActive = !!row.token && row.expiresAt > now;
    if (!isActive && !persist) continue;
    if (!isActive && !includeInactive) continue;
    results.push({
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.expiresAt,
      ipAddress: row.ipAddress ?? undefined,
      userAgent: row.userAgent ?? undefined,
      isActive,
    });
  }
  return results;
};

export const sqliteGetActiveSessionCount = (userId: string): number => {
  const row = getDb().query<{ count: number }, [string, number]>(
    "SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ?"
  ).get(userId, Date.now());
  return row?.count ?? 0;
};

export const sqliteEvictOldestSession = (userId: string): void => {
  const now = Date.now();
  const oldest = getDb().query<{ sessionId: string }, [string, number]>(
    "SELECT sessionId FROM sessions WHERE userId = ? AND token IS NOT NULL AND expiresAt > ? ORDER BY createdAt ASC LIMIT 1"
  ).get(userId, now);
  if (oldest) sqliteDeleteSession(oldest.sessionId);
};

export const sqliteUpdateSessionLastActive = (sessionId: string): void => {
  getDb().run("UPDATE sessions SET lastActiveAt = ? WHERE sessionId = ?", [Date.now(), sessionId]);
};

// ---------------------------------------------------------------------------
// OAuth state helpers (used by src/lib/oauth.ts)
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const sqliteStoreOAuthState = (state: string, codeVerifier?: string, linkUserId?: string): void => {
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  getDb().run(
    "INSERT INTO oauth_states (state, codeVerifier, linkUserId, expiresAt) VALUES (?, ?, ?, ?)",
    [state, codeVerifier ?? null, linkUserId ?? null, expiresAt]
  );
};

export const sqliteConsumeOAuthState = (state: string): { codeVerifier?: string; linkUserId?: string } | null => {
  const row = getDb().query<{ codeVerifier: string | null; linkUserId: string | null }, [string, number]>(
    "DELETE FROM oauth_states WHERE state = ? AND expiresAt > ? RETURNING codeVerifier, linkUserId"
  ).get(state, Date.now());
  if (!row) return null;
  return {
    codeVerifier: row.codeVerifier ?? undefined,
    linkUserId: row.linkUserId ?? undefined,
  };
};

// ---------------------------------------------------------------------------
// Cache helpers (used by src/middleware/cacheResponse.ts)
// ---------------------------------------------------------------------------

export const isSqliteReady = (): boolean => _db !== null;

export const sqliteGetCache = (key: string): string | null => {
  const row = getDb().query<{ value: string }, [string, number]>(
    "SELECT value FROM cache_entries WHERE key = ? AND (expiresAt IS NULL OR expiresAt > ?)"
  ).get(key, Date.now());
  return row?.value ?? null;
};

export const sqliteSetCache = (key: string, value: string, ttlSeconds?: number): void => {
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
  getDb().run(
    "INSERT INTO cache_entries (key, value, expiresAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt",
    [key, value, expiresAt]
  );
};

export const sqliteDelCache = (key: string): void => {
  getDb().run("DELETE FROM cache_entries WHERE key = ?", [key]);
};

export const sqliteDelCachePattern = (pattern: string): void => {
  // Convert glob pattern (* wildcard) to a SQL LIKE pattern (% wildcard)
  const likePattern = pattern.replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%");
  getDb().run("DELETE FROM cache_entries WHERE key LIKE ? ESCAPE '\\'", [likePattern]);
};

// ---------------------------------------------------------------------------
// Email verification token helpers (used by src/lib/emailVerification.ts)
// ---------------------------------------------------------------------------

export const sqliteCreateVerificationToken = (token: string, userId: string, email: string, ttlSeconds: number): void => {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  getDb().run(
    "INSERT INTO email_verifications (token, userId, email, expiresAt) VALUES (?, ?, ?, ?)",
    [token, userId, email, expiresAt]
  );
};

export const sqliteGetVerificationToken = (token: string): { userId: string; email: string } | null => {
  const row = getDb().query<{ userId: string; email: string }, [string, number]>(
    "SELECT userId, email FROM email_verifications WHERE token = ? AND expiresAt > ?"
  ).get(token, Date.now());
  return row ?? null;
};

export const sqliteDeleteVerificationToken = (token: string): void => {
  getDb().run("DELETE FROM email_verifications WHERE token = ?", [token]);
};

// ---------------------------------------------------------------------------
// Password reset token helpers (used by src/lib/resetPassword.ts)
// ---------------------------------------------------------------------------

export const sqliteCreateResetToken = (token: string, userId: string, email: string, ttlSeconds: number): void => {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  getDb().run(
    "INSERT INTO password_resets (token, userId, email, expiresAt) VALUES (?, ?, ?, ?)",
    [token, userId, email, expiresAt]
  );
};

export const sqliteGetResetToken = (token: string): { userId: string; email: string } | null => {
  const row = getDb().query<{ userId: string; email: string }, [string, number]>(
    "SELECT userId, email FROM password_resets WHERE token = ? AND expiresAt > ?"
  ).get(token, Date.now());
  return row ?? null;
};

export const sqliteDeleteResetToken = (token: string): void => {
  getDb().run("DELETE FROM password_resets WHERE token = ?", [token]);
};

// ---------------------------------------------------------------------------
// Optional periodic cleanup of expired rows
// ---------------------------------------------------------------------------

export const startSqliteCleanup = (intervalMs = 3_600_000): ReturnType<typeof setInterval> => {
  return setInterval(() => {
    const db = getDb();
    const now = Date.now();
    if (getPersistSessionMetadata()) {
      // Null out tokens for expired sessions but keep the metadata row
      db.run("UPDATE sessions SET token = NULL WHERE expiresAt <= ? AND token IS NOT NULL", [now]);
    } else {
      db.run("DELETE FROM sessions WHERE expiresAt <= ?", [now]);
    }
    db.run("DELETE FROM oauth_states WHERE expiresAt <= ?", [now]);
    db.run("DELETE FROM cache_entries WHERE expiresAt IS NOT NULL AND expiresAt <= ?", [now]);
    db.run("DELETE FROM email_verifications WHERE expiresAt <= ?", [now]);
    db.run("DELETE FROM password_resets WHERE expiresAt <= ?", [now]);
  }, intervalMs);
};
