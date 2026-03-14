# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @README for project overview

Update ReadMe and this file (CLAUDE.md) when adding, modifying, or deleting features to ensure proper documentation

## Commands

```bash
bun run dev     # Watch mode (hot reload)
bun run start   # Run without watch
```

There are no build, test, or lint scripts — this is a library package published to npm as `@lastshotlabs/bunshot`.

## Architecture

This is a **Bun + Hono API framework library** that consuming projects install as a dependency. It provides batteries-included scaffolding: auto-discovery of routes/workers, built-in auth, OpenAPI docs, WebSocket rooms, caching, and rate limiting.

### Entry Points

- **[src/app.ts](src/app.ts)** — `createApp(config)` factory: sets up Hono with CORS, middleware stack, auto-discovered routes, and OpenAPI/Scalar docs
- **[src/server.ts](src/server.ts)** — `createServer(config)` factory: wraps app with `Bun.serve()`, adds WebSocket upgrade handling, and auto-discovers BullMQ workers
- **[src/index.ts](src/index.ts)** — Barrel export for all public APIs
- **[src/cli.ts](src/cli.ts)** — CLI entry point

### Key Patterns

**Route auto-discovery:** Consuming projects place routes in a `routes/` directory. The framework scans and registers them automatically. Routes use `@hono/zod-openapi` for type-safe OpenAPI definitions. Load order can be controlled by exporting `export const priority = <number>` from a route file (lower = loaded first; files without it load last).

**Worker auto-discovery:** BullMQ workers are placed in a `workers/` directory and auto-started by `createServer`.

**Auth flow:** `src/services/auth.ts` orchestrates login/register/logout. The auth store is pluggable via `AuthAdapter` interface (default: `src/adapters/mongoAuth.ts`). Sessions can be stored in Redis, MongoDB, SQLite, or memory — configured via `db.sessions` in `CreateAppConfig`. Each login creates an independent session (keyed by UUID `sessionId` embedded in the JWT as the `sid` claim), so multiple devices stay logged in simultaneously. Session concurrency, metadata persistence, and `lastActiveAt` tracking are controlled via `auth.sessionPolicy`. Login identifier is configurable via `auth.primaryField` (`"email"` | `"username"` | `"phone"`). Email verification is opt-in via `auth.emailVerification` (supports `required: true` to block login until verified, `tokenExpiry` in seconds to control token TTL — defaults to 24 hours). Password reset is opt-in via `auth.passwordReset` (`onSend` callback receives email + token; `tokenExpiry` in seconds — defaults to 1 hour); mounts `POST /auth/forgot-password` and `POST /auth/reset-password`, both rate-limited by IP.

**Context extension:** The framework exposes a typed `AppContext` (Hono `Context`) that consuming apps extend with their own variables.

### Lib Layer (`src/lib/`)

| File | Purpose |
|------|---------|
| `mongo.ts` | Mongoose connection management; `disconnectMongo()` for clean shutdown |
| `redis.ts` | ioredis client; `disconnectRedis()` for clean shutdown |
| `jwt.ts` | `jose`-based JWT sign/verify |
| `session.ts` | Multi-session CRUD — keyed by `sessionId` UUID; captures IP/UA metadata; enforces `maxSessions` with oldest-first eviction; exposes `getUserSessions`, `getActiveSessionCount`, `evictOldestSession`, `updateSessionLastActive`; store set via `db.sessions` ("redis" \| "mongo" \| "sqlite" \| "memory") |
| `auth.ts` | Register/login/logout/password logic |
| `oauth.ts` | OAuth provider coordination via `arctic` — state store set via `db.oauthState` |
| `cache.ts` | Response cache — default store set via `db.cache`, overridable per-route; exports `bustCache` (all stores) and `bustCachePattern` (wildcard invalidation) |
| `rateLimit.ts` | Per-key rate limiting; exports `trackAttempt`, `isLimited`, `bustAuthLimit` for use in custom routes |
| `resetPassword.ts` | Password reset token CRUD — `createResetToken`, `consumeResetToken`; 4-backend (redis/mongo/sqlite/memory); store set via `setPasswordResetStore` |
| `ws.ts` | WebSocket room registry, pub/sub helpers (`publish`, `subscribe`, `unsubscribe`, `getSubscriptions`, `handleRoomActions`, `getRooms`, `getRoomSubscribers`) — in-memory, no DB dependency |

### Middleware (`src/middleware/`)

- `bearerAuth` — API key validation via `Authorization: Bearer` header
- `identify` — Reads `sid` claim from JWT, looks up session by sessionId, attaches `authUserId` and `sessionId` to context (non-blocking); optionally calls `updateSessionLastActive` when `auth.sessionPolicy.trackLastActive` is true
- `userAuth` — Requires authenticated user (blocks if not logged in)
- `requireRole` — RBAC role enforcement
- `requireVerifiedEmail` — Blocks access for users whose email has not been verified (requires `getEmailVerified` on adapter)
- `rateLimit` — Request rate limiting
- `cacheResponse` — Response caching with TTL

### Adapters (`src/adapters/`)

| File | Purpose |
|------|---------|
| `mongoAuth.ts` | Default `AuthAdapter` backed by Mongoose / MongoDB |
| `sqliteAuth.ts` | `AuthAdapter` + session/OAuth/cache helpers backed by `bun:sqlite`. Exports `setSqliteDb(path)` and `startSqliteCleanup()`. |
| `memoryAuth.ts` | `AuthAdapter` + session/OAuth/cache helpers backed by in-memory Maps. Exports `clearMemoryStore()` for test isolation. |

### Built-in Routes (`src/routes/`)

- `auth.ts` — `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/set-password`, `/auth/me`, `/auth/sessions` (GET list + DELETE by sessionId), `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password` (when `passwordReset` configured), `/auth/reset-password` (when `passwordReset` configured)
- `oauth.ts` — OAuth initiation (`GET /auth/{provider}`), callbacks, link (`GET /auth/{provider}/link`), and unlink (`DELETE /auth/{provider}/link`) handlers
- `health.ts` — Health check
- `home.ts` — Root endpoint

### TypeScript Path Aliases

Defined in `tsconfig.json`, used throughout the codebase:

```
@lib/*        → src/lib/*
@middleware/* → src/middleware/*
@models/*     → src/models/*
@routes/*     → src/routes/*
@workers/*    → src/workers/*
@ws/*         → src/ws/*
@schemas/*    → src/schemas/*
@services/*   → src/services/*
@queues/*     → src/queues/*
```

### WebSocket

`src/ws/index.ts` handles connection upgrades and authenticates via `getSession()` (supports all 4 store backends). Room management lives in `src/lib/ws.ts` using in-memory Maps + Bun's native pub/sub (`ws.subscribe`/`server.publish`).

### Environment Variables

See README.md for the full reference. All DB/auth vars are split by environment: `*_DEV` / `*_PROD` (selected by `NODE_ENV`). Key groups: `MONGO_*`, `REDIS_*`, `JWT_SECRET_*`, `BEARER_TOKEN_*`, `PORT`.


