import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName, getMfaChallengeTtl } from "./appConfig";

// ---------------------------------------------------------------------------
// Mongo model
// ---------------------------------------------------------------------------

interface MfaChallengeDoc {
  token: string;
  userId: string;
  expiresAt: Date;
}

function getMfaChallengeModel() {
  if (appConnection.models["MfaChallenge"]) return appConnection.models["MfaChallenge"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const schema = new Schema<MfaChallengeDoc>(
    {
      token:     { type: String, required: true, unique: true },
      userId:    { type: String, required: true },
      expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } },
    },
    { collection: "mfa_challenges" }
  );
  return appConnection.model<MfaChallengeDoc>("MfaChallenge", schema);
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _memoryChallenges = new Map<string, { userId: string; expiresAt: number }>();

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
    token     TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);
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

export const createMfaChallenge = async (userId: string): Promise<string> => {
  const token = crypto.randomUUID();
  const ttl = getMfaChallengeTtl();

  if (_store === "memory") {
    _memoryChallenges.set(token, { userId, expiresAt: Date.now() + ttl * 1000 });
    return token;
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    _sqliteDb.run(
      "INSERT INTO mfa_challenges (token, userId, expiresAt) VALUES (?, ?, ?)",
      [token, userId, Date.now() + ttl * 1000]
    );
    return token;
  }

  if (_store === "mongo") {
    await getMfaChallengeModel().create({
      token,
      userId,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return token;
  }

  // redis
  await getRedis().set(
    `mfachallenge:${getAppName()}:${token}`,
    JSON.stringify({ userId }),
    "EX",
    ttl
  );
  return token;
};

export const consumeMfaChallenge = async (token: string): Promise<{ userId: string } | null> => {
  if (_store === "memory") {
    const entry = _memoryChallenges.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      _memoryChallenges.delete(token);
      return null;
    }
    _memoryChallenges.delete(token);
    return { userId: entry.userId };
  }

  if (_store === "sqlite") {
    ensureSqliteMfaTable();
    const row = _sqliteDb.query(
      "DELETE FROM mfa_challenges WHERE token = ? AND expiresAt > ? RETURNING userId"
    ).get(token, Date.now()) as { userId: string } | null;
    return row ? { userId: row.userId } : null;
  }

  if (_store === "mongo") {
    const doc = await getMfaChallengeModel().findOneAndDelete({ token, expiresAt: { $gt: new Date() } });
    return doc ? { userId: doc.userId } : null;
  }

  // redis
  const key = `mfachallenge:${getAppName()}:${token}`;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  await getRedis().del(key);
  return JSON.parse(raw) as { userId: string };
};
