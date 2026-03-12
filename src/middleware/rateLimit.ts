import type { MiddlewareHandler } from "hono";
import { trackAttempt } from "@lib/authRateLimit";
import { buildFingerprint } from "@lib/fingerprint";

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
}: RateLimitOptions): MiddlewareHandler => {
  const opts = { windowMs, max };

  return async (c, next) => {
    // Take the leftmost (client) IP from x-forwarded-for
    const raw = c.req.header("x-forwarded-for") ?? "";
    const ip = raw.split(",")[0]?.trim() || "unknown";

    if (await trackAttempt(`ip:${ip}`, opts)) {
      return c.json({ error: "Too Many Requests" }, 429);
    }

    if (fingerprintLimit) {
      const fp = await buildFingerprint(c.req.raw);
      if (await trackAttempt(`fp:${fp}`, opts)) {
        return c.json({ error: "Too Many Requests" }, 429);
      }
    }

    await next();
  };
};
