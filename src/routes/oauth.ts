import { createRoute, withSecurity } from "@lib/createRoute";
import { createRouter } from "@lib/context";
import { setCookie } from "hono/cookie";
import { decodeIdToken } from "arctic";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "@lib/context";
import {
  getGoogle, getApple,
  storeOAuthState, consumeOAuthState,
  generateState, generateCodeVerifier,
} from "@lib/oauth";
import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { signToken } from "@lib/jwt";
import { createSession, getActiveSessionCount, evictOldestSession, setRefreshToken } from "@lib/session";
import { storeOAuthCode, consumeOAuthCode } from "@lib/oauthCode";
import { COOKIE_TOKEN, COOKIE_REFRESH_TOKEN } from "@lib/constants";
import { userAuth } from "@middleware/userAuth";
import { getDefaultRole, getMaxSessions, getRefreshTokenConfig, getAccessTokenExpiry, getRefreshTokenExpiry, getCsrfEnabled } from "@lib/appConfig";
import { refreshCsrfToken } from "@middleware/csrf";
import { trackAttempt } from "@lib/authRateLimit";
import { getClientIp } from "@lib/clientIp";

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = (maxAge?: number) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: maxAge ?? 60 * 60 * 24 * 7,
});

const tags = ["OAuth"];

const OAuthErrorResponse = z.object({ error: z.string().describe("Human-readable error message.") }).openapi("OAuthErrorResponse");

const finishOAuth = async (
  c: Context<AppEnv>,
  provider: string,
  providerId: string,
  profile: { email?: string; name?: string; avatarUrl?: string },
  postLoginRedirect: string,
) => {
  const adapter = getAuthAdapter();
  if (!adapter.findOrCreateByProvider) {
    return c.json({ error: "Auth adapter does not support social login" }, 500);
  }
  let user: { id: string; created: boolean };
  try {
    user = await adapter.findOrCreateByProvider(provider, providerId, profile);
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "Authentication failed";
    const sep = postLoginRedirect.includes("?") ? "&" : "?";
    return c.redirect(`${postLoginRedirect}${sep}error=${encodeURIComponent(message)}`);
  }
  if (user.created) {
    const role = getDefaultRole();
    if (role && adapter.setRoles) await adapter.setRoles(user.id, [role]);
  }
  const sessionId = crypto.randomUUID();
  const rtConfig = getRefreshTokenConfig();
  const expirySeconds = rtConfig ? getAccessTokenExpiry() : undefined;
  const token = await signToken(user.id, sessionId, expirySeconds);
  const metadata = {
    ipAddress: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? undefined,
  };
  while (await getActiveSessionCount(user.id) >= getMaxSessions()) {
    await evictOldestSession(user.id);
  }
  await createSession(user.id, token, sessionId, metadata);

  let refreshTokenValue: string | undefined;
  if (rtConfig) {
    refreshTokenValue = crypto.randomUUID();
    await setRefreshToken(sessionId, refreshTokenValue);
  }

  // Store a one-time authorization code instead of exposing the token in the redirect URL.
  // The client exchanges this code via POST /auth/oauth/exchange to get the session token.
  const code = await storeOAuthCode({
    token,
    userId: user.id,
    email: profile.email,
    refreshToken: refreshTokenValue,
  });

  try {
    const url = new URL(postLoginRedirect);
    url.searchParams.set("code", code);
    if (profile.email) url.searchParams.set("user", profile.email);
    return c.redirect(url.toString());
  } catch {
    // Relative path fallback
    const sep = postLoginRedirect.includes("?") ? "&" : "?";
    const userParam = profile.email ? `&user=${encodeURIComponent(profile.email)}` : "";
    return c.redirect(`${postLoginRedirect}${sep}code=${code}${userParam}`);
  }
};

export const createOAuthRouter = (providers: string[], postLoginRedirect: string) => {
  const router = createRouter();

  // ─── Google ───────────────────────────────────────────────────────────────
  if (providers.includes("google")) {
    router.openapi(
      createRoute({
        method: "get",
        path: "/auth/google",
        summary: "Initiate Google OAuth",
        description: "Redirects the user to Google's consent screen to begin the OAuth login flow. After the user authorizes, Google redirects back to `/auth/google/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Google's OAuth consent screen." },
          500: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "OAuth provider not configured." },
        },
      }),
      async (c) => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        await storeOAuthState(state, codeVerifier);
        const url = getGoogle().createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
        return c.redirect(url.toString());
      }
    );

    router.openapi(
      createRoute({
        method: "get",
        path: "/auth/google/callback",
        summary: "Google OAuth callback",
        description: "Handles the redirect from Google after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.",
        tags,
        request: {
          query: z.object({
            code: z.string().describe("Authorization code from Google."),
            state: z.string().describe("OAuth state parameter for CSRF protection."),
          }),
        },
        responses: {
          302: { description: "Redirect to the post-login URL with session token." },
          400: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Invalid callback parameters or expired state." },
        },
      }),
      async (c) => {
        const { code, state } = c.req.valid("query");
        if (!code || !state) return c.json({ error: "Invalid callback" }, 400);

        const stored = await consumeOAuthState(state);
        if (!stored?.codeVerifier) return c.json({ error: "Invalid or expired state" }, 400);

        const tokens = await getGoogle().validateAuthorizationCode(code, stored.codeVerifier);
        const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then((r) => r.json()) as { sub: string; email?: string; name?: string; picture?: string };

        if (stored.linkUserId) {
          const adapter = getAuthAdapter();
          if (!adapter.linkProvider) return c.json({ error: "Auth adapter does not support linkProvider" }, 500);
          await adapter.linkProvider(stored.linkUserId, "google", info.sub);
          const sep = postLoginRedirect.includes("?") ? "&" : "?";
          return c.redirect(`${postLoginRedirect}${sep}linked=google`);
        }

        return finishOAuth(c, "google", info.sub, { email: info.email, name: info.name, avatarUrl: info.picture }, postLoginRedirect);
      }
    );

    router.use("/auth/google/link", userAuth);

    router.openapi(
      withSecurity(createRoute({
        method: "get",
        path: "/auth/google/link",
        summary: "Link Google account",
        description: "Initiates an OAuth flow to link a Google account to the authenticated user. Requires a valid session. Redirects to Google's consent screen.",
        tags,
        responses: {
          302: { description: "Redirect to Google's OAuth consent screen." },
          401: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "No valid session." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        await storeOAuthState(state, codeVerifier, c.get("authUserId")!);
        const url = getGoogle().createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
        return c.redirect(url.toString());
      }
    );

    router.openapi(
      withSecurity(createRoute({
        method: "delete",
        path: "/auth/google/link",
        summary: "Unlink Google account",
        description: "Removes the linked Google OAuth account from the authenticated user. Requires a valid session.",
        tags,
        responses: {
          204: { description: "Google account unlinked successfully." },
          401: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "No valid session." },
          500: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Auth adapter does not support unlinkProvider." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const adapter = getAuthAdapter();
        if (!adapter.unlinkProvider) {
          return c.json({ error: "Auth adapter does not support unlinkProvider" }, 500);
        }
        await adapter.unlinkProvider(c.get("authUserId")!, "google");
        return c.body(null, 204);
      }
    );
  }

  // ─── Apple ────────────────────────────────────────────────────────────────
  if (providers.includes("apple")) {
    router.openapi(
      createRoute({
        method: "get",
        path: "/auth/apple",
        summary: "Initiate Apple OAuth",
        description: "Redirects the user to Apple's sign-in page to begin the OAuth login flow. After the user authorizes, Apple posts back to `/auth/apple/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Apple's OAuth sign-in page." },
          500: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "OAuth provider not configured." },
        },
      }),
      async (c) => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getApple().createAuthorizationURL(state, ["name", "email"]);
        return c.redirect(url.toString());
      }
    );

    // Apple sends a POST with form data to the callback URL
    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/apple/callback",
        summary: "Apple OAuth callback",
        description: "Handles the POST redirect from Apple after user authorization. Apple sends form-encoded data containing the authorization code and state. Validates the OAuth state, exchanges the code for tokens, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.",
        tags,
        responses: {
          302: { description: "Redirect to the post-login URL with session token." },
          400: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Invalid callback parameters or expired state." },
        },
      }),
      async (c) => {
        const form = await c.req.formData();
        const code = form.get("code") as string | null;
        const state = form.get("state") as string | null;
        if (!code || !state) return c.json({ error: "Invalid callback" }, 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return c.json({ error: "Invalid or expired state" }, 400);

        const tokens = await getApple().validateAuthorizationCode(code);
        const claims = decodeIdToken(tokens.idToken()) as { sub: string; email?: string };

        if (stored.linkUserId) {
          const adapter = getAuthAdapter();
          if (!adapter.linkProvider) return c.json({ error: "Auth adapter does not support linkProvider" }, 500);
          await adapter.linkProvider(stored.linkUserId, "apple", claims.sub);
          const sep = postLoginRedirect.includes("?") ? "&" : "?";
          return c.redirect(`${postLoginRedirect}${sep}linked=apple`);
        }

        // Apple only sends name on the very first sign-in
        const userJSON = form.get("user") as string | null;
        const userInfo = userJSON ? JSON.parse(userJSON) as { name?: { firstName?: string; lastName?: string } } : {};
        const name = userInfo.name
          ? `${userInfo.name.firstName ?? ""} ${userInfo.name.lastName ?? ""}`.trim() || undefined
          : undefined;

        return finishOAuth(c, "apple", claims.sub, { email: claims.email, name }, postLoginRedirect);
      }
    );

    router.use("/auth/apple/link", userAuth);

    router.openapi(
      withSecurity(createRoute({
        method: "get",
        path: "/auth/apple/link",
        summary: "Link Apple account",
        description: "Initiates an OAuth flow to link an Apple account to the authenticated user. Requires a valid session. Redirects to Apple's sign-in page.",
        tags,
        responses: {
          302: { description: "Redirect to Apple's OAuth sign-in page." },
          401: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "No valid session." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const state = generateState();
        await storeOAuthState(state, undefined, c.get("authUserId")!);
        const url = getApple().createAuthorizationURL(state, ["name", "email"]);
        return c.redirect(url.toString());
      }
    );
  }

  // ─── Code Exchange ─────────────────────────────────────────────────────
  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/oauth/exchange",
      summary: "Exchange OAuth authorization code for session token",
      description: "Exchanges a one-time authorization code (received from the OAuth redirect) for a session token. The code is single-use and expires after 60 seconds. Sets session cookies for browser clients; returns the token in the JSON response for mobile/SPA clients.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                code: z.string().describe("One-time authorization code from the OAuth redirect."),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                token: z.string().describe("Session JWT."),
                userId: z.string().describe("Authenticated user ID."),
                email: z.string().optional().describe("User email if available."),
                refreshToken: z.string().optional().describe("Refresh token if refresh tokens are configured."),
              }),
            },
          },
          description: "Session token and user info.",
        },
        400: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Missing code parameter." },
        401: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Invalid, expired, or already-used code." },
        429: { content: { "application/json": { schema: OAuthErrorResponse } }, description: "Rate limit exceeded." },
      },
    }),
    async (c) => {
      // Rate limit by IP to prevent brute-forcing codes within the 60s TTL
      const ip = getClientIp(c);
      const limited = await trackAttempt(`oauth-exchange:ip:${ip}`, { max: 20, windowMs: 60_000 });
      if (limited) {
        return c.json({ error: "Too many requests" }, 429);
      }

      const { code } = c.req.valid("json");
      if (!code) return c.json({ error: "Missing code" }, 400);

      const payload = await consumeOAuthCode(code);
      if (!payload) return c.json({ error: "Invalid or expired code" }, 401);

      // Set session cookies for browser clients
      const rtConfig = getRefreshTokenConfig();
      setCookie(c, COOKIE_TOKEN, payload.token, cookieOptions(rtConfig ? getAccessTokenExpiry() : undefined));
      if (payload.refreshToken && rtConfig) {
        setCookie(c, COOKIE_REFRESH_TOKEN, payload.refreshToken, cookieOptions(getRefreshTokenExpiry()));
      }
      if (getCsrfEnabled()) refreshCsrfToken(c);

      return c.json({
        token: payload.token,
        userId: payload.userId,
        email: payload.email,
        refreshToken: payload.refreshToken,
      }, 200);
    }
  );

  return router;
};
