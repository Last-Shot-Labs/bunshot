# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @README for project overview

Update ReadMe and this file (CLAUDE.md) when adding, modifying, or deleting features to ensure proper documentation

## Commands

```bash
bun run dev     # Watch mode (hot reload)
bun run start   # Run without watch
bun run readme  # Compile README.md from docs/sections/ (default profile — all full)
bun run readme:npm  # Compile with npm profile (overview variants for large sections)
```

There are no build, test, or lint scripts — this is a library package published to npm as `@lastshotlabs/bunshot`.

### Modular README

`README.md` is auto-generated — **do not edit it directly**. Edit the section files in `docs/sections/` instead, then run `bun run readme` to recompile.

- **`docs/readme.config.json`** — Section order, default variants, and named profiles. Reorder sections by moving lines here.
- **`docs/build-readme.ts`** — Zero-dependency Bun build script.
- **`docs/sections/{topic}/full.md`** — Full detailed content for each section.
- **`docs/sections/{topic}/overview.md`** — Concise summary (exists for larger sections only).
- Profiles (e.g., `npm`) override specific sections to use `overview` instead of `full`. Add new profiles in the config's `profiles` object.
- **Extensible by consumers:** `docs/sections/` ships with the npm package. Consuming projects can reference bunshot sections in their own `readme.config.json` via package paths (e.g., `"file": "@lastshotlabs/bunshot/docs/auth-flow/overview.md"`). The build script resolves package paths via `import.meta.resolve`.

## Architecture

This is a **Bun + Hono API framework library** that consuming projects install as a dependency. It provides batteries-included scaffolding: auto-discovery of routes/workers, built-in auth, OpenAPI docs, WebSocket rooms, caching, and rate limiting.

### Entry Points

- **[src/app.ts](src/app.ts)** — `createApp(config)` factory: sets up Hono with CORS, middleware stack, auto-discovered routes, and OpenAPI/Scalar docs
- **[src/server.ts](src/server.ts)** — `createServer(config)` factory: wraps app with `Bun.serve()`, adds WebSocket upgrade handling, and auto-discovers BullMQ workers
- **[src/index.ts](src/index.ts)** — Barrel export for all public APIs
- **[src/cli.ts](src/cli.ts)** — CLI entry point

### Key Patterns

**Route auto-discovery:** Consuming projects place routes in a `routes/` directory. The framework scans and registers them automatically. Routes use `@hono/zod-openapi` for type-safe OpenAPI definitions. Load order can be controlled by exporting `export const priority = <number>` from a route file (lower = loaded first; files without it load last).

**OpenAPI schema auto-registration:** Import `createRoute` from `@lastshotlabs/bunshot` (not from `@hono/zod-openapi` directly). The wrapper auto-registers every unnamed request body / response schema as a named `components/schemas` entry by writing directly to `zodToOpenAPIRegistry` (bypasses `.openapi()` prototype dependency). HTTP methods map to action verbs (`post→Create`, `patch→Update`, `put→Replace`, `delete→Delete`, `get→Get`); request bodies get a `Request` suffix; response status codes map to semantic suffixes (`200/201/204→Response`, `400→BadRequestError`, `401→UnauthorizedError`, `403→ForbiddenError`, `404→NotFoundError`, `409→ConflictError`, `422→ValidationError`, `429→RateLimitError`, `500→InternalError`, unknown codes fall back to the number). Schemas already registered are never overwritten. Implementation: `src/lib/createRoute.ts`.

**`registerSchema`:** Explicit named registration for a single shared schema. `registerSchema("Name", schema)` returns the schema unchanged. Works anywhere — inline in route files, in a shared schema file, etc. Exported from the package.

**`registerSchemas`:** Batch version of `registerSchema`. Accepts an object where keys are schema names; returns the same object. `registerSchemas({ LedgerItem: z.object({...}), Product: z.object({...}) })` registers both at once and returns them for export/use. Exported from the package.

**`modelSchemas` auto-discovery:** Pass `modelSchemas` to `createServer`/`createApp` with a directory path, array of paths, or glob patterns. All matching `.ts` files are imported *before* route discovery. With `registration: "auto"` (default), every exported Zod schema is auto-registered — the export name is used as the `refId` with a trailing `Schema` suffix stripped (`LedgerItemSchema` → `"LedgerItem"`). Schemas already registered via `registerSchema`/`registerSchemas` are never overwritten. With `registration: "explicit"`, files are imported but registration is left to the user. Supports co-location with models or services via glob: `modelSchemas: [dir + "/models", dir + "/schemas/**/*.schema.ts"]`.

**`withSecurity`:** Adds OpenAPI `security` requirements to a route after `createRoute` has inferred its generic type parameter. Inlining `security: [...]` inside `createRoute({...})` breaks `c.req.valid()` inference (TypeScript collapses `InputTypeJson<R>` to `never`). Usage: `withSecurity(createRoute({...}), { cookieAuth: [] }, { userToken: [] })`. Exported from the package.

**Worker auto-discovery:** BullMQ workers are placed in a `workers/` directory and auto-started by `createServer`.

**Auth flow:** `src/services/auth.ts` orchestrates login/register/logout. The auth store is pluggable via `AuthAdapter` interface (default: `src/adapters/mongoAuth.ts`). Sessions can be stored in Redis, MongoDB, SQLite, or memory — configured via `db.sessions` in `CreateAppConfig`. Each login creates an independent session (keyed by UUID `sessionId` embedded in the JWT as the `sid` claim), so multiple devices stay logged in simultaneously. Session concurrency, metadata persistence, and `lastActiveAt` tracking are controlled via `auth.sessionPolicy`. Login identifier is configurable via `auth.primaryField` (`"email"` | `"username"` | `"phone"`). Email verification is opt-in via `auth.emailVerification` (supports `required: true` to block login until verified, `tokenExpiry` in seconds to control token TTL — defaults to 24 hours). Password reset is opt-in via `auth.passwordReset` (`onSend` callback receives email + token; `tokenExpiry` in seconds — defaults to 1 hour); mounts `POST /auth/forgot-password` and `POST /auth/reset-password`, both rate-limited by IP. Refresh tokens are opt-in via `auth.refreshTokens` — configures short-lived access tokens + long-lived refresh tokens with rotation and grace window for theft detection. MFA is opt-in via `auth.mfa` — supports TOTP, email OTP (configurable via `mfa.emailOtp`), and WebAuthn/FIDO2 security keys (configurable via `mfa.webauthn`); enables setup/verify/disable routes under `/auth/mfa/*`; login returns `{ mfaRequired, mfaToken, mfaMethods }` when MFA is enabled (plus `webauthnOptions` when WebAuthn is active); OAuth logins skip MFA. Account deletion is opt-in via `auth.accountDeletion` — enables `DELETE /auth/me` with lifecycle hooks and optional queued deletion via BullMQ.

**Multi-tenancy:** Opt-in via `tenancy` config in `CreateAppConfig`. The tenant middleware resolves tenant ID via header, subdomain, or path segment, validates via `onResolve` callback (with LRU cache), and attaches `tenantId` + `tenantConfig` to context. Auth routes are exempt (auth is global). Rate limits and cache keys are automatically namespaced per-tenant. Tenant-scoped roles are supported via `requireRole` (checks tenant roles when tenant context exists, falls back to app-wide roles otherwise). Provisioning helpers: `createTenant`, `deleteTenant`, `getTenant`, `listTenants` (MongoDB-backed).

**Context extension:** The framework exposes a typed `AppContext` (Hono `Context`) that consuming apps extend with their own variables.

### Lib Layer (`src/lib/`)

| File | Purpose |
|------|---------|
| `mongo.ts` | Mongoose connection management; `disconnectMongo()` for clean shutdown |
| `redis.ts` | ioredis client; `disconnectRedis()` for clean shutdown |
| `jwt.ts` | `jose`-based JWT sign/verify |
| `session.ts` | Multi-session CRUD — keyed by `sessionId` UUID; captures IP/UA metadata; enforces `maxSessions` with oldest-first eviction; exposes `getUserSessions`, `getActiveSessionCount`, `evictOldestSession`, `updateSessionLastActive`; refresh token support (`setRefreshToken`, `getSessionByRefreshToken`, `rotateRefreshToken`); store set via `db.sessions` ("redis" \| "mongo" \| "sqlite" \| "memory") |
| `auth.ts` | Register/login/logout/password logic |
| `oauth.ts` | OAuth provider coordination via `arctic` — state store set via `db.oauthState` |
| `cache.ts` | Response cache — default store set via `db.cache`, overridable per-route; exports `bustCache` (all stores) and `bustCachePattern` (wildcard invalidation) |
| `rateLimit.ts` | Per-key rate limiting; exports `trackAttempt`, `isLimited`, `bustAuthLimit` for use in custom routes |
| `resetPassword.ts` | Password reset token CRUD — `createResetToken`, `consumeResetToken`; 4-backend (redis/mongo/sqlite/memory); store set via `setPasswordResetStore` |
| `mfaChallenge.ts` | MFA challenge token CRUD — `createMfaChallenge(userId, options?)`, `consumeMfaChallenge`, `replaceMfaChallengeOtp`, `createWebAuthnRegistrationChallenge`, `consumeWebAuthnRegistrationChallenge`; 4-backend (redis/mongo/sqlite/memory); configurable TTL; `purpose` field (`"login"` \| `"webauthn-registration"`) prevents cross-flow token reuse; stores `emailOtpHash`, `webauthnChallenge`, `createdAt`, `resendCount` |
| `tenant.ts` | Tenant provisioning helpers — `createTenant`, `deleteTenant`, `getTenant`, `listTenants`; MongoDB-backed via `Tenant` model on `authConnection` |
| `roles.ts` | App-wide + tenant-scoped role helpers — `setUserRoles`, `addUserRole`, `removeUserRole`, `getTenantRoles`, `setTenantRoles`, `addTenantRole`, `removeTenantRole` |
| `queue.ts` | BullMQ factory helpers — `createQueue`, `createWorker`, `createCronWorker`, `createDLQHandler`, `cleanupStaleSchedulers` |
| `ws.ts` | WebSocket room registry, pub/sub helpers (`publish`, `subscribe`, `unsubscribe`, `getSubscriptions`, `handleRoomActions`, `getRooms`, `getRoomSubscribers`) — in-memory, no DB dependency |
| `createRoute.ts` | Wraps `@hono/zod-openapi`'s `createRoute` to auto-register unnamed request/response schemas as named OpenAPI components; also exports `withSecurity` (adds security after type inference), `registerSchema` (single explicit registration), `registerSchemas` (batch registration), and `maybeAutoRegister` (internal, used by `modelSchemas` discovery in `createApp`); all public exports re-exported from the package |

### Middleware (`src/middleware/`)

- `bearerAuth` — API key validation via `Authorization: Bearer` header
- `identify` — Reads `sid` claim from JWT, looks up session by sessionId, attaches `authUserId` and `sessionId` to context (non-blocking); optionally calls `updateSessionLastActive` when `auth.sessionPolicy.trackLastActive` is true
- `userAuth` — Requires authenticated user (blocks if not logged in)
- `requireRole` — RBAC role enforcement; tenant-aware (checks tenant-scoped roles when `tenantId` is in context, falls back to app-wide roles); `requireRole.global(...)` always checks app-wide roles
- `requireVerifiedEmail` — Blocks access for users whose email has not been verified (requires `getEmailVerified` on adapter)
- `rateLimit` — Request rate limiting; per-tenant namespaced when tenant context is present
- `cacheResponse` — Response caching with TTL; per-tenant namespaced when tenant context is present
- `tenant` — Tenant resolution middleware; resolves tenant ID from header/subdomain/path, validates via `onResolve` (with LRU cache), attaches `tenantId` + `tenantConfig` to context; exempt paths skip resolution

### Adapters (`src/adapters/`)

| File | Purpose |
|------|---------|
| `mongoAuth.ts` | Default `AuthAdapter` backed by Mongoose / MongoDB |
| `sqliteAuth.ts` | `AuthAdapter` + session/OAuth/cache helpers backed by `bun:sqlite`. Exports `setSqliteDb(path)` and `startSqliteCleanup()`. |
| `memoryAuth.ts` | `AuthAdapter` + session/OAuth/cache helpers backed by in-memory Maps. Exports `clearMemoryStore()` for test isolation (also clears rate limit state). |

### Built-in Routes (`src/routes/`)

- `auth.ts` — `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/set-password`, `/auth/me`, `DELETE /auth/me` (account deletion), `/auth/sessions` (GET list + DELETE by sessionId), `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password` (when `passwordReset` configured), `/auth/reset-password` (when `passwordReset` configured), `POST /auth/refresh` (when `refreshTokens` configured), `POST /auth/cancel-deletion` (when queued deletion configured)
- `oauth.ts` — OAuth initiation (`GET /auth/{provider}`), callbacks, link (`GET /auth/{provider}/link`), and unlink (`DELETE /auth/{provider}/link`) handlers
- `mfa.ts` — MFA routes (when `auth.mfa` configured): `POST /auth/mfa/setup`, `POST /auth/mfa/verify-setup`, `POST /auth/mfa/verify`, `DELETE /auth/mfa`, `POST /auth/mfa/recovery-codes`, `GET /auth/mfa/methods`, `POST /auth/mfa/email-otp/enable`, `POST /auth/mfa/email-otp/verify-setup`, `DELETE /auth/mfa/email-otp`, `POST /auth/mfa/resend`, `POST /auth/mfa/webauthn/register-options`, `POST /auth/mfa/webauthn/register`, `GET /auth/mfa/webauthn/credentials`, `DELETE /auth/mfa/webauthn/credentials/:credentialId`, `DELETE /auth/mfa/webauthn`
- `jobs.ts` — Job status routes (when `jobs.statusEndpoint` is true): `GET /jobs` (list queues), `GET /jobs/:queue` (list jobs), `GET /jobs/:queue/:id`, `GET /jobs/:queue/:id/logs`, `GET /jobs/:queue/dead-letters`
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


