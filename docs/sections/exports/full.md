## Exports

```ts
import {
  // Server factory
  createServer, createApp,

  // DB
  connectMongo, connectAuthMongo, connectAppMongo, disconnectMongo,
  authConnection, appConnection, mongoose,
  connectRedis, disconnectRedis, getRedis,

  // Jobs
  createQueue, createWorker,
  type Job,

  // WebSocket
  websocket, createWsUpgradeHandler, publish,
  subscribe, unsubscribe, getSubscriptions, handleRoomActions,
  getRooms, getRoomSubscribers,

  // Auth utilities
  signToken, verifyToken,
  createSession, getSession, deleteSession, getUserSessions, getActiveSessionCount,
  evictOldestSession, updateSessionLastActive, setSessionStore, deleteUserSessions,
  setRefreshToken, getSessionByRefreshToken, rotateRefreshToken,  // refresh token management
  createVerificationToken, getVerificationToken, deleteVerificationToken,  // email verification tokens
  createResetToken, consumeResetToken, setPasswordResetStore,              // password reset tokens
  createMfaChallenge, consumeMfaChallenge, replaceMfaChallengeOtp, setMfaChallengeStore, // MFA challenge tokens
  storeOAuthCode, consumeOAuthCode, setOAuthCodeStore,               // OAuth one-time authorization codes
  bustAuthLimit, trackAttempt, isLimited, clearMemoryRateLimitStore, // auth rate limiting — use in custom routes or admin unlocks
  buildFingerprint,                                // HTTP fingerprint hash (IP-independent) — use in custom bot detection logic
  sqliteAuthAdapter, setSqliteDb, startSqliteCleanup,  // SQLite backend (persisted)
  memoryAuthAdapter, clearMemoryStore,                 // in-memory backend (ephemeral)
  setUserRoles, addUserRole, removeUserRole,       // app-wide role management
  getTenantRoles, setTenantRoles, addTenantRole, removeTenantRole, // tenant-scoped role management
  type AuthAdapter, type OAuthProfile, type OAuthProviderConfig, type MfaChallengeData,
  type AuthRateLimitConfig, type BotProtectionConfig, type BotProtectionOptions,
  type LimitOpts, type RateLimitOptions,
  type SessionMetadata, type SessionInfo, type RefreshResult,

  // Tenancy
  createTenant, deleteTenant, getTenant, listTenants,  // tenant provisioning (MongoDB)
  invalidateTenantCache,                               // invalidate LRU cache entry
  type TenantInfo, type CreateTenantOptions,
  type TenancyConfig, type TenantConfig,

  // Middleware
  bearerAuth, identify, userAuth, rateLimit,
  botProtection,                                  // CIDR blocklist + per-route bot protection
  requireRole,                                    // role-based access control (tenant-aware)
  requireVerifiedEmail,                           // blocks unverified email addresses
  cacheResponse, bustCache, bustCachePattern, setCacheStore,  // response caching (tenant-namespaced)

  // Crypto utilities
  timingSafeEqual,                                  // constant-time string comparison for secrets/hashes
  sha256,                                           // SHA-256 hash helper

  // IP / proxy utilities
  getClientIp,                                      // centralized IP extraction — respects security.trustProxy setting
  setTrustProxy,                                    // configure trust level (called automatically by createApp)

  // Utilities
  HttpError, log, validate, createRouter, createRoute,
  registerSchema, registerSchemas,                // named OpenAPI schema registration
  zodToMongoose,                                  // Zod → Mongoose schema conversion
  createDtoMapper,                                // DB document → API DTO mapper factory
  type ZodToMongooseConfig, type ZodToMongooseRefConfig, type DtoMapperConfig,
  getAppRoles,                                    // returns the valid roles list configured at startup

  // Constants
  COOKIE_TOKEN, HEADER_USER_TOKEN,
  COOKIE_REFRESH_TOKEN, HEADER_REFRESH_TOKEN,     // refresh token cookie/header names

  // Types
  type AppEnv, type AppVariables,
  type CreateServerConfig, type CreateAppConfig, type ModelSchemasConfig,
  type DbConfig, type AppMeta, type AuthConfig, type OAuthConfig, type SecurityConfig,
  type PrimaryField, type EmailVerificationConfig, type PasswordResetConfig,
  type RefreshTokenConfig, type MfaConfig, type MfaEmailOtpConfig, type JobsConfig,
  type AccountDeletionConfig, type PasswordPolicyConfig, type OAuthCodePayload,
  type SocketData, type WsConfig,
} from "@lastshotlabs/bunshot";

// Jobs (separate entrypoint)
import {
  createQueue, createWorker,
  createCronWorker, cleanupStaleSchedulers, getRegisteredCronNames,
  createDLQHandler,
  type Job,
} from "@lastshotlabs/bunshot/queue";
```
