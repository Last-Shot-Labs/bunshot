import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import * as AuthService from "@services/auth";
import { makeRegisterSchema, makeLoginSchema } from "@schemas/auth";
import { COOKIE_TOKEN, HEADER_USER_TOKEN } from "@lib/constants";
import { userAuth } from "@middleware/userAuth";
import { isLimited, trackAttempt, bustAuthLimit } from "@lib/authRateLimit";
import { getAuthAdapter } from "@lib/authAdapter";
import { createRouter } from "@lib/context";
import { getVerificationToken, deleteVerificationToken, createVerificationToken } from "@lib/emailVerification";
import { createResetToken, consumeResetToken } from "@lib/resetPassword";
import type { PrimaryField, EmailVerificationConfig, PasswordResetConfig } from "@lib/appConfig";
import type { AuthRateLimitConfig } from "../app";
import { getUserSessions, deleteSession } from "@lib/session";

const isProd = process.env.NODE_ENV === "production";
const TokenResponse = z.object({ token: z.string(), emailVerified: z.boolean().optional() });
const ErrorResponse = z.object({ error: z.string() });
const tags = ["Auth"];

const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7, // 7 days
};

const clientIp = (xff: string | undefined | null, xri: string | undefined | null): string | undefined =>
  (xff ? xff.split(",")[0]?.trim() : undefined) ?? xri ?? undefined;

export interface AuthRouterOptions {
  primaryField: PrimaryField;
  emailVerification?: EmailVerificationConfig;
  passwordReset?: PasswordResetConfig;
  rateLimit?: AuthRateLimitConfig;
}

export const createAuthRouter = ({ primaryField, emailVerification, passwordReset, rateLimit }: AuthRouterOptions) => {
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
      tags,
      request: { body: { content: { "application/json": { schema: RegisterSchema } } } },
      responses: {
        201: { content: { "application/json": { schema: TokenResponse } }, description: "Registered" },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error" },
        409: { content: { "application/json": { schema: ErrorResponse } }, description: alreadyRegisteredMsg },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
      },
    }),
    async (c) => {
      const ip = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")) ?? "unknown";
      if (await trackAttempt(`register:${ip}`, registerOpts)) {
        return c.json({ error: "Too many registration attempts. Try again later." }, 429);
      }
      const body = c.req.valid("json") as Record<string, string>;
      const identifier = body[primaryField];
      const metadata = {
        ipAddress: ip !== "unknown" ? ip : undefined,
        userAgent: c.req.header("user-agent") ?? undefined,
      };
      const token = await AuthService.register(identifier, body.password, metadata);
      setCookie(c, COOKIE_TOKEN, token, cookieOptions);
      return c.json({ token }, 201);
    }
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/login",
      tags,
      request: { body: { content: { "application/json": { schema: LoginSchema } } } },
      responses: {
        200: { content: { "application/json": { schema: TokenResponse } }, description: "Logged in" },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid credentials" },
        403: { content: { "application/json": { schema: ErrorResponse } }, description: "Email not verified" },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
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
        ipAddress: clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")),
        userAgent: c.req.header("user-agent") ?? undefined,
      };
      try {
        const result = await AuthService.login(identifier, body.password, metadata);
        await bustAuthLimit(limitKey); // success — clear failure count
        setCookie(c, COOKIE_TOKEN, result.token, cookieOptions);
        return c.json(result, 200);
      } catch (err) {
        await trackAttempt(limitKey, loginOpts); // failure — count it
        throw err;
      }
    }
  );

  router.use("/auth/me", userAuth);

  router.openapi(
    createRoute({
      method: "get",
      path: "/auth/me",
      tags,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                userId: z.string(),
                email: z.string().optional(),
                emailVerified: z.boolean().optional(),
                googleLinked: z.boolean().optional(),
              }),
            },
          },
          description: "Current user",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Unauthorized" },
      },
    }),
    async (c) => {
      const authUserId = c.get("authUserId")!;
      const adapter = getAuthAdapter();
      const user = adapter.getUser ? await adapter.getUser(authUserId) : null;
      const googleLinked = user?.providerIds?.some((id) => id.startsWith("google:")) ?? false;
      return c.json({ userId: authUserId, email: user?.email, emailVerified: user?.emailVerified, googleLinked }, 200);
    }
  );

  router.use("/auth/set-password", userAuth);

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/set-password",
      tags,
      request: { body: { content: { "application/json": { schema: z.object({ password: z.string().min(8) }) } } } },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Password set" },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error" },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Not supported by adapter" },
      },
    }),
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
      tags,
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Logged out" },
      },
    }),
    async (c) => {
      const token = getCookie(c, COOKIE_TOKEN) ?? c.req.header(HEADER_USER_TOKEN) ?? null;
      await AuthService.logout(token);
      deleteCookie(c, COOKIE_TOKEN, { path: "/" });
      return c.json({ message: "Logged out" }, 200);
    }
  );

  // Email verification routes — only mounted when emailVerification is configured and primaryField is "email"
  if (emailVerification && primaryField === "email") {
    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/verify-email",
        tags,
        request: { body: { content: { "application/json": { schema: z.object({ token: z.string() }) } } } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Email verified" },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired token" },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
        },
      }),
      async (c) => {
        const ip = c.req.header("x-forwarded-for") ?? "unknown";
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

    router.use("/auth/resend-verification", userAuth);

    router.openapi(
      createRoute({
        method: "post",
        path: "/auth/resend-verification",
        tags,
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Verification email sent" },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Already verified" },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "Not supported by adapter" },
        },
      }),
      async (c) => {
        const adapter = getAuthAdapter();
        if (!adapter.getEmailVerified || !adapter.getUser) {
          return c.json({ error: "Auth adapter does not support email verification" }, 501);
        }
        const authUserId = c.get("authUserId")!;
        if (await trackAttempt(`resend:${authUserId}`, resendOpts)) {
          return c.json({ error: "Too many resend attempts. Try again later." }, 429);
        }
        const alreadyVerified = await adapter.getEmailVerified(authUserId);
        if (alreadyVerified) return c.json({ error: "Email already verified" }, 400);
        const user = await adapter.getUser(authUserId);
        if (!user?.email) return c.json({ error: "No email address on file" }, 400);
        const verificationToken = await createVerificationToken(authUserId, user.email);
        await emailVerification.onSend(user.email, verificationToken);
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
        tags,
        request: { body: { content: { "application/json": { schema: z.object({ email: z.string().email() }) } } } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Reset email sent if address is registered" },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error" },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
        },
      }),
      async (c) => {
        const ip = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")) ?? "unknown";
        if (await trackAttempt(`forgot:${ip}`, forgotOpts)) {
          return c.json({ error: "Too many attempts. Try again later." }, 429);
        }
        const { email } = c.req.valid("json");
        const adapter = getAuthAdapter();
        const user = await adapter.findByEmail(email);
        // Fire-and-forget: return immediately so both branches take the same time,
        // preventing email enumeration via response timing.
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
        tags,
        request: { body: { content: { "application/json": { schema: z.object({ token: z.string(), password: z.string().min(8) }) } } } },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Password reset successfully" },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error or invalid/expired token" },
          429: { content: { "application/json": { schema: ErrorResponse } }, description: "Too many attempts" },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "Not supported by adapter" },
        },
      }),
      async (c) => {
        const ip = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")) ?? "unknown";
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
        return c.json({ message: "Password reset successfully" }, 200);
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  const SessionInfoSchema = z.object({
    sessionId:    z.string(),
    createdAt:    z.number(),
    lastActiveAt: z.number(),
    expiresAt:    z.number(),
    ipAddress:    z.string().optional(),
    userAgent:    z.string().optional(),
    isActive:     z.boolean(),
  });

  router.use("/auth/sessions", userAuth);
  router.use("/auth/sessions/*", userAuth);

  router.openapi(
    createRoute({
      method: "get",
      path: "/auth/sessions",
      tags,
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ sessions: z.array(SessionInfoSchema) }) } },
          description: "List of sessions for the current user",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Unauthorized" },
      },
    }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const sessions = await getUserSessions(userId);
      return c.json({ sessions }, 200);
    }
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/auth/sessions/{sessionId}",
      tags,
      request: { params: z.object({ sessionId: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Session revoked" },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Unauthorized" },
        404: { content: { "application/json": { schema: ErrorResponse } }, description: "Session not found" },
      },
    }),
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
