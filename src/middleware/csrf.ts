import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "@lib/context";
import { timingSafeEqual } from "@lib/crypto";
import { COOKIE_TOKEN, COOKIE_CSRF_TOKEN, HEADER_CSRF_TOKEN } from "@lib/constants";
import { createHmac, randomBytes } from "crypto";

const isProd = process.env.NODE_ENV === "production";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getJwtSecret(): string {
  const secret = isProd ? process.env.JWT_SECRET_PROD : process.env.JWT_SECRET_DEV;
  if (!secret) throw new Error("CSRF middleware requires JWT_SECRET_DEV/JWT_SECRET_PROD to be set");
  return secret;
}

function generateCsrfToken(secret: string): string {
  const token = randomBytes(32).toString("hex");
  const sig = createHmac("sha256", secret).update(token).digest("hex");
  return `${token}.${sig}`;
}

function verifyCsrfSignature(cookieValue: string, secret: string): boolean {
  const dotIdx = cookieValue.indexOf(".");
  if (dotIdx === -1) return false;
  const token = cookieValue.substring(0, dotIdx);
  const sig = cookieValue.substring(dotIdx + 1);
  const expected = createHmac("sha256", secret).update(token).digest("hex");
  return timingSafeEqual(sig, expected);
}

export interface CsrfMiddlewareOptions {
  exemptPaths?: string[];
  checkOrigin?: boolean;
  allowedOrigins?: string | string[];
}

const csrfCookieOptions = {
  httpOnly: false,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365, // 1 year — tied to browser, not session
};

/**
 * Refreshes the CSRF token cookie — call on login/register to prevent
 * session fixation-adjacent attacks.
 */
export function refreshCsrfToken(c: Parameters<typeof setCookie>[0]): void {
  const secret = getJwtSecret();
  const token = generateCsrfToken(secret);
  setCookie(c, COOKIE_CSRF_TOKEN, token, csrfCookieOptions);
}

/**
 * Clears the CSRF token cookie — call on logout.
 */
export function clearCsrfToken(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, COOKIE_CSRF_TOKEN, { path: "/" });
}

export const csrfProtection = (options: CsrfMiddlewareOptions = {}): MiddlewareHandler<AppEnv> => {
  const { exemptPaths = [], checkOrigin = true, allowedOrigins } = options;

  // Normalize allowed origins for origin validation
  const originSet = new Set<string>();
  if (allowedOrigins) {
    const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];
    for (const o of origins) {
      if (o !== "*") originSet.add(o.replace(/\/$/, ""));
    }
  }

  return async (c, next) => {
    const secret = getJwtSecret();

    // Set CSRF cookie on every response if not already present
    const existingCsrf = getCookie(c, COOKIE_CSRF_TOKEN);
    if (!existingCsrf) {
      const token = generateCsrfToken(secret);
      setCookie(c, COOKIE_CSRF_TOKEN, token, csrfCookieOptions);
    }

    // Only validate state-changing methods
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      return next();
    }

    // Skip if no auth cookie present — not vulnerable to CSRF
    const authCookie = getCookie(c, COOKIE_TOKEN);
    if (!authCookie) {
      return next();
    }

    // Skip exempt paths
    const path = c.req.path;
    for (const exempt of exemptPaths) {
      if (exempt.endsWith("*")) {
        if (path.startsWith(exempt.slice(0, -1))) return next();
      } else {
        if (path === exempt) return next();
      }
    }

    // Origin validation (secondary layer)
    if (checkOrigin && originSet.size > 0) {
      const origin = c.req.header("origin");
      if (origin) {
        const normalized = origin.replace(/\/$/, "");
        if (!originSet.has(normalized)) {
          return c.json({ error: "CSRF origin mismatch" }, 403);
        }
      }
    }

    // Double submit cookie validation
    const csrfCookie = getCookie(c, COOKIE_CSRF_TOKEN);
    const csrfHeader = c.req.header(HEADER_CSRF_TOKEN);

    if (!csrfCookie || !csrfHeader) {
      return c.json({ error: "CSRF token missing" }, 403);
    }

    // Verify the cookie's HMAC signature (prevents cookie injection)
    if (!verifyCsrfSignature(csrfCookie, secret)) {
      return c.json({ error: "CSRF token invalid" }, 403);
    }

    // Compare header value to cookie value
    if (!timingSafeEqual(csrfHeader, csrfCookie)) {
      return c.json({ error: "CSRF token mismatch" }, 403);
    }

    return next();
  };
};
