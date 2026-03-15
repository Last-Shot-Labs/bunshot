// App factory
export { createApp } from "./app";
export { createServer } from "./server";
export type { CreateAppConfig, ModelSchemasConfig, DbConfig, AppMeta, AuthConfig, AuthRateLimitConfig, AccountDeletionConfig, OAuthConfig, SecurityConfig, BotProtectionConfig, PrimaryField, EmailVerificationConfig, PasswordResetConfig } from "./app";
export type { CreateServerConfig, WsConfig } from "./server";

// Database
export { appConnection, authConnection, mongoose, connectMongo, connectAuthMongo, connectAppMongo, disconnectMongo } from "@lib/mongo";
export { connectRedis, disconnectRedis, getRedis } from "@lib/redis";

// Lib utilities
export { getAppRoles } from "@lib/appConfig";
export { HttpError } from "@lib/HttpError";
export { COOKIE_TOKEN, HEADER_USER_TOKEN } from "@lib/constants";
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
export { createSession, getSession, deleteSession, getUserSessions, getActiveSessionCount, evictOldestSession, updateSessionLastActive, setSessionStore, deleteUserSessions } from "@lib/session";
export type { SessionMetadata, SessionInfo } from "@lib/session";
export { createVerificationToken, getVerificationToken, deleteVerificationToken } from "@lib/emailVerification";
export { bustAuthLimit, trackAttempt, isLimited } from "@lib/authRateLimit";
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
export { cacheResponse, bustCache, bustCachePattern, setCacheStore } from "@middleware/cacheResponse";

// Lib utilities (bot protection)
export { buildFingerprint } from "@lib/fingerprint";

// Models
export { sqliteAuthAdapter, setSqliteDb, startSqliteCleanup } from "./adapters/sqliteAuth";
export { memoryAuthAdapter, clearMemoryStore } from "./adapters/memoryAuth";
export { setUserRoles, addUserRole, removeUserRole } from "@lib/roles";
export type { AuthAdapter, OAuthProfile } from "@lib/authAdapter";
export type { OAuthProviderConfig } from "@lib/oauth";

// WebSocket
export { websocket, createWsUpgradeHandler } from "@ws/index";
export type { SocketData } from "@ws/index";
export { publish, subscribe, unsubscribe, getSubscriptions, handleRoomActions, getRooms, getRoomSubscribers } from "@lib/ws";
