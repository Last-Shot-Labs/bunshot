import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";
import { getAuthAdapter } from "@lib/authAdapter";

const EXEMPT_PREFIXES = ["/auth/", "/health", "/docs", "/openapi.json"];

/**
 * Middleware that blocks authenticated users who have not completed MFA setup.
 *
 * When `auth.mfa.required` is `true`, this middleware is applied globally by
 * `createApp`. It can also be applied per-route for finer control:
 *
 * @example
 * import { requireMfaSetup } from "@lastshotlabs/bunshot";
 * router.use("/dashboard", userAuth, requireMfaSetup);
 *
 * Exempt paths: `/auth/*`, `/health`, `/docs`, `/openapi.json`, and the root `/`.
 * Unauthenticated requests pass through — use `userAuth` to block those.
 */
export const requireMfaSetup: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;

  // Exempt paths — auth routes (including MFA setup), health, docs, root
  if (path === "/" || EXEMPT_PREFIXES.some((p) => path.startsWith(p))) {
    return next();
  }

  // Only applies to authenticated users — unauthenticated requests pass through
  const userId = c.get("authUserId");
  if (!userId) {
    return next();
  }

  const adapter = getAuthAdapter();
  if (!adapter.isMfaEnabled) {
    return next();
  }

  const enabled = await adapter.isMfaEnabled(userId);
  if (!enabled) {
    return c.json({ error: "MFA setup required", code: "MFA_SETUP_REQUIRED" }, 403);
  }

  return next();
};
