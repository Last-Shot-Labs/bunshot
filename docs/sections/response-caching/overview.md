## Response Caching

Cache GET responses with `cacheResponse({ ttl, key })` and bust them with `bustCache(key)`. Supports Redis, MongoDB, SQLite, and memory stores. Cache keys are auto-namespaced by app name and tenant (when multi-tenancy is active).

```ts
import { cacheResponse, bustCache } from "@lastshotlabs/bunshot";

router.use("/products", cacheResponse({ ttl: 60, key: "products" }));
// ...
await bustCache("products"); // hits all connected stores
```

Supports per-user caching via `key: (c) => ...`, per-resource caching, and wildcard invalidation via `bustCachePattern("products:*")`.
