import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName, getMfaChallengeTtl } from "./appConfig";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MfaChallengePurpose = "login" | "webauthn-registration";

export interface MfaChallengeOptions {
  emailOtpHash?: string;
  webauthnChallenge?: string;
}

export interface MfaChallengeData {
  userId: string;
  purpose: MfaChallengePurpose;
  emailOtpHash?: string;
  webauthnChallenge?: string;
}

interface MfaChallengeRecord {
  userId: string;
  purpose: MfaChallengePurpose;
  emailOtpHash?: string;
  webauthnChallenge?: string;
  createdAt: number;
  resendCount: number;
}

const MAX_RESENDS = 3;

// ---------------------------------------------------------------------------
// Mongo model
// ---------------------------------------------------------------------------

interface MfaChallengeDoc {
  token: string;
  userId: string;
  purpose: string;
  emailOtpHash?: string;
  webauthnChallenge?: string;
  createdAt: Date;
  resendCount: number;
  expiresAt: Date;
}

function getMfaChallengeModel() {
  if (appConnection.models["MfaChallenge"]) return appConnection.models["MfaChallenge"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const schema = new Schema<MfaChallengeDoc>(
    {
      token:             { type: String, required: true, unique: true },
      userId:            { type: String, required: true },
      purpose:           { type: String, required: true, default: "login" },
      emailOtpHash:      { type: String },
      webauthnChallenge: { type: String },
      createdAt:         { type: Date,   required: true },
      resendCount:       { type: Number, required: true, default: 0 },
      expiresAt:         { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
    },
    { collection: "mfa_challenges" }
  );
  return appConnection.model<MfaChallengeDoc>("MfaChallenge", schema);
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _memoryChallenges = new Map<string, MfaChallengeRecord & { expiresAt: number }>();

// ---------------------------------------------------------------------------
// SQLite store (reuses the existing SQLite DB instance)
// ---------------------------------------------------------------------------

let _sqliteDb: any = null;
let _sqliteTableCreated = false;

/** Must be called when store is "sqlite" to inject the db instance. */
export const setMfaChallengeSqliteDb = (db: any) => { _sqliteDb = db; };

function ensureSqliteMfaTable() {
  if (_sqliteTableCreated || !_sqliteDb) return;
  _sqliteDb.run(`CREATE TABLE IF NOT EXISTS mfa_challenges (
    token             TEXT PRIMARY KEY,
    userId            TEXT NOT NULL,
    purpose           TEXT NOT NULL DEFAULT 'login',
    emailOtpHash      TEXT,
    webauthnChallenge TEXT,
    createdAt         INTEGER NOT NULL,
    resendCount       INTEGER NOT NULL DEFAULT 0,
    expiresAt         INTEGER NOT NULL
  )`);
  // Migrate pre-existing tables that lack newer columns
  try { _sqliteDb.run("ALTER TABLE mfa_challenges ADD COLUMN emailOtpHash TEXT"); } catch { /* already exists */ }
  try { _sqliteDb.run("ALTER TABLE mfa_challenges ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { _sqliteDb.run("ALTER TABLE mfa_challenges ADD COLUMN resendCount INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { _sqliteDb.run("ALTER TABLE mfa_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'"); } catch { /* already exists */ }
  try { _sqliteDb.run("ALTER TABLE mfa_challenges ADD COLUMN webauthnChallenge TEXT"); } catch { /* already exists */ }
  _sqliteTableCreated = true;
}

// ---------------------------------------------------------------------------
// Store configuration
// ---------------------------------------------------------------------------

type MfaChallengeStore = "redis" | "mongo" | "sqlite" | "memory";
let _store: MfaChallengeStore = "redis";
export const setMfaChallengeStore = (store: MfaChallengeStore) => { _store = store; };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createMfaChallenge = async (userId: string, options?: MfaChallengeOptions): Promise<string> => {
  const token = crypto.randomUUID();
  const ttl = getMfaChallengeTtl();
  const now = Date.now();
  const purpose: MfaChallengePurpose = "login";
  const emailOtpHash = options?.emailOtpHash;
  const webauthnChallenge = options?.webauthnChallenge;

  if (_store === "memory") {
    _memoryChallenges.set(token, { userId, purpose, emailOtpHash, webauthnChallenge, createdAt: now, resendCount: 0, expiresAt: now + ttl * 1000 });
    return token;
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    _sqliteDb.run(
      "INSERT INTO mfa_challenges (token, userId, purpose, emailOtpHash, webauthnChallenge, createdAt, resendCount, expiresAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      [token, userId, purpose, emailOtpHash ?? null, webauthnChallenge ?? null, now, now + ttl * 1000]
    );
    return token;
  }

  if (_store === "mongo") {
    await getMfaChallengeModel().create({
      token,
      userId,
      purpose,
      emailOtpHash,
      webauthnChallenge,
      createdAt: new Date(now),
      resendCount: 0,
      expiresAt: new Date(now + ttl * 1000),
    });
    return token;
  }

  // redis
  await getRedis().set(
    `mfachallenge:${getAppName()}:${token}`,
    JSON.stringify({ userId, purpose, emailOtpHash, webauthnChallenge, createdAt: now, resendCount: 0 }),
    "EX",
    ttl
  );
  return token;
};

export const consumeMfaChallenge = async (token: string): Promise<MfaChallengeData | null> => {
  if (_store === "memory") {
    const entry = _memoryChallenges.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      _memoryChallenges.delete(token);
      return null;
    }
    _memoryChallenges.delete(token);
    if (entry.purpose !== "login") return null;
    return { userId: entry.userId, purpose: entry.purpose, emailOtpHash: entry.emailOtpHash, webauthnChallenge: entry.webauthnChallenge };
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    const row = _sqliteDb.query(
      "DELETE FROM mfa_challenges WHERE token = ? AND expiresAt > ? RETURNING userId, purpose, emailOtpHash, webauthnChallenge"
    ).get(token, Date.now()) as { userId: string; purpose: string; emailOtpHash: string | null; webauthnChallenge: string | null } | null;
    if (!row || row.purpose !== "login") return null;
    return { userId: row.userId, purpose: "login", emailOtpHash: row.emailOtpHash ?? undefined, webauthnChallenge: row.webauthnChallenge ?? undefined };
  }

  if (_store === "mongo") {
    const doc = await getMfaChallengeModel().findOneAndDelete({ token, expiresAt: { $gt: new Date() } });
    if (!doc || doc.purpose !== "login") return null;
    return { userId: doc.userId, purpose: "login", emailOtpHash: doc.emailOtpHash, webauthnChallenge: doc.webauthnChallenge };
  }

  // redis
  const key = `mfachallenge:${getAppName()}:${token}`;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  await getRedis().del(key);
  const data = JSON.parse(raw) as MfaChallengeRecord;
  if (data.purpose !== "login") return null;
  return { userId: data.userId, purpose: "login", emailOtpHash: data.emailOtpHash, webauthnChallenge: data.webauthnChallenge };
};

/**
 * Replace the email OTP hash on an existing challenge without consuming it.
 * Used for the resend flow. Increments resendCount and caps the challenge lifetime.
 * Returns { userId, resendCount } on success, null if challenge not found/expired/max resends reached.
 */
export const replaceMfaChallengeOtp = async (
  token: string,
  newEmailOtpHash: string
): Promise<{ userId: string; resendCount: number } | null> => {
  const ttl = getMfaChallengeTtl();

  if (_store === "memory") {
    const entry = _memoryChallenges.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      _memoryChallenges.delete(token);
      return null;
    }
    if (entry.resendCount >= MAX_RESENDS) return null;
    entry.emailOtpHash = newEmailOtpHash;
    entry.resendCount++;
    // Cap lifetime: min(now + ttl, createdAt + ttl * 3)
    const maxExpiry = entry.createdAt + ttl * 3 * 1000;
    entry.expiresAt = Math.min(Date.now() + ttl * 1000, maxExpiry);
    return { userId: entry.userId, resendCount: entry.resendCount };
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    const now = Date.now();
    const existing = _sqliteDb.query(
      "SELECT createdAt, resendCount FROM mfa_challenges WHERE token = ? AND expiresAt > ?"
    ).get(token, now) as { createdAt: number; resendCount: number } | null;
    if (!existing || existing.resendCount >= MAX_RESENDS) return null;
    const newExpiry = Math.min(now + ttl * 1000, existing.createdAt + ttl * 3 * 1000);
    const newCount = existing.resendCount + 1;
    const row = _sqliteDb.query(
      "UPDATE mfa_challenges SET emailOtpHash = ?, resendCount = ?, expiresAt = ? WHERE token = ? RETURNING userId"
    ).get(newEmailOtpHash, newCount, newExpiry, token) as { userId: string } | null;
    return row ? { userId: row.userId, resendCount: newCount } : null;
  }

  if (_store === "mongo") {
    const now = new Date();
    const doc = await getMfaChallengeModel().findOneAndUpdate(
      { token, expiresAt: { $gt: now }, resendCount: { $lt: MAX_RESENDS } },
      [
        {
          $set: {
            emailOtpHash: newEmailOtpHash,
            resendCount: { $add: ["$resendCount", 1] },
            expiresAt: {
              $min: [
                new Date(Date.now() + ttl * 1000),
                { $add: ["$createdAt", ttl * 3 * 1000] },
              ],
            },
          },
        },
      ],
      { new: true }
    );
    return doc ? { userId: doc.userId, resendCount: doc.resendCount } : null;
  }

  // redis
  const key = `mfachallenge:${getAppName()}:${token}`;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  const data = JSON.parse(raw) as MfaChallengeRecord;
  if (data.resendCount >= MAX_RESENDS) return null;
  data.emailOtpHash = newEmailOtpHash;
  data.resendCount++;
  // Cap lifetime
  const maxExpiry = data.createdAt + ttl * 3 * 1000;
  const newExpiry = Math.min(Date.now() + ttl * 1000, maxExpiry);
  const remainingTtl = Math.max(1, Math.ceil((newExpiry - Date.now()) / 1000));
  await getRedis().set(key, JSON.stringify(data), "EX", remainingTtl);
  return { userId: data.userId, resendCount: data.resendCount };
};

// ---------------------------------------------------------------------------
// WebAuthn registration challenge helpers
// ---------------------------------------------------------------------------

/**
 * Create a WebAuthn registration challenge token. Separate from the login flow —
 * uses `purpose: "webauthn-registration"` so it cannot be consumed by `consumeMfaChallenge`.
 */
export const createWebAuthnRegistrationChallenge = async (userId: string, challenge: string): Promise<string> => {
  const token = crypto.randomUUID();
  const ttl = getMfaChallengeTtl();
  const now = Date.now();
  const purpose: MfaChallengePurpose = "webauthn-registration";

  if (_store === "memory") {
    _memoryChallenges.set(token, { userId, purpose, webauthnChallenge: challenge, createdAt: now, resendCount: 0, expiresAt: now + ttl * 1000 });
    return token;
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    _sqliteDb.run(
      "INSERT INTO mfa_challenges (token, userId, purpose, webauthnChallenge, createdAt, resendCount, expiresAt) VALUES (?, ?, ?, ?, ?, 0, ?)",
      [token, userId, purpose, challenge, now, now + ttl * 1000]
    );
    return token;
  }

  if (_store === "mongo") {
    await getMfaChallengeModel().create({
      token,
      userId,
      purpose,
      webauthnChallenge: challenge,
      createdAt: new Date(now),
      resendCount: 0,
      expiresAt: new Date(now + ttl * 1000),
    });
    return token;
  }

  // redis
  await getRedis().set(
    `mfachallenge:${getAppName()}:${token}`,
    JSON.stringify({ userId, purpose, webauthnChallenge: challenge, createdAt: now, resendCount: 0 }),
    "EX",
    ttl
  );
  return token;
};

/**
 * Consume a WebAuthn registration challenge token.
 * Only accepts tokens with `purpose: "webauthn-registration"`.
 */
export const consumeWebAuthnRegistrationChallenge = async (token: string): Promise<{ userId: string; challenge: string } | null> => {
  if (_store === "memory") {
    const entry = _memoryChallenges.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      _memoryChallenges.delete(token);
      return null;
    }
    _memoryChallenges.delete(token);
    if (entry.purpose !== "webauthn-registration" || !entry.webauthnChallenge) return null;
    return { userId: entry.userId, challenge: entry.webauthnChallenge };
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    const row = _sqliteDb.query(
      "DELETE FROM mfa_challenges WHERE token = ? AND expiresAt > ? RETURNING userId, purpose, webauthnChallenge"
    ).get(token, Date.now()) as { userId: string; purpose: string; webauthnChallenge: string | null } | null;
    if (!row || row.purpose !== "webauthn-registration" || !row.webauthnChallenge) return null;
    return { userId: row.userId, challenge: row.webauthnChallenge };
  }

  if (_store === "mongo") {
    const doc = await getMfaChallengeModel().findOneAndDelete({ token, expiresAt: { $gt: new Date() } });
    if (!doc || doc.purpose !== "webauthn-registration" || !doc.webauthnChallenge) return null;
    return { userId: doc.userId, challenge: doc.webauthnChallenge };
  }

  // redis
  const key = `mfachallenge:${getAppName()}:${token}`;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  await getRedis().del(key);
  const data = JSON.parse(raw) as MfaChallengeRecord;
  if (data.purpose !== "webauthn-registration" || !data.webauthnChallenge) return null;
  return { userId: data.userId, challenge: data.webauthnChallenge };
};
