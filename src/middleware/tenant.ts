import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";
import type { TenancyConfig, TenantConfig } from "../app";

// ---------------------------------------------------------------------------
// Simple LRU cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: TenantConfig | null;
  expiresAt: number;
}

class LruCache {
  private _map = new Map<string, CacheEntry>();
  private _maxSize: number;
  private _ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
  }

  get(key: string): TenantConfig | null | undefined {
    const entry = this._map.get(key);
    if (!entry) return undefined; // cache miss
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return undefined; // expired
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: TenantConfig | null): void {
    // Remove first if exists (for re-insertion at end)
    this._map.delete(key);
    // Evict oldest if at capacity
    if (this._map.size >= this._maxSize) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    this._map.set(key, { value, expiresAt: Date.now() + this._ttlMs });
  }

  delete(key: string): void {
    this._map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Exported cache invalidation (used by tenant provisioning helpers)
// ---------------------------------------------------------------------------

let _cache: LruCache | null = null;

export const invalidateTenantCache = (tenantId: string): void => {
  _cache?.delete(tenantId);
};

// ---------------------------------------------------------------------------
// Tenant resolution middleware
// ---------------------------------------------------------------------------

const DEFAULT_EXEMPT = ["/health", "/docs", "/openapi.json", "/auth/"];

function extractTenantId(c: Parameters<MiddlewareHandler>[0], config: TenancyConfig): string | null {
  if (config.resolution === "header") {
    const headerName = config.headerName ?? "x-tenant-id";
    return c.req.header(headerName) ?? null;
  }

  if (config.resolution === "subdomain") {
    const host = c.req.header("host") ?? "";
    // Extract first subdomain: "acme.myapp.com" → "acme"
    const parts = host.split(".");
    if (parts.length < 3) return null; // no subdomain
    return parts[0] || null;
  }

  if (config.resolution === "path") {
    const segmentIndex = config.pathSegment ?? 0;
    // Path: "/acme/api/users" → segments after split: ["", "acme", "api", "users"]
    const segments = c.req.path.split("/").filter(Boolean);
    return segments[segmentIndex] ?? null;
  }

  return null;
}

export const createTenantMiddleware = (config: TenancyConfig): MiddlewareHandler<AppEnv> => {
  const exemptPaths = [...DEFAULT_EXEMPT, ...(config.exemptPaths ?? [])];
  const rejectionStatus = config.rejectionStatus ?? 403;
  const cacheTtlMs = config.cacheTtlMs ?? 60_000;
  const cacheMaxSize = config.cacheMaxSize ?? 500;

  // Initialize LRU cache if caching is enabled and onResolve is provided
  if (config.onResolve && cacheTtlMs > 0) {
    _cache = new LruCache(cacheMaxSize, cacheTtlMs);
  }

  return async (c, next) => {
    const path = c.req.path;

    // Check exempt paths using startsWith
    for (const exempt of exemptPaths) {
      if (path === exempt || path.startsWith(exempt)) {
        c.set("tenantId", null);
        c.set("tenantConfig", null);
        return next();
      }
    }

    const tenantId = extractTenantId(c, config);
    if (!tenantId) {
      return c.json({ error: "Tenant ID required" }, 400);
    }

    // Validate via onResolve (with caching)
    if (config.onResolve) {
      let tenantConfig: TenantConfig | null | undefined;

      if (_cache) {
        tenantConfig = _cache.get(tenantId);
      }

      // undefined = cache miss, null = onResolve returned null (rejected)
      if (tenantConfig === undefined) {
        tenantConfig = await config.onResolve(tenantId);
        _cache?.set(tenantId, tenantConfig);
      }

      if (tenantConfig === null) {
        return c.json({ error: "Access denied" }, rejectionStatus);
      }

      c.set("tenantId", tenantId);
      c.set("tenantConfig", tenantConfig);
    } else {
      // No onResolve — trust the tenant ID
      c.set("tenantId", tenantId);
      c.set("tenantConfig", null);
    }

    return next();
  };
};
