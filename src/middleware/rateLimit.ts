import type { MiddlewareHandler } from "hono";
import { trackAttempt } from "@lib/authRateLimit";
import { buildFingerprint } from "@lib/fingerprint";
import { getClientIp } from "@lib/clientIp";
import type { AppEnv } from "@lib/context";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Also rate-limit by HTTP fingerprint in addition to IP. Default: false */
  fingerprintLimit?: boolean;
}

export const rateLimit = ({
  windowMs,
  max,
  fingerprintLimit = false,
}: RateLimitOptions): MiddlewareHandler<AppEnv> => {
  const opts = { windowMs, max };

  return async (c, next) => {
    const ip = getClientIp(c);

    // Per-tenant namespacing: each tenant gets independent rate limit buckets
    const tenantId = c.get("tenantId");
    const prefix = tenantId ? `t:${tenantId}:` : "";

    if (await trackAttempt(`${prefix}ip:${ip}`, opts)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }

    if (fingerprintLimit) {
      const fp = await buildFingerprint(c.req.raw);
      if (await trackAttempt(`${prefix}fp:${fp}`, opts)) {
        return c.json({ error: "Too Many Requests" }, 429);
      }
    }

    await next();
  };
};
