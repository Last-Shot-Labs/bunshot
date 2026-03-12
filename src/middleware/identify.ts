import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "@lib/context";
import { verifyToken } from "@lib/jwt";
import { getSession } from "@lib/session";
import { COOKIE_TOKEN, HEADER_USER_TOKEN } from "@lib/constants";
import { log } from "@lib/logger";

export const identify: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("authUserId", null);
  c.set("roles", null);

  // cookie for browsers, x-user-token header for non-browser clients
  const token = getCookie(c, COOKIE_TOKEN) ?? c.req.header(HEADER_USER_TOKEN) ?? null;
  log(`[identify] token=${token ? "present" : "absent"}`);

  if (token) {
    try {
      const payload = await verifyToken(token);
      const stored = await getSession(payload.sub!);
      log(`[identify] token for authUserId=${payload.sub} verified, checking session...`);
      if (stored === token) {
        c.set("authUserId", payload.sub!);
        log(`[identify] authUserId=${payload.sub}`);
      } else {
        log("[identify] token/session mismatch — unauthenticated");
      }
    } catch {
      log("[identify] invalid token — unauthenticated");
    }
  } else {
    log("[identify] no token — unauthenticated");
  }

  await next();
};
