import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import * as AuthService from "@services/auth";
import { makeRegisterSchema, makeLoginSchema, resetPasswordSchema } from "@schemas/auth";
import { COOKIE_TOKEN, HEADER_USER_TOKEN, COOKIE_REFRESH_TOKEN, HEADER_REFRESH_TOKEN } from "@lib/constants";
import { userAuth } from "@middleware/userAuth";
import { isLimited, trackAttempt, bustAuthLimit } from "@lib/authRateLimit";
import { getAuthAdapter } from "@lib/authAdapter";
import { createRouter } from "@lib/context";
import { getVerificationToken, deleteVerificationToken, createVerificationToken } from "@lib/emailVerification";
import { createResetToken, consumeResetToken } from "@lib/resetPassword";
import type { PrimaryField, EmailVerificationConfig, PasswordResetConfig, RefreshTokenConfig } from "@lib/appConfig";
import { getRefreshTokenExpiry, getAccessTokenExpiry } from "@lib/appConfig";
import type { AuthRateLimitConfig, AccountDeletionConfig } from "../app";
import { getUserSessions, deleteSession, deleteUserSessions } from "@lib/session";
import { getClientIp } from "@lib/clientIp";

const isProd = process.env.NODE_ENV === "production";
const TokenResponse = z.object({
  token: z.string().describe("JWT session token. Also set as an HttpOnly session cookie. Empty string when mfaRequired is true."),
  userId: z.string().describe("Unique user ID."),
  email: z.string().optional().describe("User's email address (present when primaryField is 'email')."),
  emailVerified: z.boolean().optional().describe("Whether the email address has been verified (present when emailVerification is configured)."),
  googleLinked: z.boolean().optional().describe("Whether a Google OAuth account is linked to this user."),
  refreshToken: z.string().optional().describe("Refresh token (present when refreshTokens is configured). Also set as an HttpOnly cookie."),
  mfaRequired: z.boolean().optional().describe("When true, complete MFA via POST /auth/mfa/verify before accessing the API."),
  mfaToken: z.string().optional().describe("MFA challenge token. Pass to POST /auth/mfa/verify with a TOTP or recovery code."),
  mfaMethods: z.array(z.string()).optional().describe("Available MFA methods when mfaRequired is true (e.g., 'totp', 'emailOtp')."),
}).openapi("TokenResponse");
const ErrorResponse = z.object({ error: z.string().describe("Human-readable error message.") }).openapi("ErrorResponse");
const tags = ["Auth"];

const cookieOptions = (maxAge?: number) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: maxAge ?? 60 * 60 * 24 * 7, // 7 days
});

export interface AuthRouterOptions {
  primaryField: PrimaryField;
  emailVerification?: EmailVerificationConfig;
  passwordReset?: PasswordResetConfig;
  rateLimit?: AuthRateLimitConfig;
  accountDeletion?: AccountDeletionConfig;
  refreshTokens?: RefreshTokenConfig;
}

export const createAuthRouter = ({ primaryField, emailVerification, passwordReset, rateLimit, accountDeletion, refreshTokens }: AuthRouterOptions) => {
  const router = createRouter();
  const RegisterSchema = makeRegisterSchema(primaryField);
  const LoginSchema = makeLoginSchema(primaryField);
  const fieldLabel = primaryField.charAt(0).toUpperCase() + primaryField.slice(1);
  const alreadyRegisteredMsg = `${fieldLabel} already registered`;

  // Resolve limits with defaults
  const loginOpts    = { windowMs: rateLimit?.login?.windowMs               ?? 15 * 60 * 1000, max: rateLimit?.login?.max               ?? 10 };
  const registerOpts = { windowMs: rateLimit?.register?.windowMs            ?? 60 * 60 * 1000, max: rateLimit?.register?.max            ?? 5  };
  const verifyOpts   = { windowMs: rateLimit?.verifyEmail?.windowMs         ?? 15 * 60 * 1000, max: rateLimit?.verifyEmail?.max         ?? 10 };
  const resendOpts   = { windowMs: rateLimit?.resendVerification?.windowMs  ?? 60 * 60 * 1000, max: rateLimit?.resendVerification?.max  ?? 3  };
  const forgotOpts   = { windowMs: rateLimit?.forgotPassword?.windowMs      ?? 15 * 60 * 1000, max: rateLimit?.forgotPassword?.max      ?? 5  };
  const resetOpts    = { windowMs: rateLimit?.resetPassword?.windowMs       ?? 15 * 60 * 1000, max: rateLimit?.resetPassword?.max       ?? 10 };

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/register",
      summary: "Register a new account",
      description: "Creates a new user account and returns a JWT session token. The token is also set as an HttpOnly session cookie. Rate-limited by IP.",
      tags,
      request: { body: { content: { "application/json": { schema: RegisterSchema } }, description: "Registration credentials." } },
      responses: {
        201: { content: { "application/json": { schema: TokenResponse } }, description: "Account created. Returns a session token." },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error (e.g. missing field, password too short)." },
        409: { content: { "application/json": { schema: ErrorResponse } }, description: alreadyRegisteredMsg },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many registration attempts from this IP. Try again later." },
      },
    }),
    async (c) => {
      const ip = getClientIp(c);
      if (await trackAttempt(`register:${ip}`, registerOpts)) {
        return c.json({ error: "Too many registration attempts. Try again later." }, 429);
      }
      const body = c.req.valid("json") as Record<string, string>;
      const identifier = body[primaryField];
      const metadata = {
        ipAddress: ip !== "unknown" ? ip : undefined,
        userAgent: c.req.header("user-agent") ?? undefined,
      };
      const result = await AuthService.register(identifier, body.password, metadata);
      setCookie(c, COOKIE_TOKEN, result.token, cookieOptions(refreshTokens ? getAccessTokenExpiry() : undefined));
      if (result.refreshToken) {
        setCookie(c, COOKIE_REFRESH_TOKEN, result.refreshToken, cookieOptions(getRefreshTokenExpiry()));
      }
      return c.json(result, 201);
    }
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/login",
      summary: "Log in",
      description: "Authenticates with credentials and returns a JWT session token. The token is also set as an HttpOnly session cookie. Failed attempts are rate-limited per identifier.",
      tags,
      request: { body: { content: { "application/json": { schema: LoginSchema } }, description: "Login credentials." } },
      responses: {
        200: { content: { "application/json": { schema: TokenResponse } }, description: "Authenticated. Returns a session token." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid credentials." },
        403: { content: { "application/json": { schema: ErrorResponse } }, description: "Email not verified. Verification is required before login." },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many failed login attempts for this identifier. Try again later." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json") as Record<string, string>;
      const identifier = body[primaryField];
      const limitKey = `login:${identifier}`;
      if (await isLimited(limitKey, loginOpts)) {
        return c.json({ error: "Too many failed login attempts. Try again later." }, 429);
      }
      const metadata = {
        ipAddress: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? undefined,
      };
      try {
        const result = await AuthService.login(identifier, body.password, metadata);
        await bustAuthLimit(limitKey); // success — clear failure count
        if (!result.mfaRequired) {
          setCookie(c, COOKIE_TOKEN, result.token, cookieOptions(refreshTokens ? getAccessTokenExpiry() : undefined));
          if (result.refreshToken) {
            setCookie(c, COOKIE_REFRESH_TOKEN, result.refreshToken, cookieOptions(getRefreshTokenExpiry()));
          }
        }
        return c.json(result, 200);
      } catch (err) {
        await trackAttempt(limitKey, loginOpts); // failure — count it
        throw err;
      }
    }
  );

  router.use("/auth/me", userAuth);

  router.openapi(
    withSecurity(createRoute({
      method: "get",
      path: "/auth/me",
      summary: "Get current user",
      description: "Returns the authenticated user's profile. Requires a valid session via cookie or x-user-token header.",
      tags,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                userId: z.string().describe("Unique user ID."),
                email: z.string().optional().describe("User's email address."),
                emailVerified: z.boolean().optional().describe("Whether the email address has been verified."),
                googleLinked: z.boolean().optional().describe("Whether a Google OAuth account is linked."),
              }),
            },
          },
          description: "Authenticated user's profile.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const authUserId = c.get("authUserId")!;
      const adapter = getAuthAdapter();
      const user = adapter.getUser ? await adapter.getUser(authUserId) : null;
      const googleLinked = user?.providerIds?.some((id) => id.startsWith("google:")) ?? false;
      return c.json({ userId: authUserId, email: user?.email, emailVerified: user?.emailVerified, googleLinked }, 200);
    }
  );

  // ---------------------------------------------------------------------------
  // Account deletion
  // ---------------------------------------------------------------------------

  const deleteAccountOpts = { windowMs: rateLimit?.deleteAccount?.windowMs ?? 60 * 60 * 1000, max: rateLimit?.deleteAccount?.max ?? 3 };

  router.openapi(
    withSecurity(createRoute({
      method: "delete",
      path: "/auth/me",
      summary: "Delete account",
      description: "Permanently deletes the authenticated user's account. Requires password confirmation for credential accounts. MFA is not required — the password serves as the identity check. Revokes all active sessions.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                password: z.string().optional().describe("Current password. Required for credential accounts, optional for OAuth-only accounts."),
              }),
            },
          },
          description: "Password confirmation.",
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Account deleted." },
        202: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Account deletion has been scheduled." },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Password is required for credential accounts." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid password or no valid session." },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many deletion attempts. Try again later." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "The configured auth adapter does not support deleteUser." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const authUserId = c.get("authUserId")!;
      if (await trackAttempt(`deleteaccount:${authUserId}`, deleteAccountOpts)) {
        return c.json({ error: "Too many deletion attempts. Try again later." }, 429);
      }

      const adapter = getAuthAdapter();
      if (!adapter.deleteUser) {
        return c.json({ error: "Auth adapter does not support deleteUser" }, 501);
      }

      const { password } = c.req.valid("json");

      // Verify password for credential accounts
      if (password) {
        const user = adapter.getUser ? await adapter.getUser(authUserId) : null;
        const email = user?.email;
        if (email) {
          const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
          const found = await findFn(email);
          if (found && !(await Bun.password.verify(password, found.passwordHash))) {
            return c.json({ error: "Invalid password" }, 401);
          }
        }
      } else if (adapter.hasPassword && await adapter.hasPassword(authUserId)) {
        return c.json({ error: "Password is required to delete a credential account" }, 400);
      }

      // Call onBeforeDelete hook
      if (accountDeletion?.onBeforeDelete) {
        await accountDeletion.onBeforeDelete(authUserId);
      }

      // Synchronous deletion (default)
      await deleteUserSessions(authUserId);
      await adapter.deleteUser(authUserId);

      if (accountDeletion?.onAfterDelete) {
        await accountDeletion.onAfterDelete(authUserId);
      }

      deleteCookie(c, COOKIE_TOKEN, { path: "/" });
      return c.json({ message: "Account deleted" }, 200);
    }
  );

  router.use("/auth/set-password", userAuth);

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/set-password",
      summary: "Set or update password",
      description: "Sets or updates the password for the authenticated user. Useful for OAuth-only users who want to add a password. Requires a valid session.",
      tags,
      request: { body: { content: { "application/json": { schema: z.object({ password: z.string().min(8).describe("New password. Minimum 8 characters.") }) } }, description: "New password." } },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Password updated successfully." },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error (e.g. password too short)." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "The configured auth adapter does not support setPassword." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const adapter = getAuthAdapter();
      if (!adapter.setPassword) {
        return c.json({ error: "Auth adapter does not support setPassword" }, 501);
      }
      const { password } = c.req.valid("json");
      const authUserId = c.get("authUserId")!;
      const passwordHash = await Bun.password.hash(password);
      await adapter.setPassword(authUserId, passwordHash);
      return c.json({ message: "Password updated" }, 200);
    }
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      summary: "Log out",
      description: "Invalidates the current session and clears the session cookie. Safe to call even without an active session.",
      tags,
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Logged out. Session is invalidated and cookie is cleared." },
      },
    }),
    async (c) => {
      const token = getCookie(c, COOKIE_TOKEN) ?? c.req.header(HEADER_USER_TOKEN) ?? null;
      await AuthService.logout(token);
      deleteCookie(c, COOKIE_TOKEN, { path: "/" });
      deleteCookie(c, COOKIE_REFRESH_TOKEN, { path: "/" });
      return c.json({ message: "Logged out" }, 200);
    }
  );

  // Email verification routes — only mounted when emailVerification is configured and primaryField is "email"
  if (emailVerification && primaryField === "email") {
    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/verify-email",
        summary: "Verify email address",
        description: "Consumes a single-use email verification token and marks the account as verified. The token is delivered by the `emailVerification.onSend` callback configured in CreateAppConfig. Rate-limited by IP.",
        tags,
        request: { body: { content: { "application/json": { schema: z.object({ token: z.string().describe("Single-use verification token received via email.") }) } }, description: "Verification token." } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Email verified successfully." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired verification token." },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many verification attempts from this IP. Try again later." },
        },
      }),
      async (c) => {
        const ip = getClientIp(c);
        if (await trackAttempt(`verify:${ip}`, verifyOpts)) {
          return c.json({ error: "Too many verification attempts. Try again later." }, 429);
        }
        const { token } = c.req.valid("json");
        const adapter = getAuthAdapter();
        const entry = await getVerificationToken(token);
        if (!entry) return c.json({ error: "Invalid or expired verification token" }, 400);
        if (adapter.setEmailVerified) await adapter.setEmailVerified(entry.userId, true);
        await deleteVerificationToken(token);
        return c.json({ message: "Email verified" }, 200);
      }
    );

    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/resend-verification",
        summary: "Resend verification email",
        description: "Authenticates with credentials and sends a new verification email. Returns 400 if already verified. Rate-limited per identifier. Does not require a session.",
        tags,
        request: { body: { content: { "application/json": { schema: LoginSchema } }, description: "Login credentials to identify the account." } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Verification email sent." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Email is already verified, or no email address on file." },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid credentials." },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many resend attempts for this identifier. Try again later." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "The configured auth adapter does not support email verification." },
        },
      }),
      async (c) => {
        const adapter = getAuthAdapter();
        if (!adapter.getEmailVerified || !adapter.getUser) {
          return c.json({ error: "Auth adapter does not support email verification" }, 501);
        }
        const body = c.req.valid("json") as Record<string, string>;
        const identifier = body[primaryField];
        if (await trackAttempt(`resend:${identifier}`, resendOpts)) {
          return c.json({ error: "Too many resend attempts. Try again later." }, 429);
        }
        const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
        const user = await findFn(identifier);
        if (!user || !(await Bun.password.verify(body.password, user.passwordHash))) {
          return c.json({ error: "Invalid credentials" }, 401);
        }
        const alreadyVerified = await adapter.getEmailVerified(user.id);
        if (alreadyVerified) return c.json({ error: "Email already verified" }, 400);
        const fullUser = await adapter.getUser(user.id);
        if (!fullUser?.email) return c.json({ error: "No email address on file" }, 400);
        const verificationToken = await createVerificationToken(user.id, fullUser.email);
        await emailVerification.onSend(fullUser.email, verificationToken);
        return c.json({ message: "Verification email sent" }, 200);
      }
    );
  }

  // Password reset routes — only mounted when passwordReset is configured and primaryField is "email"
  if (passwordReset && primaryField === "email") {
    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/forgot-password",
        summary: "Request password reset",
        description: "Sends a password reset email if the address is registered. Always returns 200 regardless of whether the address exists, to prevent email enumeration. Rate-limited by both IP and email address.",
        tags,
        request: { body: { content: { "application/json": { schema: z.object({ email: z.string().email().describe("Email address to send the reset link to.") }) } }, description: "Email address for the account to reset." } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Request received. A reset email will be sent if the address is registered." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error (e.g. not a valid email address)." },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts from this IP or for this email address. Try again later." },
        },
      }),
      async (c) => {
        const ip = getClientIp(c);
        const { email } = c.req.valid("json");
        // Rate-limit by both IP and email to prevent distributed email-bombing
        const ipLimited    = await trackAttempt(`forgot:ip:${ip}`, forgotOpts);
        const emailLimited = await trackAttempt(`forgot:email:${email}`, forgotOpts);
        if (ipLimited || emailLimited) {
          return c.json({ error: "Too many attempts. Try again later." }, 429);
        }
        const adapter = getAuthAdapter();
        const user = await adapter.findByEmail(email);
        // Fire-and-forget: the response does not wait for token creation or email sending,
        // which reduces obvious timing differences between registered and unregistered emails.
        const msg = { message: "If that email is registered, a password reset link has been sent." };
        if (user) {
          void (async () => {
            try {
              const token = await createResetToken(user.id, email);
              await passwordReset.onSend(email, token);
            } catch (err) {
              console.error("Failed to send password reset email:", err);
            }
          })();
        }
        return c.json(msg, 200);
      }
    );

    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/reset-password",
        summary: "Reset password",
        description: "Consumes a single-use reset token and sets a new password. All active sessions are revoked after a successful reset to invalidate any stolen JWTs. Rate-limited by IP.",
        tags,
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  token: z.string().describe("Single-use reset token received via email."),
                  password: resetPasswordSchema().describe("New password."),
                }),
              },
            },
            description: "Reset token and new password.",
          },
        },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Password reset. All sessions have been revoked." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error, or the reset token is invalid or expired." },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many reset attempts from this IP. Try again later." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "The configured auth adapter does not support setPassword." },
        },
      }),
      async (c) => {
        const ip = getClientIp(c);
        if (await trackAttempt(`reset:${ip}`, resetOpts)) {
          return c.json({ error: "Too many attempts. Try again later." }, 429);
        }
        const { token, password } = c.req.valid("json");
        // consumeResetToken atomically gets and deletes — prevents concurrent replay
        const entry = await consumeResetToken(token);
        if (!entry) return c.json({ error: "Invalid or expired reset token" }, 400);
        const adapter = getAuthAdapter();
        if (!adapter.setPassword) {
          return c.json({ error: "Auth adapter does not support setPassword" }, 501);
        }
        const passwordHash = await Bun.password.hash(password);
        await adapter.setPassword(entry.userId, passwordHash);
        // Revoke all sessions so stolen JWTs can't stay valid after a reset
        const sessions = await getUserSessions(entry.userId);
        await Promise.all(sessions.map((s) => deleteSession(s.sessionId)));
        return c.json({ message: "Password reset successfully" }, 200);
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Refresh token route — only mounted when refreshTokens is configured
  // ---------------------------------------------------------------------------

  if (refreshTokens) {
    const RefreshResponse = z.object({
      token: z.string().describe("New short-lived JWT access token."),
      refreshToken: z.string().describe("New refresh token (rotation). The previous token is valid for a short grace window."),
      userId: z.string().describe("Unique user ID."),
    }).openapi("RefreshResponse");

    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/refresh",
        summary: "Refresh access token",
        description: "Exchanges a valid refresh token for a new access token and rotated refresh token. The old refresh token remains valid for a short grace window to handle network drops. If a previously rotated token is reused after the grace window, the entire session is invalidated (token theft detection).",
        tags,
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  refreshToken: z.string().optional().describe("Refresh token. Can also be sent via the refresh_token cookie or x-refresh-token header."),
                }),
              },
            },
            description: "Refresh token (optional if sent via cookie or header).",
          },
        },
        responses: {
          200: { content: { "application/json": { schema: RefreshResponse } }, description: "New access and refresh tokens." },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired refresh token, or session invalidated due to token theft detection." },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many refresh attempts. Try again later." },
        },
      }),
      async (c) => {
        const ip = getClientIp(c);
        if (await trackAttempt(`refresh:ip:${ip}`, { max: 30, windowMs: 60_000 })) {
          return c.json({ error: "Too many refresh attempts. Try again later." }, 429);
        }
        const body = c.req.valid("json");
        const rt = body.refreshToken ?? getCookie(c, COOKIE_REFRESH_TOKEN) ?? c.req.header(HEADER_REFRESH_TOKEN) ?? null;
        if (!rt) {
          return c.json({ error: "Refresh token is required" }, 401);
        }
        const result = await AuthService.refresh(rt);
        setCookie(c, COOKIE_TOKEN, result.token, cookieOptions(getAccessTokenExpiry()));
        setCookie(c, COOKIE_REFRESH_TOKEN, result.refreshToken, cookieOptions(getRefreshTokenExpiry()));
        return c.json(result, 200);
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  const SessionInfoSchema = z.object({
    sessionId:    z.string().describe("Unique session identifier (UUID)."),
    createdAt:    z.number().describe("Unix timestamp (ms) when the session was created."),
    lastActiveAt: z.number().describe("Unix timestamp (ms) of the most recent authenticated request (updated when trackLastActive is enabled)."),
    expiresAt:    z.number().describe("Unix timestamp (ms) when the session expires."),
    ipAddress:    z.string().optional().describe("IP address of the client at session creation."),
    userAgent:    z.string().optional().describe("User-agent string of the client at session creation."),
    isActive:     z.boolean().describe("Whether the session is currently valid and unexpired."),
  }).openapi("SessionInfo");

  router.use("/auth/sessions", userAuth);
  router.use("/auth/sessions/*", userAuth);

  router.openapi(
    withSecurity(createRoute({
      method: "get",
      path: "/auth/sessions",
      summary: "List sessions",
      description: "Returns all sessions for the authenticated user. Includes inactive sessions when `sessionPolicy.includeInactiveSessions` is enabled. Requires a valid session.",
      tags,
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ sessions: z.array(SessionInfoSchema) }) } },
          description: "Sessions belonging to the authenticated user.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const sessions = await getUserSessions(userId);
      return c.json({ sessions }, 200);
    }
  );

  router.openapi(
    withSecurity(createRoute({
      method: "delete",
      path: "/auth/sessions/{sessionId}",
      summary: "Revoke a session",
      description: "Revokes a specific session by ID. Users can only revoke their own sessions. Useful for 'sign out of other devices' flows. Requires a valid session.",
      tags,
      request: { params: z.object({ sessionId: z.string().describe("UUID of the session to revoke.") }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Session revoked successfully." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
        404: { content: { "application/json": { schema: ErrorResponse } }, description: "Session not found or does not belong to the authenticated user." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { sessionId } = c.req.valid("param");
      const sessions = await getUserSessions(userId);
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return c.json({ error: "Session not found" }, 404);
      await deleteSession(sessionId);
      return c.json({ message: "Session revoked" }, 200);
    }
  );

  return router;
};
