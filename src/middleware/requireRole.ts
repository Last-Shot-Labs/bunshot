import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";
import { getAuthAdapter } from "@lib/authAdapter";

/**
 * Middleware factory that enforces role-based access.
 * Requires `identify` to have run first (authUserId must be set).
 *
 * When tenant context exists (`tenantId` set on context), checks tenant-scoped roles.
 * Falls back to app-wide roles when no tenant context is present.
 *
 * The adapter must implement `getRoles` (and `getTenantRoles` for tenant-scoped checks).
 *
 * @example
 * // Allow any authenticated user with the "admin" role
 * app.get("/admin", userAuth, requireRole("admin"), handler)
 *
 * // Allow users with either "admin" or "moderator"
 * app.get("/mod", userAuth, requireRole("admin", "moderator"), handler)
 */
export const requireRole = Object.assign(
  (...roles: string[]): MiddlewareHandler<AppEnv> => async (c, next) => {
    const userId = c.get("authUserId");
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const adapter = getAuthAdapter();
    const tenantId = c.get("tenantId");

    // When tenant context exists and adapter supports tenant roles, check tenant-scoped roles
    if (tenantId && adapter.getTenantRoles) {
      const tenantRoles = await adapter.getTenantRoles(userId, tenantId);
      const hasRole = roles.some((role) => tenantRoles.includes(role));
      if (!hasRole) {
        return c.json({ error: "Forbidden" }, 403);
      }
      return next();
    }

    // Fall back to app-wide roles
    let userRoles = c.get("roles");
    if (userRoles === null) {
      if (!adapter.getRoles) {
        throw new Error("requireRole used but auth adapter does not implement getRoles");
      }
      userRoles = await adapter.getRoles(userId);
      c.set("roles", userRoles);
    }

    const hasRole = roles.some((role) => userRoles!.includes(role));
    if (!hasRole) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await next();
  },
  {
    /**
     * Always checks app-wide roles regardless of tenant context.
     * Use for super-admin gates that should ignore tenant scoping.
     *
     * @example
     * app.get("/super-admin", userAuth, requireRole.global("superadmin"), handler)
     */
    global: (...roles: string[]): MiddlewareHandler<AppEnv> => async (c, next) => {
      const userId = c.get("authUserId");
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      let userRoles = c.get("roles");
      if (userRoles === null) {
        const adapter = getAuthAdapter();
        if (!adapter.getRoles) {
          throw new Error("requireRole.global used but auth adapter does not implement getRoles");
        }
        userRoles = await adapter.getRoles(userId);
        c.set("roles", userRoles);
      }

      const hasRole = roles.some((role) => userRoles!.includes(role));
      if (!hasRole) {
        return c.json({ error: "Forbidden" }, 403);
      }

      await next();
    },
  }
);
