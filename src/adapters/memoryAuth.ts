import { HttpError } from "@lib/HttpError";
import type { AuthAdapter, OAuthProfile, WebAuthnCredential } from "@lib/authAdapter";
import type { SessionMetadata, SessionInfo } from "@lib/session";
import { getPersistSessionMetadata, getIncludeInactiveSessions } from "@lib/appConfig";
import { clearMemoryRateLimitStore } from "@lib/authRateLimit";
import { clearMemoryMfaChallenges } from "@lib/mfaChallenge";

// ---------------------------------------------------------------------------
// In-memory stores — module-level Maps, always ready, lost on process restart
// ---------------------------------------------------------------------------

interface UserRecord {
  id: string;
  email: string | null;
  passwordHash: string | null;
  providerIds: string[];
  roles: string[];
  emailVerified: boolean;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  recoveryCodes: string[];
  mfaMethods: string[];
  webauthnCredentials: WebAuthnCredential[];
}

interface MemorySession {
  sessionId: string;
  userId: string;
  token: string | null;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
  refreshToken?: string | null;
  prevRefreshToken?: string | null;
  prevTokenExpiresAt?: number | null;
}

const _users              = new Map<string, UserRecord>();
const _byEmail            = new Map<string, string>();
const _sessions           = new Map<string, MemorySession>();        // sessionId → session
const _userSessionIds     = new Map<string, Set<string>>();          // userId → Set<sessionId>
const _refreshTokenIndex  = new Map<string, string>();                // refreshToken → sessionId
const _oauthStates        = new Map<string, { codeVerifier?: string; linkUserId?: string; expiresAt: number }>();
const _cache              = new Map<string, { value: string; expiresAt?: number }>();
const _verificationTokens = new Map<string, { userId: string; email: string; expiresAt: number }>();
const _resetTokens        = new Map<string, { userId: string; email: string; expiresAt: number }>();
const _oauthCodes         = new Map<string, { token: string; userId: string; email?: string; refreshToken?: string; expiresAt: number }>();
const _tenantRoles        = new Map<string, string[]>();              // "userId:tenantId" → roles

/** Reset all in-memory state. Useful for test isolation. */
export const clearMemoryStore = (): void => {
  _users.clear();
  _byEmail.clear();
  _sessions.clear();
  _userSessionIds.clear();
  _refreshTokenIndex.clear();
  _tenantRoles.clear();
  _oauthStates.clear();
  _oauthCodes.clear();
  _cache.clear();
  _verificationTokens.clear();
  _resetTokens.clear();
  clearMemoryRateLimitStore();
  clearMemoryMfaChallenges();
};

// ---------------------------------------------------------------------------
// Auth adapter
// ---------------------------------------------------------------------------

export const memoryAuthAdapter: AuthAdapter = {
  async findByEmail(email) {
    const id = _byEmail.get(email.toLowerCase());
    if (!id) return null;
    const user = _users.get(id);
    if (!user || !user.passwordHash) return null;
    return { id: user.id, passwordHash: user.passwordHash };
  },

  async create(email, passwordHash) {
    const normalised = email.toLowerCase();
    if (_byEmail.has(normalised)) throw new HttpError(409, "Email already registered");
    const id = crypto.randomUUID();
    const user: UserRecord = { id, email: normalised, passwordHash, providerIds: [], roles: [], emailVerified: false, mfaSecret: null, mfaEnabled: false, recoveryCodes: [], mfaMethods: [], webauthnCredentials: [] };
    _users.set(id, user);
    _byEmail.set(normalised, id);
    return { id };
  },

  async setPassword(userId, passwordHash) {
    const user = _users.get(userId);
    if (!user) return;
    user.passwordHash = passwordHash;
  },

  async findOrCreateByProvider(provider: string, providerId: string, profile: OAuthProfile) {
    const key = `${provider}:${providerId}`;

    // Find by provider key
    for (const user of _users.values()) {
      if (user.providerIds.includes(key)) return { id: user.id, created: false };
    }

    // Reject if email belongs to a credential account
    if (profile.email) {
      const existingId = _byEmail.get(profile.email.toLowerCase());
      if (existingId) throw new HttpError(409, "An account with this email already exists. Sign in with your credentials, then link Google from your account settings.");
    }

    const id = crypto.randomUUID();
    const email = profile.email ? profile.email.toLowerCase() : null;
    const user: UserRecord = { id, email, passwordHash: null, providerIds: [key], roles: [], emailVerified: false, mfaSecret: null, mfaEnabled: false, recoveryCodes: [], mfaMethods: [], webauthnCredentials: [] };
    _users.set(id, user);
    if (email) _byEmail.set(email, id);
    return { id, created: true };
  },

  async linkProvider(userId, provider, providerId) {
    const user = _users.get(userId);
    if (!user) throw new HttpError(404, "User not found");
    const key = `${provider}:${providerId}`;
    if (!user.providerIds.includes(key)) user.providerIds.push(key);
  },

  async getRoles(userId) {
    return _users.get(userId)?.roles ?? [];
  },

  async setRoles(userId, roles) {
    const user = _users.get(userId);
    if (!user) return;
    user.roles = [...roles];
  },

  async addRole(userId, role) {
    const user = _users.get(userId);
    if (!user) return;
    if (!user.roles.includes(role)) user.roles.push(role);
  },

  async removeRole(userId, role) {
    const user = _users.get(userId);
    if (!user) return;
    user.roles = user.roles.filter((r) => r !== role);
  },

  async getUser(userId) {
    const user = _users.get(userId);
    if (!user) return null;
    return {
      email: user.email ?? undefined,
      providerIds: [...user.providerIds],
      emailVerified: user.emailVerified,
    };
  },

  async unlinkProvider(userId, provider) {
    const user = _users.get(userId);
    if (!user) throw new HttpError(404, "User not found");
    user.providerIds = user.providerIds.filter((id) => !id.startsWith(`${provider}:`));
  },

  async findByIdentifier(value) {
    const id = _byEmail.get(value.toLowerCase());
    if (!id) return null;
    const user = _users.get(id);
    if (!user || !user.passwordHash) return null;
    return { id: user.id, passwordHash: user.passwordHash };
  },

  async setEmailVerified(userId, verified) {
    const user = _users.get(userId);
    if (user) user.emailVerified = verified;
  },

  async getEmailVerified(userId) {
    return _users.get(userId)?.emailVerified ?? false;
  },
  async deleteUser(userId) {
    const user = _users.get(userId);
    if (user?.email) _byEmail.delete(user.email);
    _users.delete(userId);
  },
  async hasPassword(userId) {
    return !!_users.get(userId)?.passwordHash;
  },
  async setMfaSecret(userId, secret) {
    const user = _users.get(userId);
    if (user) user.mfaSecret = secret;
  },
  async getMfaSecret(userId) {
    return _users.get(userId)?.mfaSecret ?? null;
  },
  async isMfaEnabled(userId) {
    return _users.get(userId)?.mfaEnabled ?? false;
  },
  async setMfaEnabled(userId, enabled) {
    const user = _users.get(userId);
    if (user) user.mfaEnabled = enabled;
  },
  async setRecoveryCodes(userId, codes) {
    const user = _users.get(userId);
    if (user) user.recoveryCodes = [...codes];
  },
  async getRecoveryCodes(userId) {
    return _users.get(userId)?.recoveryCodes ?? [];
  },
  async removeRecoveryCode(userId, code) {
    const user = _users.get(userId);
    if (user) user.recoveryCodes = user.recoveryCodes.filter((c) => c !== code);
  },
  async getMfaMethods(userId) {
    const user = _users.get(userId);
    if (!user) return [];
    // Backward compat: if mfaEnabled but no methods recorded, assume TOTP
    if (user.mfaMethods.length === 0 && user.mfaEnabled) return ["totp"];
    return [...user.mfaMethods];
  },
  async setMfaMethods(userId, methods) {
    const user = _users.get(userId);
    if (user) user.mfaMethods = [...methods];
  },
  async getWebAuthnCredentials(userId) {
    return [...(_users.get(userId)?.webauthnCredentials ?? [])];
  },
  async addWebAuthnCredential(userId, credential) {
    const user = _users.get(userId);
    if (user) user.webauthnCredentials.push({ ...credential });
  },
  async removeWebAuthnCredential(userId, credentialId) {
    const user = _users.get(userId);
    if (user) user.webauthnCredentials = user.webauthnCredentials.filter((c) => c.credentialId !== credentialId);
  },
  async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
    const user = _users.get(userId);
    if (!user) return;
    const cred = user.webauthnCredentials.find((c) => c.credentialId === credentialId);
    if (cred) cred.signCount = signCount;
  },
  async findUserByWebAuthnCredentialId(credentialId) {
    for (const user of _users.values()) {
      if (user.webauthnCredentials.some((c) => c.credentialId === credentialId)) return user.id;
    }
    return null;
  },
  async getTenantRoles(userId, tenantId) {
    return _tenantRoles.get(`${userId}:${tenantId}`) ?? [];
  },
  async setTenantRoles(userId, tenantId, roles) {
    _tenantRoles.set(`${userId}:${tenantId}`, [...roles]);
  },
  async addTenantRole(userId, tenantId, role) {
    const key = `${userId}:${tenantId}`;
    const current = _tenantRoles.get(key) ?? [];
    if (!current.includes(role)) {
      _tenantRoles.set(key, [...current, role]);
    }
  },
  async removeTenantRole(userId, tenantId, role) {
    const key = `${userId}:${tenantId}`;
    const current = _tenantRoles.get(key);
    if (current) {
      _tenantRoles.set(key, current.filter((r) => r !== role));
    }
  },
};

// ---------------------------------------------------------------------------
// Session helpers (used by src/lib/session.ts)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000; // 7 days

export const memoryCreateSession = (userId: string, token: string, sessionId: string, metadata?: SessionMetadata): void => {
  const now = Date.now();
  const session: MemorySession = {
    sessionId, userId, token,
    createdAt: now, lastActiveAt: now, expiresAt: now + SESSION_TTL_MS,
    ipAddress: metadata?.ipAddress,
    userAgent: metadata?.userAgent,
  };
  _sessions.set(sessionId, session);
  if (!_userSessionIds.has(userId)) _userSessionIds.set(userId, new Set());
  _userSessionIds.get(userId)!.add(sessionId);
};

export const memoryGetSession = (sessionId: string): string | null => {
  const entry = _sessions.get(sessionId);
  if (!entry || !entry.token || entry.expiresAt <= Date.now()) return null;
  return entry.token;
};

export const memoryDeleteSession = (sessionId: string): void => {
  const entry = _sessions.get(sessionId);
  if (!entry) return;
  // Clean up refresh token reverse-lookup keys
  if (entry.refreshToken) _refreshTokenIndex.delete(entry.refreshToken);
  if (entry.prevRefreshToken) _refreshTokenIndex.delete(entry.prevRefreshToken);
  if (getPersistSessionMetadata()) {
    entry.token = null;
    entry.refreshToken = null;
    entry.prevRefreshToken = null;
    entry.prevTokenExpiresAt = null;
  } else {
    _sessions.delete(sessionId);
    _userSessionIds.get(entry.userId)?.delete(sessionId);
  }
};

export const memoryGetUserSessions = (userId: string): SessionInfo[] => {
  const ids = _userSessionIds.get(userId);
  if (!ids) return [];
  const now = Date.now();
  const includeInactive = getIncludeInactiveSessions();
  const persist = getPersistSessionMetadata();
  const results: SessionInfo[] = [];
  for (const sessionId of ids) {
    const s = _sessions.get(sessionId);
    if (!s) continue;
    const isActive = !!s.token && s.expiresAt > now;
    if (!isActive && !persist) continue;
    if (!isActive && !includeInactive) continue;
    results.push({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isActive,
    });
  }
  return results;
};

export const memoryGetActiveSessionCount = (userId: string): number => {
  const ids = _userSessionIds.get(userId);
  if (!ids) return 0;
  const now = Date.now();
  let count = 0;
  for (const sessionId of ids) {
    const s = _sessions.get(sessionId);
    if (s && s.token && s.expiresAt > now) count++;
  }
  return count;
};

export const memoryEvictOldestSession = (userId: string): void => {
  const ids = _userSessionIds.get(userId);
  if (!ids) return;
  const now = Date.now();
  let oldest: MemorySession | null = null;
  for (const sessionId of ids) {
    const s = _sessions.get(sessionId);
    if (!s || !s.token || s.expiresAt <= now) continue;
    if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
  }
  if (oldest) memoryDeleteSession(oldest.sessionId);
};

export const memoryUpdateSessionLastActive = (sessionId: string): void => {
  const entry = _sessions.get(sessionId);
  if (entry) entry.lastActiveAt = Date.now();
};

export const memorySetRefreshToken = (sessionId: string, refreshToken: string): void => {
  const entry = _sessions.get(sessionId);
  if (!entry) return;
  entry.refreshToken = refreshToken;
  _refreshTokenIndex.set(refreshToken, sessionId);
};

import type { RefreshResult } from "@lib/session";
import { getRotationGraceSeconds } from "@lib/appConfig";

export const memoryGetSessionByRefreshToken = (refreshToken: string): RefreshResult | null => {
  const sessionId = _refreshTokenIndex.get(refreshToken);
  if (!sessionId) return null;
  const entry = _sessions.get(sessionId);
  if (!entry) return null;

  // Current refresh token matches
  if (entry.refreshToken === refreshToken) {
    return { sessionId: entry.sessionId, userId: entry.userId, newRefreshToken: refreshToken };
  }

  // Check grace window
  if (entry.prevRefreshToken === refreshToken && entry.prevTokenExpiresAt && entry.prevTokenExpiresAt > Date.now()) {
    return { sessionId: entry.sessionId, userId: entry.userId, newRefreshToken: entry.refreshToken! };
  }

  // Grace window expired — theft detected, invalidate session
  if (entry.prevRefreshToken === refreshToken) {
    memoryDeleteSession(sessionId);
    return null;
  }

  return null;
};

export const memoryRotateRefreshToken = (sessionId: string, newRefreshToken: string, newAccessToken: string): void => {
  const entry = _sessions.get(sessionId);
  if (!entry) return;
  const graceSeconds = getRotationGraceSeconds();

  // Move current to prev
  const oldRefreshToken = entry.refreshToken;
  entry.prevRefreshToken = oldRefreshToken;
  entry.prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
  entry.refreshToken = newRefreshToken;
  entry.token = newAccessToken;

  // Update reverse-lookup index
  _refreshTokenIndex.set(newRefreshToken, sessionId);
  // Old token stays in index during grace window — cleaned up on next lookup or session delete
};

// ---------------------------------------------------------------------------
// OAuth state helpers (used by src/lib/oauth.ts)
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const memoryStoreOAuthState = (state: string, codeVerifier?: string, linkUserId?: string): void => {
  _oauthStates.set(state, { codeVerifier, linkUserId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
};

export const memoryConsumeOAuthState = (state: string): { codeVerifier?: string; linkUserId?: string } | null => {
  const entry = _oauthStates.get(state);
  if (!entry || entry.expiresAt <= Date.now()) {
    _oauthStates.delete(state);
    return null;
  }
  _oauthStates.delete(state);
  return { codeVerifier: entry.codeVerifier, linkUserId: entry.linkUserId };
};

// ---------------------------------------------------------------------------
// Cache helpers (used by src/middleware/cacheResponse.ts)
// ---------------------------------------------------------------------------

export const memoryGetCache = (key: string): string | null => {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
};

export const memorySetCache = (key: string, value: string, ttlSeconds?: number): void => {
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
  _cache.set(key, { value, expiresAt });
};

export const memoryDelCache = (key: string): void => {
  _cache.delete(key);
};

export const memoryDelCachePattern = (pattern: string): void => {
  // Convert glob * to a regex
  const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  for (const key of _cache.keys()) {
    if (regex.test(key)) _cache.delete(key);
  }
};

// ---------------------------------------------------------------------------
// Email verification token helpers (used by src/lib/emailVerification.ts)
// ---------------------------------------------------------------------------

export const memoryCreateVerificationToken = (token: string, userId: string, email: string, ttlSeconds: number): void => {
  _verificationTokens.set(token, { userId, email, expiresAt: Date.now() + ttlSeconds * 1000 });
};

export const memoryGetVerificationToken = (token: string): { userId: string; email: string } | null => {
  const entry = _verificationTokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    _verificationTokens.delete(token);
    return null;
  }
  return { userId: entry.userId, email: entry.email };
};

export const memoryDeleteVerificationToken = (token: string): void => {
  _verificationTokens.delete(token);
};

// ---------------------------------------------------------------------------
// Password reset token helpers (used by src/lib/resetPassword.ts)
// ---------------------------------------------------------------------------

export const memoryCreateResetToken = (token: string, userId: string, email: string, ttlSeconds: number): void => {
  const now = Date.now();
  // Opportunistically purge expired entries to prevent unbounded memory growth
  for (const [k, v] of _resetTokens) {
    if (v.expiresAt <= now) _resetTokens.delete(k);
  }
  _resetTokens.set(token, { userId, email, expiresAt: now + ttlSeconds * 1000 });
};

export const memoryConsumeResetToken = (hash: string): { userId: string; email: string } | null => {
  const entry = _resetTokens.get(hash);
  if (!entry || entry.expiresAt <= Date.now()) {
    _resetTokens.delete(hash);
    return null;
  }
  _resetTokens.delete(hash);
  return { userId: entry.userId, email: entry.email };
};

// ---------------------------------------------------------------------------
// OAuth code helpers (used by src/lib/oauthCode.ts)
// ---------------------------------------------------------------------------

import type { OAuthCodePayload } from "@lib/oauthCode";

export const memoryStoreOAuthCode = (hash: string, payload: OAuthCodePayload, ttlSeconds: number): void => {
  _oauthCodes.set(hash, { ...payload, expiresAt: Date.now() + ttlSeconds * 1000 });
};

export const memoryConsumeOAuthCode = (hash: string): OAuthCodePayload | null => {
  const entry = _oauthCodes.get(hash);
  if (!entry || entry.expiresAt <= Date.now()) {
    _oauthCodes.delete(hash);
    return null;
  }
  _oauthCodes.delete(hash);
  return { token: entry.token, userId: entry.userId, email: entry.email, refreshToken: entry.refreshToken };
};
