<!-- AUTO-GENERATED — edit docs/sections/, not this file. Run: bun run readme -->

# Bunshot by Last Shot Labs

A personal Bun + Hono API framework. Install it in any app and get auth, sessions, rate limiting, WebSocket, queues, and OpenAPI docs out of the box — then add your own routes, workers, models, and services.

## Quick Start

```bash
bun add @lastshotlabs/bunshot hono zod
```

```ts
// src/index.ts
import { createServer } from "@lastshotlabs/bunshot";

await createServer({
  routesDir: import.meta.dir + "/routes",
  db: { auth: "memory", mongo: false, redis: false, sessions: "memory", cache: "memory" },
});
```

```ts
// src/routes/hello.ts
import { z } from "zod";
import { createRoute, createRouter } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/hello",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ message: z.string() }) } },
        description: "Hello",
      },
    },
  }),
  (c) => c.json({ message: "Hello world!" }, 200)
);
```

```bash
bun run src/index.ts
```

Auth, OpenAPI docs (`/docs`), health check, and WebSocket are all live. No databases required — swap `"memory"` for `"redis"` / `"mongo"` / `"sqlite"` when you're ready.

---

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev) + [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
- **Docs UI**: [Scalar](https://scalar.com)
- **Data / Auth**: MongoDB, SQLite, or in-memory — configurable via `db.auth` (default: MongoDB via [Mongoose](https://mongoosejs.com))
- **Cache / Sessions**: Redis, MongoDB, SQLite, or in-memory — configurable via `db.sessions` / `db.cache` (default: Redis via [ioredis](https://github.com/redis/ioredis))
- **Auth**: JWT via [jose](https://github.com/panva/jose), HttpOnly cookies + `x-user-token` header
- **Queues**: [BullMQ](https://docs.bullmq.io) (requires Redis with `noeviction` policy)
- **Validation**: [Zod v4](https://zod.dev)

---

## CLI — Scaffold a New Project

```bash
bunx @lastshotlabs/bunshot "My App"
```

You can also pass a custom directory name:

```bash
bunx @lastshotlabs/bunshot "My App" my-app-dir
```

This creates a ready-to-run project with:

```
my-app/
  src/
    index.ts            # entry point
    config/index.ts     # centralized app configuration
    lib/constants.ts    # app name, version, roles
    routes/             # add your route files here
    workers/            # BullMQ workers (auto-discovered)
    middleware/          # custom middleware
    models/             # data models
    services/           # business logic
  tsconfig.json         # pre-configured with path aliases
  .env                  # environment variables template
```

Path aliases like `@config/*`, `@lib/*`, `@middleware/*`, `@models/*`, `@routes/*`, `@services/*`, and `@workers/*` are set up automatically in `tsconfig.json`.

---

## Installation

```bash
# from npm
bun add @lastshotlabs/bunshot
```

---

## Full Configuration Example

For production apps, break config into its own file with MongoDB, Redis, OAuth, and email verification. See the [Configuration](#configuration) section for the full reference.

```ts
// src/config/index.ts
import { type CreateServerConfig } from "@lastshotlabs/bunshot";

export const appConfig: CreateServerConfig = {
  app: { name: "My App", version: "1.0.0" },
  routesDir: import.meta.dir + "/routes",
  workersDir: import.meta.dir + "/workers",
  db: { mongo: "single", redis: true, sessions: "redis", cache: "memory", auth: "mongo" },
  auth: { roles: ["admin", "user"], defaultRole: "user", primaryField: "email" },
  security: { bearerAuth: true, cors: ["*"] },
};
```

### Built-in endpoints

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create account, returns JWT |
| `POST /auth/login` | Login, returns JWT |
| `POST /auth/logout` | Invalidates the current session |
| `GET /auth/me` | Current user profile |
| `GET /health` | Health check |
| `GET /docs` | Scalar API docs UI |
| `GET /openapi.json` | OpenAPI spec |
| `WS /ws` | WebSocket endpoint |

---

## Adding Routes

Drop a file in your `routes/` directory that exports a `router` — routes are auto-discovered via glob. Subdirectories are supported.

```ts
import { z } from "zod";
import { createRoute, createRouter } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/hello",
    responses: {
      200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Hello" },
    },
  }),
  (c) => c.json({ message: "Hello world!" }, 200)
);
```

Import `createRoute` from `@lastshotlabs/bunshot` (not `@hono/zod-openapi`) to get automatic OpenAPI schema registration. Four registration methods are available — route-level auto-registration, directory/glob auto-discovery via `modelSchemas`, batch explicit via `registerSchemas`, and single explicit via `registerSchema`. Use `withSecurity` to add auth requirements without breaking type inference.

---

## MongoDB Connections

MongoDB and Redis connect automatically inside `createServer` / `createApp`. Control via the `db` config:

- **`mongo: "single"`** (default) — auth and app data share one server (`MONGO_*` env vars)
- **`mongo: "separate"`** — auth on its own server (`MONGO_AUTH_*` env vars), app data on another
- **`mongo: false`** — skip auto-connect, manage connections yourself via `connectAuthMongo()`, `connectAppMongo()`, `connectRedis()`

---

## Adding Models

Import `appConnection` and register Mongoose models on it. `appConnection` is a lazy proxy — `.model()` works before `connectMongo()` has been called.

```ts
import { appConnection } from "@lastshotlabs/bunshot";
import { Schema, type HydratedDocument } from "mongoose";

const ProductSchema = new Schema({ name: String, price: Number }, { timestamps: true });
export const Product = appConnection.model("Product", ProductSchema);
```

Bunshot also provides `zodToMongoose` (Zod -> Mongoose schema conversion) and `createDtoMapper` (DB document -> API DTO) to use Zod as the single source of truth for your models and OpenAPI spec.

---

## Jobs (BullMQ)

Queue-based background jobs powered by BullMQ (requires Redis with `noeviction` policy).

```ts
// Define a queue
import { createQueue } from "@lastshotlabs/bunshot";
export const emailQueue = createQueue<{ to: string; subject: string }>("email");

// Define a worker (auto-discovered from workersDir)
import { createWorker } from "@lastshotlabs/bunshot";
export const emailWorker = createWorker("email", async (job) => { /* send email */ });
```

Features include cron/scheduled workers via `createCronWorker`, dead letter queues via `createDLQHandler`, job status REST endpoints, and WebSocket broadcasting from workers via `publish`.

---

## WebSocket

The `/ws` endpoint is mounted automatically by `createServer`. Default behavior: cookie-JWT auth on upgrade, room action handling, and echo for other messages.

`SocketData` carries `id`, `userId`, and `rooms` per connection. Pass a type parameter to `createServer<T>` to extend with custom fields. Override `ws.handler` (open/message/close) and `ws.upgradeHandler` for custom behavior.

---

## WebSocket Rooms / Channels

Rooms are built on Bun's native pub/sub. Clients send `{ action: "subscribe", room: "chat:general" }` to join; servers broadcast via `publish("chat:general", data)`.

Utilities: `publish`, `subscribe`, `unsubscribe`, `getSubscriptions`, `getRooms`, `getRoomSubscribers`. Gate room access with `ws.onRoomSubscribe` (sync or async guard).

---

## Adding Middleware

### Global (runs on every request)

Pass via `middleware` config — injected after `identify`, before route matching:

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  middleware: [myMiddleware],
});
```

Write it using core's exported types:

```ts
// src/middleware/tenant.ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lastshotlabs/bunshot";

export const tenantMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // c.get("userId") is available — identify has already run
  await next();
};
```

### Per-route

```ts
import { userAuth, rateLimit } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth);
router.use("/admin", rateLimit({ windowMs: 60_000, max: 10 }));
```

---

## Response Caching

Cache GET responses with `cacheResponse({ ttl, key })` and bust them with `bustCache(key)`. Supports Redis, MongoDB, SQLite, and memory stores. Cache keys are auto-namespaced by app name and tenant (when multi-tenancy is active).

```ts
import { cacheResponse, bustCache } from "@lastshotlabs/bunshot";

router.use("/products", cacheResponse({ ttl: 60, key: "products" }));
// ...
await bustCache("products"); // hits all connected stores
```

Supports per-user caching via `key: (c) => ...`, per-resource caching, and wildcard invalidation via `bustCachePattern("products:*")`.

---

## Extending the Context (Custom Variables)

When building a tenant app or any app that needs extra typed context variables (beyond the built-in), extend `AppEnv["Variables"]` and create a typed router factory.

```ts
// src/lib/context.ts
import { createRouter as coreCreateRouter, type AppEnv } from "@lastshotlabs/bunshot";
import type { OpenAPIHono } from "@hono/zod-openapi";

export type MyVariables = AppEnv["Variables"] & {
  tenantId: string;
};

export type MyEnv = { Variables: MyVariables };

export const createRouter = () => coreCreateRouter() as unknown as OpenAPIHono<MyEnv>;
```

Use the local `createRouter` instead of the one from the package — your routes will then have full TypeScript access to the extra variables:

```ts
// src/routes/items.ts
import { createRouter } from "../lib/context";
import { userAuth } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.use("/items", userAuth);

router.get("/items", async (c) => {
  const tenantId = c.get("tenantId"); // fully typed
  const userId   = c.get("userId");   // still available from AppEnv
  return c.json({ tenantId, userId });
});
```

Populate the extra variables from a global middleware:

```ts
// src/middleware/tenant.ts
import type { MiddlewareHandler } from "hono";
import type { MyEnv } from "../lib/context";

export const tenantMiddleware: MiddlewareHandler<MyEnv> = async (c, next) => {
  const tenantId = c.req.header("x-tenant-id") ?? "default";
  c.set("tenantId", tenantId);
  await next();
};
```

Then register it in `createServer`:

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  middleware: [tenantMiddleware],
});
```

---

## Configuration

`createServer` / `createApp` accept a config object with these top-level keys:

| Key | Purpose |
|-----|---------|
| `routesDir` | **(required)** Path to auto-discovered route files |
| `app` | App name and version (shown in docs) |
| `auth` | Roles, OAuth, email verification, MFA, refresh tokens, rate limiting, account deletion |
| `db` | Connection and store routing — mongo, redis, sqlite, sessions, cache, auth adapter |
| `security` | CORS, bearer auth, rate limiting, bot protection |
| `tenancy` | Multi-tenant resolution (header/subdomain/path) |
| `jobs` | Job status REST endpoint config |
| `ws` | WebSocket handler and upgrade overrides |
| `middleware` | Extra global middleware array |
| `modelSchemas` | Schema auto-discovery paths |
| `port`, `workersDir`, `enableWorkers` | Server options |

---

## Running without Redis

Set `db.redis: false` and `db.sessions: "mongo"` to run the entire auth flow on MongoDB only. Sessions, OAuth state, and response caching (when `store: "mongo"`) all work without Redis. The only feature that still requires Redis is BullMQ queues.

```ts
await createServer({
  db: {
    mongo: "single",
    redis: false,
    sessions: "mongo",   // sessions + OAuth state → MongoDB
    cache: "mongo",      // or omit cacheResponse entirely if not using it
  },
});
```

Redis key namespacing: when Redis is used, all keys are prefixed with `appName` (`session:{appName}:{sessionId}`, `usersessions:{appName}:{userId}`, `oauth:{appName}:state:{state}`, `cache:{appName}:{key}`) so multiple apps sharing one Redis instance never collide.

---

## Running without Redis or MongoDB

Two lightweight options for local dev, tests, or small projects with no external services:

### SQLite — persisted to disk

Uses `bun:sqlite` (built into Bun, zero npm deps). A single `.db` file holds all users, sessions, OAuth state, and cache.

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  db: {
    auth: "sqlite",
    sqlite: import.meta.dir + "/../data.db",  // created automatically on first run
    mongo: false,
    redis: false,
    sessions: "sqlite",
    cache: "sqlite",
  },
});
```

#### Optional: periodic cleanup of expired rows

Expired rows are filtered out lazily on read. For long-running servers, sweep them periodically:

```ts
import { startSqliteCleanup } from "@lastshotlabs/bunshot";

startSqliteCleanup();           // default: every hour
startSqliteCleanup(5 * 60_000); // custom interval (ms)
```

### Memory — ephemeral, great for tests

Pure in-memory Maps. No files, no external services. All state is lost on process restart.

```ts
import { createServer, clearMemoryStore } from "@lastshotlabs/bunshot";

await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  db: {
    auth: "memory",
    mongo: false,
    redis: false,
    sessions: "memory",
    cache: "memory",
  },
});

// In tests — reset all state between test cases:
clearMemoryStore();
```

### Limitations (both sqlite and memory)

- BullMQ queues still require Redis

---

## Auth Flow

Sessions are backed by Redis (default), MongoDB, SQLite, or memory. Each login creates an independent session keyed by UUID, so multiple devices stay logged in simultaneously.

- **Browser clients**: `POST /auth/login` sets an HttpOnly cookie automatically
- **API clients**: Read `token` from the response body, send `x-user-token: <token>` header

Features include session management (list/revoke), refresh tokens (short-lived access + long-lived refresh with rotation), MFA (TOTP via Google Authenticator, email OTP, recovery codes), account deletion (immediate or queued with grace period), custom auth adapters, rate limiting on all auth endpoints, bot protection (fingerprint rate limiting + CIDR blocklist), and password set/reset flows.

Protect routes with `userAuth`, `requireRole("admin")`, and `requireVerifiedEmail` middleware.

---

## Roles

Declare roles in `createServer({ auth: { roles: ["admin", "editor", "user"], defaultRole: "user" } })`. The default role is auto-assigned on registration.

```ts
import { userAuth, requireRole, addUserRole } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth, requireRole("admin"));
await addUserRole(userId, "admin"); // also: setUserRoles, removeUserRole
```

Tenant-scoped roles are supported when multi-tenancy is enabled — `requireRole` checks tenant roles when `tenantId` is in context, falls back to app-wide roles otherwise. Use `requireRole.global("superadmin")` to always check app-wide roles.

---

## Multi-Tenancy

Opt-in via `tenancy` config. Resolves tenant ID from header, subdomain, or path segment on each request.

```ts
await createServer({
  tenancy: {
    resolution: "header",
    headerName: "x-tenant-id",
    onResolve: async (tenantId) => { /* validate, return config or null */ },
  },
});
```

Auth routes are exempt (global user pool). Rate limits and cache keys are auto-namespaced per-tenant. CRUD helpers: `createTenant`, `getTenant`, `listTenants`, `deleteTenant`.

---

## Social Login (OAuth)

Pass `auth.oauth.providers` to enable Google and/or Apple sign-in. Routes are mounted automatically for each configured provider.

```ts
auth: {
  oauth: {
    postRedirect: "/dashboard",
    providers: {
      google: { clientId: "...", clientSecret: "...", redirectUri: "..." },
    },
  },
}
```

Auto-mounted routes per provider: initiate (`GET /auth/{provider}`), callback, link to existing account (`GET /auth/{provider}/link`), and unlink (`DELETE /auth/{provider}/link`). Supports custom adapters via `findOrCreateByProvider`, `linkProvider`, and `unlinkProvider`.

---

## Peer Dependencies

Bunshot declares the following as peer dependencies so you control their versions and avoid duplicate installs in your app.

### Required

These must be installed in every consuming app:

```bash
bun add hono zod
```

| Package | Required version |
|---|---|
| `hono` | `>=4.12 <5` |
| `zod` | `>=4.0 <5` |

### Optional

Install only what your app actually uses:

```bash
# MongoDB auth / sessions / cache
bun add mongoose

# Redis sessions, cache, rate limiting, or BullMQ
bun add ioredis

# Background job queues
bun add bullmq

# MFA / TOTP
bun add otpauth
```

| Package | Required version | When you need it |
|---|---|---|
| `mongoose` | `>=9.0 <10` | `db.auth: "mongo"`, `db.sessions: "mongo"`, or `db.cache: "mongo"` |
| `ioredis` | `>=5.0 <6` | `db.redis: true` (the default), or any store set to `"redis"` |
| `bullmq` | `>=5.0 <6` | Workers / queues |
| `otpauth` | `>=9.0 <10` | `auth.mfa` configuration |

If you're running fully on SQLite or memory (no Redis, no MongoDB), none of the optional peers are needed.

---

## Environment Variables

```env
NODE_ENV=development
PORT=...

# MongoDB (single connection — used by connectMongo())
MONGO_USER_DEV=...
MONGO_PW_DEV=...
MONGO_HOST_DEV=...
MONGO_DB_DEV=...
MONGO_USER_PROD=...
MONGO_PW_PROD=...
MONGO_HOST_PROD=...
MONGO_DB_PROD=...

# MongoDB auth connection (separate server — used by connectAuthMongo())
# Only needed when running auth on a different cluster from app data
MONGO_AUTH_USER_DEV=...
MONGO_AUTH_PW_DEV=...
MONGO_AUTH_HOST_DEV=...
MONGO_AUTH_DB_DEV=...
MONGO_AUTH_USER_PROD=...
MONGO_AUTH_PW_PROD=...
MONGO_AUTH_HOST_PROD=...
MONGO_AUTH_DB_PROD=...

# Redis
REDIS_HOST_DEV=host:port
REDIS_USER_DEV=...
REDIS_PW_DEV=...
REDIS_HOST_PROD=host:port
REDIS_USER_PROD=...
REDIS_PW_PROD=...

# JWT
JWT_SECRET_DEV=...
JWT_SECRET_PROD=...

# Bearer API key (required on every non-bypassed request)
BEARER_TOKEN_DEV=...
BEARER_TOKEN_PROD=...

# Logging (optional — defaults to on in dev)
LOGGING_VERBOSE=true

# OAuth (only needed if using oauthProviders)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

APPLE_CLIENT_ID=...
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

---

## Package Development

To test changes locally, install the package from the local path in a sibling project:

```bash
bun add @lastshotlabs/bunshot@file:../bunshot
```

---

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
  bustAuthLimit, trackAttempt, isLimited,          // auth rate limiting — use in custom routes or admin unlocks
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
  type AccountDeletionConfig,
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
