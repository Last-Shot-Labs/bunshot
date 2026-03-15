## Multi-Tenancy

Add multi-tenancy to your app by configuring tenant resolution. Bunshot resolves the tenant on each request and attaches `tenantId` + `tenantConfig` to the Hono context.

```ts
await createServer({
  tenancy: {
    resolution: "header",               // "header" | "subdomain" | "path"
    headerName: "x-tenant-id",          // default for "header" strategy
    onResolve: async (tenantId) => {     // validate + load tenant config — return null to reject
      const tenant = await getTenant(tenantId);
      return tenant?.config ?? null;
    },
    cacheTtlMs: 60_000,                 // LRU cache TTL for onResolve (default: 60s, 0 to disable)
    cacheMaxSize: 500,                  // max cached entries (default: 500)
    exemptPaths: ["/webhooks"],          // additional paths that skip tenant resolution
    rejectionStatus: 403,               // 403 (default) or 404 when onResolve returns null
  },
});
```

### Resolution strategies

| Strategy | How it extracts tenant ID | Example |
|---|---|---|
| `"header"` | From request header (default `x-tenant-id`) | `x-tenant-id: acme` |
| `"subdomain"` | From first subdomain | `acme.myapp.com` → `"acme"` |
| `"path"` | From URL path segment (does **not** strip prefix) | `/acme/api/users` → `"acme"` |

### Default exempt paths

These paths skip tenant resolution by default: `/health`, `/docs`, `/openapi.json`, `/auth/` (auth is global — all tenants share a user pool). Add more via `exemptPaths`.

### `onResolve` is required in production

When `tenancy` is configured without an `onResolve` callback, tenant IDs from headers/subdomains/paths are trusted without validation — a cross-tenant access risk. **In production (`NODE_ENV=production`), the server will refuse to start** if `onResolve` is missing. In development, a warning is logged instead.

### Accessing tenant in routes

```ts
router.openapi(myRoute, async (c) => {
  const tenantId = c.get("tenantId");         // string | null
  const tenantConfig = c.get("tenantConfig"); // Record<string, unknown> | null
  // Filter queries by tenantId, apply tenant-specific settings, etc.
});
```

### Tenant provisioning helpers

CRUD utilities for managing tenants (stored in the auth database via MongoDB):

```ts
import { createTenant, getTenant, listTenants, deleteTenant } from "@lastshotlabs/bunshot";

await createTenant("acme", { displayName: "Acme Corp", config: { maxUsers: 100 } });
const tenant = await getTenant("acme");      // { tenantId, displayName, config, createdAt }
const all = await listTenants();             // active tenants only
await deleteTenant("acme");                  // soft-delete + invalidates resolution cache
```

### Per-tenant namespacing

When tenant context is present, rate limits and cache keys are automatically namespaced per-tenant — no code changes needed. Each tenant gets independent rate limit buckets and cache entries.

- Rate limit keys: `t:${tenantId}:ip:${ip}` (instead of `ip:${ip}`)
- Cache keys: `cache:${appName}:${tenantId}:${key}` (instead of `cache:${appName}:${key}`)
