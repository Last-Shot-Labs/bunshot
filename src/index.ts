// App factory
export { createApp } from "./app";
export { createServer } from "./server";
export type { CreateAppConfig, DbConfig, AppMeta, AuthConfig, AuthRateLimitConfig, OAuthConfig, SecurityConfig, BotProtectionConfig, PrimaryField, EmailVerificationConfig } from "./app";
export type { CreateServerConfig, WsConfig } from "./server";

// Lib utilities
export { getAppRoles } from "@lib/appConfig";
export { HttpError } from "@lib/HttpError";
export { COOKIE_TOKEN, HEADER_USER_TOKEN } from "@lib/constants";
export { createRouter } from "@lib/context";
export type { AppEnv, AppVariables } from "@lib/context";
export { signToken, verifyToken } from "@lib/jwt";
export { log } from "@lib/logger";
export { connectMongo, connectAuthMongo, connectAppMongo, authConnection, appConnection, mongoose } from "@lib/mongo";
export { connectRedis, getRedis } from "@lib/redis";
export { createQueue, createWorker } from "@lib/queue";
export type { Job } from "@lib/queue";
export { createSession, getSession, deleteSession, setSessionStore } from "@lib/session";
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
export { AuthUser } from "@models/AuthUser";
export { mongoAuthAdapter } from "./adapters/mongoAuth";
export { sqliteAuthAdapter, setSqliteDb, startSqliteCleanup } from "./adapters/sqliteAuth";
export { memoryAuthAdapter, clearMemoryStore } from "./adapters/memoryAuth";
export { setUserRoles, addUserRole, removeUserRole } from "@lib/roles";
export type { AuthAdapter, OAuthProfile } from "@lib/authAdapter";
export type { OAuthProviderConfig } from "@lib/oauth";

// WebSocket
export { websocket, createWsUpgradeHandler } from "@ws/index";
export type { SocketData } from "@ws/index";
export { publish, subscribe, unsubscribe, getSubscriptions, handleRoomActions, getRooms, getRoomSubscribers } from "@lib/ws";
