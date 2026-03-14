import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { Scalar } from "@scalar/hono-api-reference";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "@lib/HttpError";
import { rateLimit } from "@middleware/rateLimit";
import { bearerAuth } from "@middleware/bearerAuth";
import { identify } from "@middleware/identify";
import type { AppEnv } from "@lib/context";
import { HEADER_USER_TOKEN } from "@lib/constants";
import { setAppName, setAppRoles, setDefaultRole, setPrimaryField, setEmailVerificationConfig, setPasswordResetConfig, setMaxSessions, setPersistSessionMetadata, setIncludeInactiveSessions, setTrackLastActive } from "@lib/appConfig";
import type { PrimaryField, EmailVerificationConfig, PasswordResetConfig } from "@lib/appConfig";
import { setEmailVerificationStore } from "@lib/emailVerification";
import { setPasswordResetStore } from "@lib/resetPassword";
import { setAuthRateLimitStore } from "@lib/authRateLimit";
import { setAuthAdapter } from "@lib/authAdapter";
import { mongoAuthAdapter } from "./adapters/mongoAuth";
import type { AuthAdapter } from "@lib/authAdapter";
import { memoryAuthAdapter } from "./adapters/memoryAuth";
import { initOAuthProviders, getConfiguredOAuthProviders, setOAuthStateStore } from "@lib/oauth";
import type { OAuthProviderConfig } from "@lib/oauth";
import { createOAuthRouter } from "@routes/oauth";
import { connectMongo, connectAuthMongo, connectAppMongo } from "@lib/mongo";
import { connectRedis } from "@lib/redis";
import { setSessionStore } from "@lib/session";
import { setCacheStore } from "@middleware/cacheResponse";

type StoreType = "redis" | "mongo" | "sqlite" | "memory";

export interface DbConfig {
  /**
   * Absolute path to the SQLite database file.
   * Required when any store is "sqlite".
   * Example: import.meta.dir + "/../data.db"
   */
  sqlite?: string;
  /**
   * MongoDB auto-connect mode.
   * - "single" (default): calls connectMongo() — auth and app share one server (MONGO_* env vars)
   * - "separate": calls connectAuthMongo() + connectAppMongo() — auth on MONGO_AUTH_* server, app on MONGO_* server
   * - false: skip auto-connect (call connectMongo / connectAuthMongo / connectAppMongo yourself)
   */
  mongo?: "single" | "separate" | false;
  /**
   * Auto-connect Redis before starting. Defaults to true.
   * Set false to skip (e.g. when using sqlite or memory stores only).
   */
  redis?: boolean;
  /**
   * Where to store JWT sessions. Default: "redis".
   * Sessions are stored on appConnection (not authConnection) so they are isolated per-app
   * in "separate" mongo mode.
   */
  sessions?: StoreType;
  /**
   * Where to store OAuth state (PKCE code verifier, link user ID). Default: follows `sessions`.
   */
  oauthState?: StoreType;
  /**
   * Global default store for cacheResponse middleware. Default: "redis".
   * Can be overridden per-route via cacheResponse({ store: "..." }).
   */
  cache?: StoreType;
  /**
   * Which built-in auth adapter to use for /auth/* routes.
   * - "mongo" (default when mongo is enabled): Mongoose adapter (requires connectMongo)
   * - "sqlite": bun:sqlite adapter (requires sqlite path)
   * - "memory": in-memory Maps (ephemeral, great for tests)
   * When `mongo: false`, defaults to the same store as `sessions`.
   * Ignored when `auth.adapter` is explicitly passed in CreateAppConfig.
   */
  auth?: "mongo" | "sqlite" | "memory";
}

export interface AppMeta {
  /** App name shown in the root endpoint and OpenAPI docs title. Defaults to "Bun Core API" */
  name?: string;
  /** Version shown in OpenAPI docs. Defaults to "1.0.0" */
  version?: string;
}

export interface OAuthConfig {
  /** OAuth provider credentials. Configured providers get automatic /auth/{provider} routes. */
  providers?: OAuthProviderConfig;
  /** Where to redirect after a successful OAuth login. Defaults to "/" */
  postRedirect?: string;
}

export interface AuthRateLimitConfig {
  /** Max login failures per window before the account is locked. Default: 10 per 15 min. */
  login?: { windowMs?: number; max?: number };
  /** Max registration attempts per IP per window. Default: 5 per hour. */
  register?: { windowMs?: number; max?: number };
  /** Max email verification attempts per IP per window. Default: 10 per 15 min. */
  verifyEmail?: { windowMs?: number; max?: number };
  /** Max resend-verification attempts per user per window. Default: 3 per hour. */
  resendVerification?: { windowMs?: number; max?: number };
  /** Max forgot-password requests per IP per window. Default: 5 per 15 min. */
  forgotPassword?: { windowMs?: number; max?: number };
  /** Max reset-password attempts per IP per window. Default: 10 per 15 min. */
  resetPassword?: { windowMs?: number; max?: number };
  /**
   * Store backend for auth rate limit counters.
   * Defaults to "redis" when Redis is enabled, otherwise "memory".
   * Use "redis" for multi-instance deployments so limits are shared across servers.
   */
  store?: "memory" | "redis";
}

export interface AuthConfig {
  /** Set false to skip mounting /auth/* routes. Defaults to true */
  enabled?: boolean;
  /**
   * Custom auth adapter for the built-in /auth/* routes.
   * Use this for fully custom backends (e.g. Postgres).
   * For built-in backends prefer `db.auth: "mongo" | "sqlite" | "memory"`.
   * When both are set, this takes precedence.
   */
  adapter?: AuthAdapter;
  /** Valid roles for this app (e.g. ["admin", "editor", "user"]). Used by requireRole middleware. */
  roles?: string[];
  /** Role automatically assigned to new users on registration. Must be one of roles. */
  defaultRole?: string;
  /** OAuth provider and redirect configuration */
  oauth?: OAuthConfig;
  /**
   * The primary identifier field used for registration and login.
   * Defaults to "email". Use "username" or "phone" for apps that identify users differently.
   * Email verification is only available when primaryField is "email".
   */
  primaryField?: PrimaryField;
  /**
   * Email verification configuration. Only active when primaryField is "email".
   * Provide an onSend callback to send the verification email via any provider (Resend, SendGrid, etc.).
   */
  emailVerification?: EmailVerificationConfig;
  /**
   * Password reset configuration. Only active when primaryField is "email".
   * Provide an onSend callback to send the reset email via any provider (Resend, SendGrid, etc.).
   * Mounts POST /auth/forgot-password and POST /auth/reset-password.
   */
  passwordReset?: PasswordResetConfig;
  /** Rate limit configuration for built-in auth endpoints. */
  rateLimit?: AuthRateLimitConfig;
  /** Session concurrency and metadata persistence policy. */
  sessionPolicy?: AuthSessionPolicyConfig;
}

export interface AuthSessionPolicyConfig {
  /** Max simultaneous active sessions per user. Oldest is evicted when exceeded. Default: 6. */
  maxSessions?: number;
  /**
   * Retain session metadata (IP, user-agent, timestamps) after a session expires or is deleted.
   * Enables future novel-device/location detection. Default: true.
   */
  persistSessionMetadata?: boolean;
  /**
   * Include inactive (expired/deleted) sessions in GET /auth/sessions.
   * Only meaningful when persistSessionMetadata is true. Default: false.
   */
  includeInactiveSessions?: boolean;
  /**
   * Update lastActiveAt on every authenticated request.
   * Adds one DB write per auth'd request. Default: false.
   */
  trackLastActive?: boolean;
}

export type { PrimaryField, EmailVerificationConfig, PasswordResetConfig };

export interface BotProtectionConfig {
  /**
   * List of IPv4 CIDRs (e.g. "198.51.100.0/24"), IPv4 addresses, or IPv6 addresses to block outright.
   * Matched requests receive a 403 before any other processing.
   * Example: ["198.51.100.0/24", "203.0.113.42"]
   */
  blockList?: string[];
  /**
   * Also rate-limit by HTTP fingerprint (User-Agent, Accept-*, Connection, browser header presence)
   * in addition to IP. Bots that rotate IPs but use the same HTTP client share a bucket.
   * Uses the same store as auth rate limiting (Redis or memory).
   * Default: false
   */
  fingerprintRateLimit?: boolean;
}

export interface SecurityConfig {
  /** CORS origins. Defaults to "*" */
  cors?: string | string[];
  /** Global rate limit. Defaults to 100 req / 60s */
  rateLimit?: { windowMs: number; max: number };
  /**
   * Bearer auth check. Set false to disable entirely.
   * Pass an object with bypass paths (merged with built-in defaults: /docs, /health, /openapi.json, etc.).
   * Defaults to enabled with no extra bypass paths.
   */
  bearerAuth?: boolean | { bypass?: string[] };
  /**
   * Bot protection: CIDR blocklist and fingerprint-based rate limiting.
   * Runs before IP rate limiting so blocked IPs are rejected immediately.
   */
  botProtection?: BotProtectionConfig;
}

export interface CreateAppConfig {
  /** Absolute path to the service's routes directory (use import.meta.dir + "/routes") */
  routesDir: string;
  /** App name and version for the root endpoint and OpenAPI docs */
  app?: AppMeta;
  /** Auth, roles, and OAuth configuration */
  auth?: AuthConfig;
  /** Security: CORS, rate limiting, bearer auth */
  security?: SecurityConfig;
  /** Extra middleware injected after identify, before route matching */
  middleware?: MiddlewareHandler<AppEnv>[];
  /** Database connection and store routing configuration */
  db?: DbConfig;
}

export const createApp = async (config: CreateAppConfig): Promise<OpenAPIHono<AppEnv>> => {
  const {
    routesDir,
    app: appConfig = {},
    auth: authConfig = {},
    security: securityConfig = {},
    middleware = [],
    db = {},
  } = config;

  const appName = appConfig.name ?? "Bun Core API";
  const openApiVersion = appConfig.version ?? "1.0.0";

  const corsOrigins = securityConfig.cors ?? "*";
  const rlConfig = securityConfig.rateLimit ?? { windowMs: 60_000, max: 100 };
  const botCfg = securityConfig.botProtection ?? {};
  const enableBearerAuth = securityConfig.bearerAuth !== false;
  const extraBypass =
    typeof securityConfig.bearerAuth === "object" && securityConfig.bearerAuth !== null
      ? (securityConfig.bearerAuth.bypass ?? [])
      : [];

  const enableAuthRoutes = authConfig.enabled !== false;
  const explicitAuthAdapter = authConfig.adapter;
  const oauthProviders = authConfig.oauth?.providers;
  const postOAuthRedirect = authConfig.oauth?.postRedirect ?? "/";
  const roles = authConfig.roles ?? [];
  const defaultRole = authConfig.defaultRole;
  const primaryField = authConfig.primaryField ?? "email";
  const emailVerification = authConfig.emailVerification;
  const passwordReset = authConfig.passwordReset;
  const authRateLimit = authConfig.rateLimit;
  const sessionPolicy = authConfig.sessionPolicy ?? {};

  const { sqlite, mongo = "single", redis: enableRedis = true } = db;

  // Smart fallback: pick the best available store rather than blindly defaulting to "redis"
  const defaultStore: StoreType = enableRedis
    ? "redis"
    : sqlite
    ? "sqlite"
    : mongo !== false
    ? "mongo"
    : "memory";

  const sessions   = db.sessions   ?? defaultStore;
  const oauthState = db.oauthState ?? sessions;
  const cache      = db.cache      ?? defaultStore;
  const authStore  = db.auth       ?? (mongo !== false ? "mongo" : sessions);

  if (sqlite || sessions === "sqlite" || oauthState === "sqlite" || authStore === "sqlite") {
    const { setSqliteDb } = await import("./adapters/sqliteAuth");
    setSqliteDb(sqlite ?? "./data.db");
  }

  setSessionStore(sessions);
  setOAuthStateStore(oauthState);
  setCacheStore(cache);

  if (mongo === "single") await connectMongo();
  else if (mongo === "separate") await Promise.all([connectAuthMongo(), connectAppMongo()]);

  if (enableRedis) await connectRedis();

  // Resolve auth adapter: explicit prop wins, then db.auth, then mongo default
  let authAdapter: AuthAdapter;
  if (explicitAuthAdapter) {
    authAdapter = explicitAuthAdapter;
  } else if (authStore === "sqlite") {
    const { sqliteAuthAdapter } = await import("./adapters/sqliteAuth");
    authAdapter = sqliteAuthAdapter;
  } else if (authStore === "memory") {
    authAdapter = memoryAuthAdapter;
  } else {
    authAdapter = mongoAuthAdapter;
  }

  setAuthAdapter(authAdapter);
  setAppRoles(roles);
  setDefaultRole(defaultRole ?? null);
  setPrimaryField(primaryField);
  setEmailVerificationConfig(emailVerification ?? null);
  setEmailVerificationStore(sessions);
  setPasswordResetConfig(passwordReset ?? null);
  setPasswordResetStore(sessions);
  setAuthRateLimitStore(authRateLimit?.store ?? (enableRedis ? "redis" : "memory"));
  setMaxSessions(sessionPolicy.maxSessions ?? 6);
  setPersistSessionMetadata(sessionPolicy.persistSessionMetadata ?? true);
  setIncludeInactiveSessions(sessionPolicy.includeInactiveSessions ?? false);
  setTrackLastActive(sessionPolicy.trackLastActive ?? false);

  if (defaultRole && !authAdapter.setRoles) {
    throw new Error(`createApp: "defaultRole" is set to "${defaultRole}" but the auth adapter does not implement setRoles. Add setRoles to your adapter or remove defaultRole.`);
  }

  if (emailVerification && primaryField !== "email") {
    throw new Error(`createApp: "emailVerification" is only supported when primaryField is "email". Either set primaryField to "email" or remove emailVerification.`);
  }

  if (passwordReset && primaryField !== "email") {
    throw new Error(`createApp: "passwordReset" is only supported when primaryField is "email". Either set primaryField to "email" or remove passwordReset.`);
  }

  if (passwordReset && !authAdapter.setPassword) {
    throw new Error(`createApp: "passwordReset" is configured but the auth adapter does not implement setPassword. Add setPassword to your adapter or remove passwordReset.`);
  }

  if (oauthProviders) initOAuthProviders(oauthProviders);
  const configuredOAuth = getConfiguredOAuthProviders();

  // OAuth paths must bypass bearer auth — initiation and link routes are browser redirects,
  // callbacks come from external providers; none can send a bearer token header.
  const oauthBypass = configuredOAuth.flatMap((p) => [
    `/auth/${p}`,
    `/auth/${p}/callback`,
    `/auth/${p}/link`,
  ]);

  const DEFAULT_BYPASS = ["/docs", "/openapi.json", "/sw.js", "/health", "/"];
  const bearerAuthBypass = [...DEFAULT_BYPASS, ...oauthBypass, ...extraBypass];

  const app = new OpenAPIHono<AppEnv>();

  app.use(logger());
  app.use(secureHeaders());
  app.use(cors({ origin: corsOrigins, allowHeaders: ["Content-Type", "Authorization", HEADER_USER_TOKEN], exposeHeaders: ["x-cache"], credentials: true }));
  if ((botCfg.blockList?.length ?? 0) > 0) {
    const { botProtection } = await import("@middleware/botProtection");
    app.use(botProtection({ blockList: botCfg.blockList }));
  }
  app.use(rateLimit({ ...rlConfig, fingerprintLimit: botCfg.fingerprintRateLimit ?? false }));
  if (enableBearerAuth) {
    app.use(async (c, next) => {
      const path = c.req.path;
      if (bearerAuthBypass.includes(path)) {
        return next();
      }
      return bearerAuth(c, next);
    });
  }
  app.use(identify);
  for (const mw of middleware) app.use(mw);

  setAppName(appName);

  // Core routes (auth, etc.)
  const coreRoutesDir = import.meta.dir + "/routes";
  const coreGlob = new Bun.Glob("*.ts");
  for await (const file of coreGlob.scan({ cwd: coreRoutesDir })) {
    if (file === "auth.ts") continue; // mounted separately below via createAuthRouter
    if (file === "oauth.ts") continue; // mounted separately below
    const mod = await import(`${coreRoutesDir}/${file}`);
    if (mod.router) app.route("/", mod.router);
  }

  if (enableAuthRoutes) {
    const { createAuthRouter } = await import(`${coreRoutesDir}/auth`);
    app.route("/", createAuthRouter({ primaryField, emailVerification, passwordReset, rateLimit: authRateLimit }));
  }

  if (configuredOAuth.length > 0) {
    app.route("/", createOAuthRouter(configuredOAuth, postOAuthRedirect));
  }

  // Service routes — collect all, sort by optional exported `priority`, then mount
  const serviceGlob = new Bun.Glob("**/*.ts");
  const serviceFiles: string[] = [];
  for await (const file of serviceGlob.scan({ cwd: routesDir })) {
    serviceFiles.push(file);
  }

  const serviceMods = await Promise.all(
    serviceFiles.map(async (file) => ({
      file,
      mod: await import(`${routesDir}/${file}`),
    }))
  );

  serviceMods
    .sort((a, b) => (a.mod.priority ?? Infinity) - (b.mod.priority ?? Infinity))
    .forEach(({ mod }) => {
      if (mod.router) app.route("/", mod.router);
    });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 418 | 429 | 500);
    }
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  app.doc("/openapi.json", { openapi: "3.0.0", info: { title: appName, version: openApiVersion } });
  app.get("/docs", Scalar({ url: "/openapi.json" }));
  app.get("/sw.js", (c) => c.body("", 200, { "Content-Type": "application/javascript" }));

  return app;
};
