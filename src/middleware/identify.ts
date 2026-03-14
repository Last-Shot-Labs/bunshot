import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "@lib/context";
import { verifyToken } from "@lib/jwt";
import { getSession, updateSessionLastActive } from "@lib/session";
import { COOKIE_TOKEN, HEADER_USER_TOKEN } from "@lib/constants";
import { log } from "@lib/logger";
import { getTrackLastActive } from "@lib/appConfig";

export const identify: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("authUserId", null);
  c.set("roles", null);
  c.set("sessionId", null);

  // cookie for browsers, x-user-token header for non-browser clients
  const token = getCookie(c, COOKIE_TOKEN) ?? c.req.header(HEADER_USER_TOKEN) ?? null;
  log(`[identify] token=${token ? "present" : "absent"}`);

  if (token) {
    try {
      const payload = await verifyToken(token);
      const sessionId = payload.sid as string | undefined;
      if (!sessionId) {
        log("[identify] token missing sid claim — unauthenticated");
      } else {
        const stored = await getSession(sessionId);
        log(`[identify] token for authUserId=${payload.sub} verified, checking session...`);
        if (stored === token) {
          c.set("authUserId", payload.sub!);
          c.set("sessionId", sessionId);
          log(`[identify] authUserId=${payload.sub} sessionId=${sessionId}`);
          if (getTrackLastActive()) {
            updateSessionLastActive(sessionId).catch(() => {
              log(`[identify] failed to update lastActiveAt for sessionId=${sessionId}`);
            });
          }
        } else {
          log("[identify] token/session mismatch — unauthenticated");
        }
      }
    } catch {
      log("[identify] invalid token — unauthenticated");
    }
  } else {
    log("[identify] no token — unauthenticated");
  }

  await next();
};
