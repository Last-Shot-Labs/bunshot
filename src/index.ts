// App factory
export { createApp } from "./app";
export { createServer } from "./server";
export type { CreateAppConfig, ModelSchemasConfig, DbConfig, AppMeta, AuthConfig, AuthRateLimitConfig, AccountDeletionConfig, OAuthConfig, SecurityConfig, CsrfConfig, BotProtectionConfig, PrimaryField, EmailVerificationConfig, PasswordResetConfig, RefreshTokenConfig, MfaConfig, MfaEmailOtpConfig, MfaWebAuthnConfig, JobsConfig, TenancyConfig, TenantConfig } from "./app";
export type { PasswordPolicyConfig } from "@lib/appConfig";
export type { CreateServerConfig, WsConfig } from "./server";

// Database
export { appConnection, authConnection, mongoose, connectMongo, connectAuthMongo, connectAppMongo, disconnectMongo } from "@lib/mongo";
export { connectRedis, disconnectRedis, getRedis } from "@lib/redis";

// Lib utilities
export { getAppRoles } from "@lib/appConfig";
export { HttpError } from "@lib/HttpError";
export { COOKIE_TOKEN, HEADER_USER_TOKEN, COOKIE_REFRESH_TOKEN, HEADER_REFRESH_TOKEN, COOKIE_CSRF_TOKEN, HEADER_CSRF_TOKEN } from "@lib/constants";
export { createRouter } from "@lib/context";
export { createRoute, withSecurity, registerSchema, registerSchemas } from "@lib/createRoute";
export { zodToMongoose } from "@lib/zodToMongoose";
export type { ZodToMongooseConfig, ZodToMongooseRefConfig } from "@lib/zodToMongoose";
export { createDtoMapper } from "@lib/createDtoMapper";
export type { DtoMapperConfig } from "@lib/createDtoMapper";
export type { AppEnv, AppVariables } from "@lib/context";
export { signToken, verifyToken } from "@lib/jwt";
export { log } from "@lib/logger";
export { createResetToken, consumeResetToken, setPasswordResetStore } from "@lib/resetPassword";
export { timingSafeEqual, sha256 } from "@lib/crypto";
export { getClientIp, setTrustProxy } from "@lib/clientIp";
export { storeOAuthCode, consumeOAuthCode, setOAuthCodeStore } from "@lib/oauthCode";
export type { OAuthCodePayload } from "@lib/oauthCode";
export { createSession, getSession, deleteSession, getUserSessions, getActiveSessionCount, evictOldestSession, updateSessionLastActive, setSessionStore, deleteUserSessions, setRefreshToken, getSessionByRefreshToken, rotateRefreshToken } from "@lib/session";
export type { SessionMetadata, SessionInfo, RefreshResult } from "@lib/session";
export { createVerificationToken, getVerificationToken, deleteVerificationToken } from "@lib/emailVerification";
export { createMfaChallenge, consumeMfaChallenge, replaceMfaChallengeOtp, setMfaChallengeStore, createWebAuthnRegistrationChallenge, consumeWebAuthnRegistrationChallenge, clearMemoryMfaChallenges } from "@lib/mfaChallenge";
export type { MfaChallengeData, MfaChallengeOptions, MfaChallengePurpose } from "@lib/mfaChallenge";
export { bustAuthLimit, trackAttempt, isLimited, clearMemoryRateLimitStore } from "@lib/authRateLimit";
export type { LimitOpts } from "@lib/authRateLimit";
export { validate } from "@lib/validate";

// Middleware
export { bearerAuth } from "@middleware/bearerAuth";
export { botProtection } from "@middleware/botProtection";
export type { BotProtectionOptions } from "@middleware/botProtection";
export { identify } from "@middleware/identify";
export { rateLimit } from "@middleware/rateLimit";
export type { RateLimitOptions } from "@middleware/rateLimit";
export { userAuth } from "@middleware/userAuth";
export { requireRole } from "@middleware/requireRole";
export { requireVerifiedEmail } from "@middleware/requireVerifiedEmail";
export { requireMfaSetup } from "@middleware/requireMfaSetup";
export { csrfProtection, refreshCsrfToken, clearCsrfToken } from "@middleware/csrf";
export type { CsrfMiddlewareOptions } from "@middleware/csrf";
export { cacheResponse, bustCache, bustCachePattern, setCacheStore, getCacheModel } from "@middleware/cacheResponse";

// Lib utilities (bot protection)
export { buildFingerprint } from "@lib/fingerprint";

// Models
export { sqliteAuthAdapter, setSqliteDb, startSqliteCleanup } from "./adapters/sqliteAuth";
export { memoryAuthAdapter, clearMemoryStore } from "./adapters/memoryAuth";
export { setUserRoles, addUserRole, removeUserRole, getTenantRoles, setTenantRoles, addTenantRole, removeTenantRole } from "@lib/roles";
export type { AuthAdapter, OAuthProfile, WebAuthnCredential } from "@lib/authAdapter";
export type { OAuthProviderConfig } from "@lib/oauth";

// WebSocket
export { websocket, createWsUpgradeHandler } from "@ws/index";
export type { SocketData } from "@ws/index";
export { publish, subscribe, unsubscribe, getSubscriptions, handleRoomActions, getRooms, getRoomSubscribers } from "@lib/ws";

// Tenancy
export { createTenant, deleteTenant, getTenant, listTenants } from "@lib/tenant";
export type { TenantInfo, CreateTenantOptions } from "@lib/tenant";
export { invalidateTenantCache } from "@middleware/tenant";
