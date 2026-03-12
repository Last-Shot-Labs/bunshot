import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";
import { getAuthAdapter } from "@lib/authAdapter";

/**
 * Middleware factory that enforces role-based access.
 * Requires `identify` to have run first (authUserId must be set).
 * Roles are fetched lazily on the first role-checked route and cached on the context.
 *
 * The adapter must implement `getRoles` for this to work.
 *
 * @example
 * // Allow any authenticated user with the "admin" role
 * app.get("/admin", userAuth, requireRole("admin"), handler)
 *
 * // Allow users with either "admin" or "moderator"
 * app.get("/mod", userAuth, requireRole("admin", "moderator"), handler)
 */
export const requireRole = (...roles: string[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const userId = c.get("authUserId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Lazy-fetch roles and cache on context so multiple requireRole calls in a chain only hit the adapter once
  let userRoles = c.get("roles");
  if (userRoles === null) {
    const adapter = getAuthAdapter();
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
};
