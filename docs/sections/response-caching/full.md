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

**Header sanitization:** Security-sensitive response headers (`set-cookie`, `www-authenticate`, `authorization`, `x-csrf-token`, `proxy-authenticate`) are automatically stripped before caching to prevent session fixation or auth bypass via cached responses.

### Busting by pattern

When cache keys include variable parts (e.g. query params), use `bustCachePattern` to invalidate an entire logical group at once. It runs against all four stores — Redis (via SCAN), Mongo (via regex), SQLite (via LIKE), and Memory (via regex) — in parallel:

```ts
import { bustCachePattern } from "@lastshotlabs/bunshot";

// key includes query params: `balance:${userId}:${from}:${to}:${groupBy}`
// bust all balance entries for this user regardless of params
await bustCachePattern(`balance:${userId}:*`);
```

The `*` wildcard is translated to a Redis glob, a Mongo/Memory regex, and a SQLite LIKE pattern automatically. Like `bustCache`, it silently skips any store that isn't connected, so it's safe to call in apps that only use one store.
