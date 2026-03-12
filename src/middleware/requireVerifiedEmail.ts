import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";
import { getAuthAdapter } from "@lib/authAdapter";

/**
 * Middleware that blocks access for users whose email address has not been verified.
 * Must run after `userAuth` (requires `authUserId` to be set on context).
 *
 * The adapter must implement `getEmailVerified` for this to work.
 *
 * @example
 * router.use("/dashboard", userAuth, requireVerifiedEmail);
 */
export const requireVerifiedEmail: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = c.get("authUserId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const adapter = getAuthAdapter();
  if (!adapter.getEmailVerified) {
    throw new Error("requireVerifiedEmail used but auth adapter does not implement getEmailVerified");
  }

  const verified = await adapter.getEmailVerified(userId);
  if (!verified) {
    return c.json({ error: "Email not verified" }, 403);
  }

  await next();
};
