import { createRouter } from "@lib/context";
import { setCookie } from "hono/cookie";
import { decodeIdToken } from "arctic";
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
import { createSession } from "@lib/session";
import { COOKIE_TOKEN } from "@lib/constants";
import { userAuth } from "@middleware/userAuth";
import { getDefaultRole } from "@lib/appConfig";

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};

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
  const token = await signToken(user.id);
  await createSession(user.id, token);
  setCookie(c, COOKIE_TOKEN, token, cookieOptions);

  // Append token to redirect so non-browser clients (mobile deep links) can extract it.
  // Browser apps can safely ignore the query param.
  try {
    const url = new URL(postLoginRedirect);
    url.searchParams.set("token", token);
    if (profile.email) url.searchParams.set("user", profile.email);
    return c.redirect(url.toString());
  } catch {
    // Relative path fallback
    const sep = postLoginRedirect.includes("?") ? "&" : "?";
    const userParam = profile.email ? `&user=${encodeURIComponent(profile.email)}` : "";
    return c.redirect(`${postLoginRedirect}${sep}token=${token}${userParam}`);
  }
};

export const createOAuthRouter = (providers: string[], postLoginRedirect: string) => {
  const router = createRouter();

  // ─── Google ───────────────────────────────────────────────────────────────
  if (providers.includes("google")) {
    router.get("/auth/google", async (c) => {
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      await storeOAuthState(state, codeVerifier);
      const url = getGoogle().createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
      return c.redirect(url.toString());
    });

    router.get("/auth/google/callback", async (c) => {
      const { code, state } = c.req.query();
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
    });

    router.get("/auth/google/link", userAuth, async (c) => {
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      await storeOAuthState(state, codeVerifier, c.get("authUserId")!);
      const url = getGoogle().createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
      return c.redirect(url.toString());
    });

    router.delete("/auth/google/link", userAuth, async (c) => {
      const adapter = getAuthAdapter();
      if (!adapter.unlinkProvider) {
        return c.json({ error: "Auth adapter does not support unlinkProvider" }, 500);
      }
      await adapter.unlinkProvider(c.get("authUserId")!, "google");
      return c.body(null, 204);
    });
  }

  // ─── Apple ────────────────────────────────────────────────────────────────
  if (providers.includes("apple")) {
    router.get("/auth/apple", async (c) => {
      const state = generateState();
      await storeOAuthState(state);
      const url = getApple().createAuthorizationURL(state, ["name", "email"]);
      return c.redirect(url.toString());
    });

    // Apple sends a POST with form data to the callback URL
    router.post("/auth/apple/callback", async (c) => {
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
    });

    router.get("/auth/apple/link", userAuth, async (c) => {
      const state = generateState();
      await storeOAuthState(state, undefined, c.get("authUserId")!);
      const url = getApple().createAuthorizationURL(state, ["name", "email"]);
      return c.redirect(url.toString());
    });
  }

  return router;
};
