# Bunshot by Last Shot Labs

A personal Bun + Hono API framework. Install it in any app and get auth, sessions, rate limiting, WebSocket, queues, and OpenAPI docs out of the box — then add your own routes, workers, models, and services.

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
# from a local path (while developing the package)
bun add @lastshotlabs/bunshot@file:../bunshot

# from GitHub Packages (once published)
bun add @lastshotlabs/bunshot
```

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
```

| Package | Required version | When you need it |
|---|---|---|
| `mongoose` | `>=9.0 <10` | `db.auth: "mongo"`, `db.sessions: "mongo"`, or `db.cache: "mongo"` |
| `ioredis` | `>=5.0 <6` | `db.redis: true` (the default), or any store set to `"redis"` |
| `bullmq` | `>=5.0 <6` | Workers / queues |

If you're running fully on SQLite or memory (no Redis, no MongoDB), none of the optional peers are needed.

---

## Quick Start

```ts
// src/index.ts
import { createServer } from "@lastshotlabs/bunshot";
import { appConfig } from "@config/index";

await createServer(appConfig);
```

All configuration lives in `src/config/index.ts` — see the CLI-generated scaffold for the full setup.

That's it. Your app gets:

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create account, returns JWT |
| `POST /auth/login` | Login, returns JWT (includes `emailVerified` when verification is configured) |
| `POST /auth/logout` | Invalidates the current session only |
| `GET /auth/me` | Returns current user's `userId`, `email`, `emailVerified`, and `googleLinked` (requires login) |
| `POST /auth/set-password` | Set or update password (requires login) |
| `GET /auth/sessions` | List active sessions with metadata — IP, user-agent, timestamps (requires login) |
| `DELETE /auth/sessions/:sessionId` | Revoke a specific session by ID (requires login) |
| `POST /auth/verify-email` | Verify email with token (when `emailVerification` is configured) |
| `POST /auth/resend-verification` | Resend verification email (requires login, when `emailVerification` is configured) |
| `POST /auth/forgot-password` | Request a password reset email (when `passwordReset` is configured) |
| `POST /auth/reset-password` | Reset password using a token from the reset email (when `passwordReset` is configured) |
| `GET /health` | Health check |
| `GET /docs` | Scalar API docs UI |
| `GET /openapi.json` | OpenAPI spec |
| `WS /ws` | WebSocket endpoint (cookie-JWT auth) |

---

## Adding Routes

Drop a file in your `routes/` directory. It must export a `router`:

```ts
// src/routes/products.ts
import { z } from "zod";
import { createRoute, createRouter, userAuth } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.use("/products", userAuth); // require login

router.openapi(
  createRoute({
    method: "get",
    path: "/products",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ items: z.array(z.string()) }) } },
        description: "Product list",
      },
    },
  }),
  async (c) => {
    const userId = c.get("authUserId");
    return c.json({ items: [] }, 200);
  }
);
```

Routes are auto-discovered via glob — no registration needed. Subdirectories are supported, so you can organise by feature:

```
routes/
  products.ts
  ingredients/
    list.ts
    detail.ts
```

### OpenAPI Schema Registration

Import `createRoute` from `@lastshotlabs/bunshot` (not from `@hono/zod-openapi`). The wrapper automatically registers every unnamed request body and response schema as a named entry in `components/schemas`. Schemas you already named via `registerSchema` are never overwritten.

**Naming convention**

| Route | Part | Generated name |
|-------|------|----------------|
| `POST /products` | request body | `CreateProductsRequest` |
| `POST /products` | 201 response | `CreateProductsResponse` |
| `GET /products/{id}` | 200 response | `GetProductsByIdResponse` |
| `DELETE /products/{id}` | 404 response | `DeleteProductsByIdNotFoundError` |
| `PATCH /products/{id}` | request body | `UpdateProductsByIdRequest` |

HTTP methods map to action verbs: `GET → Get`, `POST → Create`, `PUT → Replace`, `PATCH → Update`, `DELETE → Delete`.

Status codes map to semantic suffixes: `200/201/204 → Response`, `400 → BadRequestError`, `401 → UnauthorizedError`, `403 → ForbiddenError`, `404 → NotFoundError`, `409 → ConflictError`, `422 → ValidationError`, `429 → RateLimitError`, `500 → InternalError`, `501 → NotImplementedError`, `503 → UnavailableError`. Unknown codes fall back to the number.

**Explicit registration**

Use `registerSchema` to name a shared schema that isn't tied to a specific route — for example a common error envelope reused across many routes:

```ts
import { registerSchema } from "@lastshotlabs/bunshot";
import { z } from "zod";

// Returns the schema as-is, so you can export and use it normally.
export const ErrorResponse = registerSchema("ErrorResponse",
  z.object({ error: z.string() })
);
```

Call it anywhere a file is imported before the spec is served — inline in a route file, in a shared `src/schemas/common.ts`, etc. Route files are auto-discovered, so any top-level `registerSchema` call in a route file runs automatically.

**Protected routes**

Use `withSecurity` to declare security schemes on a route without breaking `c.req.valid()` type inference. (Inlining `security` directly in `createRoute({...})` causes TypeScript to collapse the handler's input types to `never`.)

```ts
import { createRoute, withSecurity } from "@lastshotlabs/bunshot";

router.openapi(
  withSecurity(
    createRoute({ method: "get", path: "/me", ... }),
    { cookieAuth: [] },
    { userToken: [] }
  ),
  async (c) => {
    const userId = c.get("authUserId"); // fully typed
  }
);
```

Pass each security scheme as a separate object argument. The security scheme names (`cookieAuth`, `userToken`, `bearerAuth`) are registered globally by `createApp`.

**Load order:** By default, routes load in filesystem order. If a route needs to be registered before another (e.g. for Hono's first-match-wins routing), export a `priority` number — lower values load first. Routes without a `priority` load last.

```ts
// routes/tenants.ts — must match before generic routes
export const priority = 1;
export const router = createRouter();
// ...
```

---

## MongoDB Connections

MongoDB and Redis connect automatically inside `createServer` / `createApp`. Control the behavior via the `db` config object:

### Single database (default)

Both auth and app data share one server. Uses `MONGO_*` env vars.

```ts
await createServer({
  // ...
  db: { mongo: "single", redis: true }, // these are the defaults — can omit db entirely
  // app, auth, security are all optional with sensible defaults
});
```

### Separate auth database

Auth users live on a dedicated server (`MONGO_AUTH_*` env vars), app data on its own server (`MONGO_*` env vars). Useful when multiple tenant apps share one auth cluster.

```ts
await createServer({
  // ...
  db: { mongo: "separate" },
});
```

### Manual connections

Set `mongo: false` and/or `redis: false` to skip auto-connect and manage connections yourself:

```ts
import { connectAuthMongo, connectAppMongo, connectRedis, createServer } from "@lastshotlabs/bunshot";

await connectAuthMongo();
await connectAppMongo();
await connectRedis();

await createServer({
  // ...
  db: { mongo: false, redis: false },
});
```

`AuthUser` and all built-in auth routes always use `authConnection`. Your app models use `appConnection` (see Adding Models below).

---

## Adding Models

Import `appConnection` and register models on it. This ensures your models use the correct connection whether you're on a single DB or a separate tenant DB.

`appConnection` is a lazy proxy — calling `.model()` at the top level works fine even before `connectMongo()` has been called. Mongoose buffers any queries until the connection is established.

```ts
// src/models/Product.ts
import { appConnection } from "@lastshotlabs/bunshot";
import { Schema } from "mongoose";
import type { HydratedDocument } from "mongoose";

interface IProduct {
  name: string;
  price: number;
}

export type ProductDocument = HydratedDocument<IProduct>;

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { timestamps: true });

export const Product = appConnection.model<IProduct>("Product", ProductSchema);
```

> **Note:** Import types (`HydratedDocument`, `Schema`, etc.) directly from `"mongoose"` — the `appConnection` and `mongoose` exports from bunshot are runtime proxies and cannot be used as TypeScript namespaces.

---

## Jobs (BullMQ)

> **Redis requirement**: BullMQ requires `maxmemory-policy noeviction`. Set it in `redis.conf` or via Docker:
> ```yaml
> command: redis-server --maxmemory-policy noeviction
> ```

Queues and workers share the existing Redis connection automatically.

### Define a queue

```ts
// src/queues/email.ts
import { createQueue } from "@lastshotlabs/bunshot";

export type EmailJob = { to: string; subject: string; body: string };

export const emailQueue = createQueue<EmailJob>("email");
```

### Add jobs

```ts
import { emailQueue } from "../queues/email";

await emailQueue.add("send-welcome", { to: "user@example.com", subject: "Welcome", body: "..." });

// with options
await emailQueue.add("send-reset", payload, { delay: 5000, attempts: 3 });
```

### Define a worker

```ts
// src/workers/email.ts
import { createWorker } from "@lastshotlabs/bunshot";
import type { EmailJob } from "../queues/email";

export const emailWorker = createWorker<EmailJob>("email", async (job) => {
  const { to, subject, body } = job.data;
  // send email...
});
```

Workers in `workersDir` are auto-discovered and registered after the server starts — no manual imports needed. Subdirectories are supported.

### Broadcasting WebSocket messages from a worker

Use `publish` to broadcast to all connected clients from inside a worker (or anywhere):

```ts
// src/workers/notify.ts
import { createWorker, publish } from "@lastshotlabs/bunshot";
import type { NotifyJob } from "../queues/notify";

export const notifyWorker = createWorker<NotifyJob>("notify", async (job) => {
  const { text, from } = job.data;
  publish("broadcast", { text, from, timestamp: new Date().toISOString() });
});
```

`publish` is available after `createServer` resolves. Workers are loaded after that point, so it's always safe to use inside a worker.

---

## WebSocket

The `/ws` endpoint is mounted automatically by `createServer`. No extra setup needed.

### Default behaviour

| What | Default |
|---|---|
| Upgrade / auth | Reads `auth-token` cookie → verifies JWT → checks session → sets `ws.data.userId` |
| `open` | Logs connection, sends `{ event: "connected", id }` |
| `message` | Handles room actions (see below), echoes everything else |
| `close` | Clears `ws.data.rooms`, logs disconnection |

### Socket data (`SocketData`)

`SocketData` is generic — pass a type parameter to add your own fields:

```ts
type SocketData<T extends object = object> = {
  id: string;            // unique connection ID (UUID)
  userId: string | null; // null if unauthenticated
  rooms: Set<string>;    // rooms this socket is subscribed to
} & T;
```

**Extending with custom fields:**

```ts
import { createServer, type SocketData } from "@lastshotlabs/bunshot";

type MyData = { tenantId: string; role: "admin" | "user" };

await createServer<MyData>({
  ws: {
    upgradeHandler: async (req, server) => {
      const tenantId = req.headers.get("x-tenant-id") ?? "default";
      const upgraded = server.upgrade(req, {
        data: { id: crypto.randomUUID(), userId: null, rooms: new Set(), tenantId, role: "user" },
      });
      return upgraded ? undefined : Response.json({ error: "Upgrade failed" }, { status: 400 });
    },
    handler: {
      open(ws) {
        // ws.data.tenantId and ws.data.role are fully typed
        console.log(ws.data.tenantId, ws.data.role);
      },
    },
    onRoomSubscribe(ws, room) {
      return ws.data.role === "admin" || !room.startsWith("admin:");
    },
  },
});
```

With no type parameter, `SocketData` defaults to `{ id, userId, rooms }` — the base shape used by the default upgrade handler.

### Overriding the message handler

Pass `ws.handler` to `createServer` to replace the default echo. Room action handling always runs first — your handler only receives non-room messages:

```ts
await createServer({
  ws: {
    handler: {
      open(ws) {
        ws.send(JSON.stringify({ event: "connected", id: ws.data.id }));
      },
      message(ws, message) {
        // room subscribe/unsubscribe already handled — put your logic here
        const parsed = JSON.parse(message as string);
        if (parsed.action === "ping") ws.send(JSON.stringify({ event: "pong" }));
      },
      close(ws, code, reason) {
        // ws.data.rooms already cleared
      },
    },
  },
});
```

You can supply any subset of `open`, `message`, `close`, `drain` — unset handlers fall back to the defaults.

### Overriding the upgrade / auth handler

Replace the default cookie-JWT handshake entirely via `ws.upgradeHandler`. You must call `server.upgrade()` yourself and include `rooms: new Set()` in data:

```ts
await createServer({
  ws: {
    upgradeHandler: async (req, server) => {
      const token = req.headers.get("x-my-token");
      const userId = token ? await verifyMyToken(token) : null;
      const upgraded = server.upgrade(req, {
        data: { id: crypto.randomUUID(), userId, rooms: new Set() },
      });
      return upgraded ? undefined : Response.json({ error: "Upgrade failed" }, { status: 400 });
    },
  },
});
```

---

## WebSocket Rooms / Channels

Rooms are built on Bun's native pub/sub. `createServer` always intercepts room action messages first via `handleRoomActions` — so room subscribe/unsubscribe works regardless of whether you provide a custom `websocket.message`.

### WS utilities

| Export | Description |
|---|---|
| `publish(room, data)` | Broadcast `data` to all sockets subscribed to `room` |
| `subscribe(ws, room)` | Subscribe a socket to a room and track it in `ws.data.rooms` |
| `unsubscribe(ws, room)` | Unsubscribe a socket from a room |
| `getSubscriptions(ws)` | Returns `string[]` of rooms the socket is currently in |
| `getRooms()` | Returns `string[]` of all rooms with at least one active subscriber |
| `getRoomSubscribers(room)` | Returns `string[]` of socket IDs currently subscribed to `room` |
| `handleRoomActions(ws, message, onSubscribe?)` | Parses and dispatches subscribe/unsubscribe actions. Returns `true` if the message was a room action (consumed), `false` otherwise. Pass an optional async guard as the third argument. |

### Client → server: join or leave a room

Send a JSON message with `action: "subscribe"` or `action: "unsubscribe"`:

```ts
ws.send(JSON.stringify({ action: "subscribe",   room: "chat:general" }));
ws.send(JSON.stringify({ action: "unsubscribe", room: "chat:general" }));
```

Server responses:

| Event | Meaning |
|---|---|
| `{ event: "subscribed", room }` | Successfully joined |
| `{ event: "unsubscribed", room }` | Successfully left |
| `{ event: "subscribe_denied", room }` | Blocked by `onRoomSubscribe` guard |

Any non-room message is passed through to your `websocket.message` handler unchanged.

### Server → room: broadcast

```ts
import { publish } from "@lastshotlabs/bunshot";

publish("chat:general", { text: "Hello room!", from: "system" });
```

All sockets subscribed to `"chat:general"` receive the message. Works from anywhere — routes, workers, anywhere after `createServer` resolves.

### Server-side: manage subscriptions in code

Use `subscribe` / `unsubscribe` anywhere you have a `ws` reference (e.g. in `ws.handler.open` to auto-join personal rooms):

```ts
import { subscribe, unsubscribe, getSubscriptions } from "@lastshotlabs/bunshot";

await createServer({
  ws: {
    handler: {
      open(ws) {
        // auto-subscribe authenticated users to their personal room
        if (ws.data.userId) subscribe(ws, `user:${ws.data.userId}`);
      },
      message(ws, message) {
        // handleRoomActions already ran — only non-room messages reach here
        const rooms = getSubscriptions(ws); // current room list
      },
      close(ws) {
        // ws.data.rooms is cleared automatically — no cleanup needed
      },
    },
  },
});
```

### Room permission guard

Pass `ws.onRoomSubscribe` to `createServer` to gate which rooms a socket can join. Return `true` to allow, `false` to deny. Uses `ws.data.userId` for auth-based checks. Can be async.

```ts
await createServer({
  ws: {
    onRoomSubscribe(ws, room) {
      if (!ws.data.userId) return false;                              // must be logged in
      if (room.startsWith("admin:")) return isAdmin(ws.data.userId); // role check
      if (room.startsWith("user:")) return room === `user:${ws.data.userId}`; // ownership
      return true;
    },
  },
});

// async guard — query DB or cache
await createServer({
  ws: {
    onRoomSubscribe: async (ws, room) => {
      const ok = await db.roomMembers.findOne({ room, userId: ws.data.userId });
      return !!ok;
    },
  },
});
```

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

Cache GET responses and bust them from mutation endpoints. Supports Redis, MongoDB, SQLite, and memory stores. The cache key is automatically namespaced by `appName` (`cache:{appName}:{key}`), so shared instances across tenant apps never collide.

### Basic usage

```ts
import { cacheResponse, bustCache } from "@lastshotlabs/bunshot";

// GET — cache the response for 60 seconds in Redis (default)
router.use("/products", cacheResponse({ ttl: 60, key: "products" }));

// indefinite — cached until busted
router.use("/config", cacheResponse({ key: "config" }));

router.get("/products", async (c) => {
  const items = await Product.find();
  return c.json({ items });
});

// POST — write data, then bust the shared key (hits all connected stores)
router.post("/products", userAuth, async (c) => {
  const body = await c.req.json();
  await Product.create(body);
  await bustCache("products");
  return c.json({ ok: true }, 201);
});
```

The `key` string is the shared contract — `cacheResponse` stores under it, `bustCache` deletes it. Responses include an `x-cache: HIT` or `x-cache: MISS` header.

### Choosing a cache store

Pass `store` to select where the response is cached. Defaults to `"redis"`.

```ts
// Redis (default)
cacheResponse({ key: "products", ttl: 60 })

// MongoDB — uses appConnection, stores in the `cache_entries` collection
// TTL is handled natively via a MongoDB expiry index on the expiresAt field
cacheResponse({ key: "products", ttl: 300, store: "mongo" })

// SQLite — uses the same .db file as sqliteAuthAdapter; requires setSqliteDb or sqliteDb config
cacheResponse({ key: "products", ttl: 60, store: "sqlite" })

// Memory — in-process Map, ephemeral (cleared on restart), no external dependencies
cacheResponse({ key: "products", ttl: 60, store: "memory" })
```

Use SQLite when running without Redis or MongoDB. Use MongoDB when you want cache entries co-located with your app data. Use Redis for lower-latency hot caches. Use Memory for tests or single-process apps where persistence isn't needed.

**Connection requirements:** The chosen store must be initialized when the route is first hit. If `store: "sqlite"` is used but `setSqliteDb` has not been called (e.g. `sqliteDb` was not passed to `createServer`), the middleware throws a clear error on the first request. The same applies to the other stores.

### Busting cached entries

`bustCache` always attempts all four stores (Redis, Mongo, SQLite, Memory), skipping any that aren't connected. This means it works correctly regardless of which `store` option your routes use, and is safe to call in apps that don't use all stores:

```ts
await bustCache("products"); // hits whichever stores are connected
```

### Per-user caching

The `key` function receives the full Hono context, so you can scope cache entries to the authenticated user:

```ts
router.use("/feed", userAuth, cacheResponse({
  ttl: 60,
  key: (c) => `feed:${c.get("authUserId")}`,
}));
```

`authUserId` is populated by `identify`, which always runs before route middleware, so it's safe to use here.

### Per-resource caching

For routes with dynamic segments, use the function form of `key`. Produce the same string in `bustCache`:

```ts
// GET /products/:id
router.use("/products/:id", cacheResponse({
  ttl: 60,
  key: (c) => `product:${c.req.param("id")}`,
}));

router.get("/products/:id", async (c) => {
  const item = await Product.findById(c.req.param("id"));
  return c.json(item);
});

// PUT /products/:id
router.put("/products/:id", userAuth, async (c) => {
  const id = c.req.param("id");
  await Product.findByIdAndUpdate(id, await c.req.json());
  await bustCache(`product:${id}`);
  return c.json({ ok: true });
});
```

Only 2xx responses are cached. Non-2xx responses pass through uncached. Omit `ttl` to cache indefinitely — the entry will persist until explicitly busted with `bustCache`.

### Busting by pattern

When cache keys include variable parts (e.g. query params), use `bustCachePattern` to invalidate an entire logical group at once. It runs against all four stores — Redis (via SCAN), Mongo (via regex), SQLite (via LIKE), and Memory (via regex) — in parallel:

```ts
import { bustCachePattern } from "@lastshotlabs/bunshot";

// key includes query params: `balance:${userId}:${from}:${to}:${groupBy}`
// bust all balance entries for this user regardless of params
await bustCachePattern(`balance:${userId}:*`);
```

The `*` wildcard is translated to a Redis glob, a Mongo/Memory regex, and a SQLite LIKE pattern automatically. Like `bustCache`, it silently skips any store that isn't connected, so it's safe to call in apps that only use one store.

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

```ts
await createServer({
  // Required
  routesDir: import.meta.dir + "/routes",

  // App metadata (shown in root endpoint + OpenAPI docs)
  app: {
    name: "My App",      // default: "Bun Core API"
    version: "1.0.0",   // default: "1.0.0"
  },

  // Auth, roles, and OAuth
  auth: {
    enabled: true,                          // default: true — set false to disable /auth/* routes
    adapter: pgAuthAdapter,                 // custom adapter — overrides db.auth (use for Postgres etc.)
    roles: ["admin", "editor", "user"],     // valid roles — required to use requireRole
    defaultRole: "user",                    // assigned to every new user on /auth/register
    primaryField: "email",                  // default: "email" — use "username" or "phone" to change the login identifier
    emailVerification: {                    // optional — only active when primaryField is "email"
      required: true,                       // default: false (soft gate) — set true to block login until verified
      tokenExpiry: 60 * 60,                 // default: 86400 (24 hours) — token TTL in seconds
      onSend: async (email, token) => {     // called after registration and resend — use any email provider
        await resend.emails.send({ to: email, subject: "Verify your email", text: `Token: ${token}` });
      },
    },
    passwordReset: {                        // optional — only active when primaryField is "email"
      tokenExpiry: 60 * 60,                 // default: 3600 (1 hour) — token TTL in seconds
      onSend: async (email, token) => {     // called by POST /auth/forgot-password — use any email provider
        await resend.emails.send({ to: email, subject: "Reset your password", text: `Token: ${token}` });
      },
    },
    rateLimit: {                            // optional — built-in auth endpoint rate limiting
      login:              { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 failures / 15 min
      register:           { windowMs: 60 * 60 * 1000, max: 5  }, // default: 5 attempts / hour (per IP)
      verifyEmail:        { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 attempts / 15 min (per IP)
      resendVerification: { windowMs: 60 * 60 * 1000, max: 3  }, // default: 3 attempts / hour (per user)
      forgotPassword:     { windowMs: 15 * 60 * 1000, max: 5  }, // default: 5 attempts / 15 min (per IP)
      resetPassword:      { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 attempts / 15 min (per IP)
      store: "redis",                       // default: "redis" when Redis is enabled, else "memory"
    },
    sessionPolicy: {                        // optional — session concurrency and metadata
      maxSessions: 6,                       // default: 6 — max simultaneous sessions per user; oldest evicted when exceeded
      persistSessionMetadata: true,         // default: true — keep IP/UA/timestamp row after session expires (for device detection)
      includeInactiveSessions: false,       // default: false — include expired/deleted sessions in GET /auth/sessions
      trackLastActive: false,               // default: false — update lastActiveAt on every auth'd request (adds one DB write)
    },
    oauth: {
      providers: { google: { ... }, apple: { ... } }, // omit a provider to disable it
      postRedirect: "/dashboard",           // default: "/"
    },
  },

  // Security
  security: {
    cors: ["https://myapp.com"],            // default: "*"
    rateLimit: { windowMs: 60_000, max: 100 }, // default: 100 req/min
    bearerAuth: true,                       // default: true — set false to disable, or { bypass: ["/my-public-route"] }
    botProtection: {
      fingerprintRateLimit: true,           // rate-limit by HTTP fingerprint (IP-rotation resistant). default: false
      blockList: ["198.51.100.0/24"],       // IPv4 CIDRs or exact IPs to block with 403. default: []
    },
  },

  // Extra middleware injected after identify, before route matching
  middleware: [],

  // Connections & store routing (all optional — shown with defaults)
  db: {
    mongo: "single",        // "single" | "separate" | false
    redis: true,            // false to skip auto-connect
    sqlite: undefined,      // absolute path to .db file — required when any store is "sqlite"
    auth: "mongo",          // "mongo" | "sqlite" | "memory" — which built-in auth adapter to use
    sessions: "redis",      // "redis" | "mongo" | "sqlite" | "memory"
    oauthState: "redis",    // default: follows sessions
    cache: "redis",         // global default for cacheResponse (overridable per-route)
  },

  // Server
  port: 3000,                                    // default: process.env.PORT ?? 3000
  workersDir: import.meta.dir + "/workers",      // auto-imports all .ts files after server starts
  enableWorkers: true,                           // default: true — set false to disable auto-loading

  // WebSocket (see WebSocket section for full examples)
  ws: {
    handler: { ... },                                  // override open/message/close/drain handlers
    upgradeHandler: async (req, server) => { ... },    // replace default cookie-JWT upgrade logic
    onRoomSubscribe(ws, room) { return true; },        // gate room subscriptions; can be async
  },
});
```

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

Sessions are backed by Redis by default. Each login creates an independent session keyed by a UUID (`session:{appName}:{sessionId}`), so multiple devices / tabs can be logged in simultaneously. Set `db.sessions: "mongo"` to store them in MongoDB instead — useful when running without Redis. See [Running without Redis](#running-without-redis).

### Browser clients
1. `POST /auth/login` → JWT set as HttpOnly cookie automatically
2. All subsequent requests send the cookie — no extra code needed

### API / non-browser clients
1. `POST /auth/login` → read `token` from response body
2. Send `x-user-token: <token>` header on every request

### Session management

Each login creates an independent session so multiple devices stay logged in simultaneously. The framework enforces a configurable cap (default: 6) — the oldest session is evicted when the limit is exceeded.

```
GET    /auth/sessions             → [{ sessionId, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent, isActive }]
DELETE /auth/sessions/:sessionId  → revoke a specific session (other sessions unaffected)
POST   /auth/logout               → revoke only the current session
```

Session metadata (IP address, user-agent, timestamps) is persisted even after a session expires when `sessionPolicy.persistSessionMetadata: true` (default). This enables tenant apps to detect logins from novel devices or locations and prompt for MFA or send a security alert.

Set `sessionPolicy.includeInactiveSessions: true` to surface expired/deleted sessions in `GET /auth/sessions` with `isActive: false` — useful for a full device-history UI similar to Google or Meta's account security page.

### Protecting routes

```ts
import { userAuth, requireRole, requireVerifiedEmail } from "@lastshotlabs/bunshot";

router.use("/my-route", userAuth);                              // returns 401 if not logged in
router.use("/admin", userAuth, requireRole("admin"));           // returns 403 if user lacks role
router.use("/content", userAuth, requireRole("admin", "editor")); // allow either role
router.use("/dashboard", userAuth, requireVerifiedEmail);       // returns 403 if email not verified
```

### Custom auth adapter

By default, `/auth/*` routes store users in MongoDB via `mongoAuthAdapter`. Pass `auth: { adapter: myAdapter }` to `createServer` to use any other store — Postgres, SQLite, an external service, etc. Alternatively, use `db.auth` to select a built-in adapter (`"mongo"` | `"sqlite"` | `"memory"`).

The schema should include a `roles` column if you plan to use role-based access:

```sql
-- roles stored as a text array in Postgres
ALTER TABLE users ADD COLUMN roles text[] NOT NULL DEFAULT '{}';
```

```ts
import type { AuthAdapter } from "@lastshotlabs/bunshot";
import { HttpError } from "@lastshotlabs/bunshot";
import { db } from "./db";
import { users } from "./schema";
import { eq, sql } from "drizzle-orm";

const pgAuthAdapter: AuthAdapter = {
  async findByEmail(email) {
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    return user ? { id: user.id, passwordHash: user.passwordHash } : null;
  },
  async create(email, passwordHash) {
    try {
      const [user] = await db.insert(users).values({ email, passwordHash }).returning({ id: users.id });
      return { id: user.id };
    } catch (err: any) {
      if (/* unique constraint */ err.code === "23505") throw new HttpError(409, "Email already registered");
      throw err;
    }
  },
  // --- Role methods (optional — only needed if using roles / requireRole) ---
  async getRoles(userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    return user?.roles ?? [];
  },
  async setRoles(userId, roles) { // required if using defaultRole
    await db.update(users).set({ roles }).where(eq(users.id, userId));
  },
  async addRole(userId, role) {
    await db.update(users)
      .set({ roles: sql`array_append(roles, ${role})` })
      .where(eq(users.id, userId));
  },
  async removeRole(userId, role) {
    await db.update(users)
      .set({ roles: sql`array_remove(roles, ${role})` })
      .where(eq(users.id, userId));
  },
};

await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  auth: {
    roles: ["admin", "editor", "user"],
    defaultRole: "user",
    adapter: pgAuthAdapter,
  },
});
```

The adapter is responsible for:
- `findByEmail` — return `{ id, passwordHash }` or `null` if not found
- `create` — insert the user and return `{ id }`, throw `HttpError(409, ...)` on duplicate email
- `setPassword` _(optional)_ — update the stored password hash for `userId`; implement to enable `POST /auth/set-password`
- `findOrCreateByProvider` _(optional)_ — required for OAuth social login
- `linkProvider` _(optional)_ — add a provider identity to an existing user; implement to enable `GET /auth/{provider}/link`
- `unlinkProvider` _(optional)_ — remove all identities for a provider from a user; implement to enable `DELETE /auth/{provider}/link`
- `getRoles` _(optional)_ — return the roles assigned to `userId`; implement to enable `requireRole` middleware
- `setRoles` _(optional)_ — replace all roles; required if using `defaultRole`
- `addRole` _(optional)_ — add a single role; implement to use `addUserRole`
- `removeRole` _(optional)_ — remove a single role; implement to use `removeUserRole`
- `getUser` _(optional)_ — return `{ email?, providerIds?, emailVerified? }` for `userId`; implement to populate `GET /auth/me` (including `googleLinked` and `emailVerified`)
- `findByIdentifier` _(optional)_ — look up a user by the configured `primaryField` value; implement for non-email primary fields. Falls back to `findByEmail` if absent.
- `setEmailVerified` _(optional)_ — mark a user as email-verified; implement to support `POST /auth/verify-email`
- `getEmailVerified` _(optional)_ — return whether a user is email-verified; implement to support the `emailVerification.required` gate and `POST /auth/resend-verification`

Everything else (password hashing, JWT signing, Redis sessions) is handled by the package.

### Auth Rate Limiting

All built-in auth endpoints are rate-limited out of the box with sensible defaults. No configuration needed — just be aware of the behavior:

| Endpoint | Key | Counts | Default limit |
|---|---|---|---|
| `POST /auth/login` | identifier (email/username/phone) | **Failures only** — reset on success | 10 failures / 15 min |
| `POST /auth/register` | IP address | Every attempt | 5 / hour |
| `POST /auth/verify-email` | IP address | Every attempt | 10 / 15 min |
| `POST /auth/resend-verification` | User ID (authenticated) | Every attempt | 3 / hour |
| `POST /auth/forgot-password` | IP address | Every attempt | 5 / 15 min |
| `POST /auth/reset-password` | IP address | Every attempt | 10 / 15 min |

Login is keyed by the **identifier being targeted** — an attacker rotating IPs to brute-force `alice@example.com` is blocked regardless of source IP. A successful login resets the counter so legitimate users aren't locked out.

#### Tuning limits

```ts
await createServer({
  auth: {
    rateLimit: {
      login:              { windowMs: 10 * 60 * 1000, max: 5 }, // stricter: 5 failures / 10 min
      register:           { windowMs: 60 * 60 * 1000, max: 3 },
      verifyEmail:        { windowMs: 15 * 60 * 1000, max: 10 }, // leave at default
      resendVerification: { windowMs: 60 * 60 * 1000, max: 2 },
      store: "redis",   // default when Redis is enabled — shared across all server instances
    },
  },
});
```

#### Manually clearing a limit (admin unlock)

If a legitimate user gets locked out, call `bustAuthLimit` with the same key format the limiter uses:

```ts
import { bustAuthLimit } from "@lastshotlabs/bunshot";

// Admin route: POST /admin/unblock-login
router.post("/admin/unblock-login", userAuth, requireRole("admin"), async (c) => {
  const { identifier } = await c.req.json();
  await bustAuthLimit(`login:${identifier}`);
  return c.json({ message: "Login limit cleared" });
});
```

Key formats: `login:{identifier}`, `register:{ip}`, `verify:{ip}`, `resend:{userId}`.

#### Using the rate limiter in your own routes

`trackAttempt` and `isLimited` are exported so you can apply the same Redis-backed rate limiting to any route in your app. They use the same store configured via `auth.rateLimit.store`.

```ts
import { trackAttempt, isLimited, bustAuthLimit } from "@lastshotlabs/bunshot";

// trackAttempt — increments the counter and returns true if now over the limit
// isLimited    — checks without incrementing (read-only)
// bustAuthLimit — resets a key (e.g. on success or admin unlock)

router.post("/api/submit", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  const key = `submit:${ip}`;

  if (await trackAttempt(key, { windowMs: 60 * 1000, max: 5 })) {
    return c.json({ error: "Too many requests" }, 429);
  }

  // ... handle request
  return c.json({ ok: true });
});
```

Use `isLimited` when you want to check the current state without counting the request itself — for example, to gate an expensive pre-check before the attempt is registered:

```ts
if (await isLimited(key, opts)) {
  return c.json({ error: "Too many requests" }, 429);
}
```

Keys are automatically namespaced to the app (e.g. `rl:MyApp:submit:1.2.3.4`) when the Redis store is active, so they won't collide on a shared Redis instance.

#### Store

The rate limit store defaults to `"redis"` when Redis is enabled (recommended for multi-instance deployments — limits are shared across all servers). Falls back to `"memory"` automatically when Redis is disabled. In-memory limits don't persist across restarts.

---

### Bot Protection

The built-in IP rate limiter is ineffective against bots that rotate IPs. The `botProtection` config adds two IP-rotation-resistant layers that run before the IP rate limit check.

#### Fingerprint rate limiting

When `fingerprintRateLimit: true`, every request is also rate-limited by an HTTP fingerprint — a 12-char hash derived from `User-Agent`, `Accept-*`, `Connection`, and the presence/absence of browser-only headers (`sec-fetch-*`, `sec-ch-ua-*`, `origin`, `referer`, etc.).

Bots that rotate IPs but use the same HTTP client (e.g. Python `requests`, `curl`, a headless browser) produce the same fingerprint and share a rate-limit bucket regardless of their source IP. Real browser sessions produce a different fingerprint from CLI tools, so they don't interfere with each other.

```ts
await createServer({
  security: {
    rateLimit: { windowMs: 60_000, max: 100 }, // applies to both IP and fingerprint buckets
    botProtection: {
      fingerprintRateLimit: true,
    },
  },
});
```

The fingerprint bucket uses the same window and max as `security.rateLimit`, and is stored in the same backend as `auth.rateLimit.store` (Redis by default, shared across all instances).

#### IP / CIDR blocklist

Block known datacenter ranges, proxy providers, or individual IPs outright. Matched requests receive a 403 before any other processing — no session lookup, no rate-limit increment.

```ts
await createServer({
  security: {
    botProtection: {
      blockList: [
        "198.51.100.0/24",   // IPv4 CIDR
        "203.0.113.42",      // exact IPv4
        "2001:db8::1",       // exact IPv6
      ],
    },
  },
});
```

Both options can be combined. The middleware order is: blocklist → IP rate limit → fingerprint rate limit.

#### Apply `botProtection` to individual routes

`botProtection` is also exported for per-route use:

```ts
import { botProtection } from "@lastshotlabs/bunshot";

router.use("/api/submit", botProtection({ blockList: ["198.51.100.0/24"] }));
```

---

### Setting a password after social login

If a user signed up via Google or Apple and later wants to add a password, send an authenticated request to `POST /auth/set-password`:

```ts
// Client (logged-in user)
await fetch("/auth/set-password", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-user-token": token },
  body: JSON.stringify({ password: "mynewpassword" }),
});
```

The built-in route hashes the password and calls `adapter.setPassword(userId, hash)`. If your adapter does not implement `setPassword`, the route returns `501 Not Implemented`.

To support it with a custom adapter:

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async setPassword(userId, passwordHash) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  },
};
```

---

## Roles

### Setup

Declare the valid roles for your app in `createServer` / `createApp`:

```ts
await createServer({
  auth: {
    roles: ["admin", "editor", "user"],
    defaultRole: "user",  // automatically assigned on /auth/register
  },
  // ...
});
```

`roles` makes the list available anywhere via `getAppRoles()`. `defaultRole` is assigned to every new user that registers via `POST /auth/register` — no extra code needed.

### Assigning roles to a user

Three helpers are available depending on what you need:

| Helper | Behaviour |
|---|---|
| `setUserRoles(userId, roles)` | Replace all roles — pass the full desired set |
| `addUserRole(userId, role)` | Add a single role, leaving others unchanged |
| `removeUserRole(userId, role)` | Remove a single role, leaving others unchanged |

```ts
import { setUserRoles, addUserRole, removeUserRole, userAuth, requireRole } from "@lastshotlabs/bunshot";

// promote a user to admin
router.post("/admin/users/:id/promote", userAuth, requireRole("admin"), async (c) => {
  await addUserRole(c.req.param("id"), "admin");
  return c.json({ ok: true });
});

// revoke a role
router.post("/admin/users/:id/demote", userAuth, requireRole("admin"), async (c) => {
  await removeUserRole(c.req.param("id"), "admin");
  return c.json({ ok: true });
});

// replace all roles at once
router.put("/admin/users/:id/roles", userAuth, requireRole("admin"), async (c) => {
  const { roles } = await c.req.json();
  await setUserRoles(c.req.param("id"), roles);
  return c.json({ ok: true });
});
```

### Protecting routes by role

`requireRole` is a middleware factory. It lazy-fetches roles on the first role-checked request and caches them on the Hono context, so multiple `requireRole` calls in a middleware chain only hit the DB once.

```ts
import { userAuth, requireRole } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth, requireRole("admin"));
router.use("/content", userAuth, requireRole("admin", "editor")); // allow either role
```

| Scenario | Response |
|---|---|
| No session | `401 Unauthorized` |
| Authenticated, wrong role | `403 Forbidden` |
| Authenticated, correct role | passes through |

### Custom adapter with roles

If you're using a custom `authAdapter`, implement the role methods to back role operations with your own store:

| Method | Required for |
|---|---|
| `getRoles(userId)` | `requireRole` middleware |
| `setRoles(userId, roles)` | `defaultRole` assignment on registration, full replace |
| `addRole(userId, role)` | Granular role addition |
| `removeRole(userId, role)` | Granular role removal |

All are optional — only implement what your app uses. `setRoles` is **required** if you configure `defaultRole` (the app will throw at startup if this combination is misconfigured). The exported helpers `setUserRoles`, `addUserRole`, and `removeUserRole` route through your adapter, so they work regardless of which store you use.

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async getRoles(userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    return user?.roles ?? [];
  },
  async setRoles(userId, roles) {
    await db.update(users).set({ roles }).where(eq(users.id, userId));
  },
  async addRole(userId, role) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user && !user.roles.includes(role)) {
      await db.update(users).set({ roles: [...user.roles, role] }).where(eq(users.id, userId));
    }
  },
  async removeRole(userId, role) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user) {
      await db.update(users).set({ roles: user.roles.filter((r: string) => r !== role) }).where(eq(users.id, userId));
    }
  },
};
```

---

## Social Login (OAuth)

Pass `auth.oauth.providers` to `createServer` to enable Google and/or Apple sign-in. Routes are mounted automatically for each configured provider.

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  auth: {
    oauth: {
      postRedirect: "/lobby",  // where to redirect after login (default: "/")
      providers: {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          redirectUri: "https://myapp.com/auth/google/callback",
        },
        apple: {
          clientId: process.env.APPLE_CLIENT_ID!,       // Services ID, e.g. "com.myapp.auth"
          teamId: process.env.APPLE_TEAM_ID!,
          keyId: process.env.APPLE_KEY_ID!,
          privateKey: process.env.APPLE_PRIVATE_KEY!,   // PEM string
          redirectUri: "https://myapp.com/auth/apple/callback",
        },
      },
    },
  },
});
```

### Routes mounted automatically

| Provider | Initiate login | Callback | Link to existing account | Unlink |
|---|---|---|---|---|
| Google | `GET /auth/google` | `GET /auth/google/callback` | `GET /auth/google/link` | `DELETE /auth/google/link` |
| Apple | `GET /auth/apple` | `POST /auth/apple/callback` | `GET /auth/apple/link` | — |

> Apple sends its callback as a **POST** with form data. Your server must be publicly reachable and the redirect URI must be registered in the Apple developer console.

### Flow

1. Client navigates to `GET /auth/google` (or `/auth/apple`)
2. Package redirects to the provider's OAuth page
3. Provider redirects (or POSTs) back to the callback URL
4. Package exchanges the code, fetches the user profile, and calls `authAdapter.findOrCreateByProvider`
5. A session is created, the `auth-token` cookie is set, and the user is redirected to `auth.oauth.postRedirect`

### User storage

The default `mongoAuthAdapter` stores social users in `AuthUser` with a `providerIds` field (e.g. `["google:1234567890"]`). If no existing provider key is found, a new account is created — emails are never auto-linked. To connect a social identity to an existing credential account the user must explicitly use the link flow below.

**Email conflict handling:** If a user attempts to sign in via Google (or Apple) and the email returned by the provider already belongs to a credential-based account, `findOrCreateByProvider` throws `HttpError(409, ...)`. The OAuth callback catches this and redirects to `auth.oauth.postRedirect?error=<message>` so the client can display a helpful prompt (e.g. "An account with this email already exists — sign in with your password, then link Google from your account settings.").

To support social login with a custom adapter, implement `findOrCreateByProvider`:

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async findOrCreateByProvider(provider, providerId, profile) {
    // find or upsert user by provider + providerId
    // return { id: string }
  },
};
```

### Linking a provider to an existing account

A logged-in user can link their account to a Google or Apple identity by navigating to the link route. This is the only way to associate a social login with an existing credential account — email matching is intentionally not done automatically.

```
GET /auth/google/link   (requires active session via cookie)
GET /auth/apple/link    (requires active session via cookie)
```

The link flow:
1. User is already logged in (session cookie set)
2. Client navigates to `/auth/google/link`
3. User completes Google OAuth as normal
4. On callback, instead of creating a new session, the Google identity is added to their existing account
5. User is redirected to `auth.oauth.postRedirect?linked=google`

To support linking with a custom adapter, implement `linkProvider`:

```ts
const myAdapter: AuthAdapter = {
  // ...
  async linkProvider(userId, provider, providerId) {
    const key = `${provider}:${providerId}`;
    await db.update(users)
      .set({ providerIds: sql`array_append(provider_ids, ${key})` })
      .where(eq(users.id, userId));
  },
};
```

### Unlinking a provider

A logged-in user can remove a linked Google identity via:

```
DELETE /auth/google/link   (requires active session via cookie)
```

Returns `204 No Content` on success. All `google:*` entries are removed from the user's `providerIds`.

To support unlinking with a custom adapter, implement `unlinkProvider`:

```ts
const myAdapter: AuthAdapter = {
  // ...
  async unlinkProvider(userId, provider) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found");
    const filtered = user.providerIds.filter((id: string) => !id.startsWith(`${provider}:`));
    await db.update(users).set({ providerIds: filtered }).where(eq(users.id, userId));
  },
};
```

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
  evictOldestSession, updateSessionLastActive, setSessionStore,
  createVerificationToken, getVerificationToken, deleteVerificationToken,  // email verification tokens
  bustAuthLimit, trackAttempt, isLimited,          // auth rate limiting — use in custom routes or admin unlocks
  buildFingerprint,                                // HTTP fingerprint hash (IP-independent) — use in custom bot detection logic
  AuthUser, mongoAuthAdapter,
  sqliteAuthAdapter, setSqliteDb, startSqliteCleanup,  // SQLite backend (persisted)
  memoryAuthAdapter, clearMemoryStore,                 // in-memory backend (ephemeral)
  setUserRoles, addUserRole, removeUserRole,       // role management
  type AuthAdapter, type OAuthProfile, type OAuthProviderConfig,
  type AuthRateLimitConfig, type BotProtectionConfig, type BotProtectionOptions,
  type LimitOpts, type RateLimitOptions,

  // Middleware
  bearerAuth, identify, userAuth, rateLimit,
  botProtection,                                  // CIDR blocklist + per-route bot protection
  requireRole,                                    // role-based access control
  requireVerifiedEmail,                           // blocks unverified email addresses
  cacheResponse, bustCache, bustCachePattern, setCacheStore,  // response caching

  // Utilities
  HttpError, log, validate, createRouter, createRoute,
  getAppRoles,                                    // returns the valid roles list configured at startup

  // Constants
  COOKIE_TOKEN, HEADER_USER_TOKEN,

  // Types
  type AppEnv, type AppVariables,
  type CreateServerConfig, type CreateAppConfig,
  type DbConfig, type AppMeta, type AuthConfig, type OAuthConfig, type SecurityConfig,
  type PrimaryField, type EmailVerificationConfig,
  type SocketData, type WsConfig,
} from "@lastshotlabs/bunshot";
```
