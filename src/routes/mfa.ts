import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { setCookie, getCookie } from "hono/cookie";
import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import * as MfaService from "@services/mfa";
import * as AuthService from "@services/auth";
import { consumeMfaChallenge } from "@lib/mfaChallenge";
import { COOKIE_TOKEN, COOKIE_REFRESH_TOKEN, HEADER_REFRESH_TOKEN } from "@lib/constants";
import { getRefreshTokenConfig, getAccessTokenExpiry, getRefreshTokenExpiry } from "@lib/appConfig";

const isProd = process.env.NODE_ENV === "production";
const cookieOptions = (maxAge?: number) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: maxAge ?? 60 * 60 * 24 * 7,
});

const tags = ["MFA"];
const ErrorResponse = z.object({ error: z.string() }).openapi("MfaErrorResponse");

export const createMfaRouter = () => {
  const router = createRouter();

  // All MFA setup/management routes require auth
  router.use("/auth/mfa/setup", userAuth);
  router.use("/auth/mfa/verify-setup", userAuth);
  router.use("/auth/mfa", userAuth);
  router.use("/auth/mfa/recovery-codes", userAuth);

  // ─── Setup ────────────────────────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/mfa/setup",
      summary: "Initiate MFA setup",
      description: "Generates a TOTP secret and returns the otpauth URI for QR code scanning. The user must confirm setup by verifying a code via POST /auth/mfa/verify-setup.",
      tags,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                secret: z.string().describe("Base32-encoded TOTP secret."),
                uri: z.string().describe("otpauth:// URI for QR code generation."),
              }),
            },
          },
          description: "TOTP secret generated. Scan the QR code with an authenticator app.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const result = await MfaService.setupMfa(userId);
      return c.json(result, 200);
    }
  );

  // ─── Verify Setup ─────────────────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/mfa/verify-setup",
      summary: "Confirm MFA setup",
      description: "Verifies a TOTP code from the authenticator app and enables MFA. Returns one-time recovery codes that should be stored securely.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                code: z.string().length(6).describe("6-digit TOTP code from the authenticator app."),
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
                message: z.string(),
                recoveryCodes: z.array(z.string()).describe("One-time recovery codes. Store these securely — they cannot be shown again."),
              }),
            },
          },
          description: "MFA enabled successfully.",
        },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "MFA setup not initiated." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid TOTP code or no valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { code } = c.req.valid("json");
      const recoveryCodes = await MfaService.verifySetup(userId, code);
      return c.json({ message: "MFA enabled", recoveryCodes }, 200);
    }
  );

  // ─── Verify (complete login after password) ───────────────────────────────

  const MfaLoginResponse = z.object({
    token: z.string().describe("JWT session token."),
    userId: z.string().describe("Unique user ID."),
    refreshToken: z.string().optional().describe("Refresh token (when configured)."),
  }).openapi("MfaLoginResponse");

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/mfa/verify",
      summary: "Complete MFA login",
      description: "Completes login by verifying a TOTP code or recovery code after password authentication. Requires the mfaToken returned from the login endpoint.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                mfaToken: z.string().describe("MFA challenge token from the login response."),
                code: z.string().describe("6-digit TOTP code or 8-character recovery code."),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: MfaLoginResponse } }, description: "MFA verified. Session created." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired MFA token, or invalid code." },
      },
    }),
    async (c) => {
      const { mfaToken, code } = c.req.valid("json");

      const challenge = await consumeMfaChallenge(mfaToken);
      if (!challenge) return c.json({ error: "Invalid or expired MFA token" }, 401);

      const { userId } = challenge;

      // Try TOTP first, then recovery code
      let valid = await MfaService.verifyTotp(userId, code);
      if (!valid) {
        valid = await MfaService.verifyRecoveryCode(userId, code);
      }
      if (!valid) return c.json({ error: "Invalid MFA code" }, 401);

      // Create session — reuse the service helper for refresh token support
      const result = await AuthService.createSessionForUser(userId, {
        ipAddress: (c.req.header("x-forwarded-for")?.split(",")[0]?.trim()) ?? c.req.header("x-real-ip") ?? undefined,
        userAgent: c.req.header("user-agent") ?? undefined,
      });

      const rtConfig = getRefreshTokenConfig();
      setCookie(c, COOKIE_TOKEN, result.token, cookieOptions(rtConfig ? getAccessTokenExpiry() : undefined));
      if (result.refreshToken) {
        setCookie(c, COOKIE_REFRESH_TOKEN, result.refreshToken, cookieOptions(getRefreshTokenExpiry()));
      }

      return c.json({ token: result.token, userId, refreshToken: result.refreshToken }, 200);
    }
  );

  // ─── Disable MFA ──────────────────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "delete",
      path: "/auth/mfa",
      summary: "Disable MFA",
      description: "Disables MFA for the authenticated user. Requires a valid TOTP code to confirm.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                code: z.string().length(6).describe("6-digit TOTP code to confirm disabling MFA."),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "MFA disabled." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid TOTP code or no valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { code } = c.req.valid("json");
      await MfaService.disableMfa(userId, code);
      return c.json({ message: "MFA disabled" }, 200);
    }
  );

  // ─── Regenerate Recovery Codes ────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/mfa/recovery-codes",
      summary: "Regenerate recovery codes",
      description: "Generates new recovery codes, invalidating all previous ones. Requires a valid TOTP code to confirm.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                code: z.string().length(6).describe("6-digit TOTP code to confirm regeneration."),
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
                recoveryCodes: z.array(z.string()).describe("New one-time recovery codes."),
              }),
            },
          },
          description: "New recovery codes generated.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid TOTP code or no valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { code } = c.req.valid("json");
      const recoveryCodes = await MfaService.regenerateRecoveryCodes(userId, code);
      return c.json({ recoveryCodes }, 200);
    }
  );

  return router;
};
