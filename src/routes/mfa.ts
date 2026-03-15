import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { setCookie } from "hono/cookie";
import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import * as MfaService from "@services/mfa";
import * as AuthService from "@services/auth";
import { consumeMfaChallenge, replaceMfaChallengeOtp } from "@lib/mfaChallenge";
import { COOKIE_TOKEN, COOKIE_REFRESH_TOKEN } from "@lib/constants";
import { getRefreshTokenConfig, getAccessTokenExpiry, getRefreshTokenExpiry, getMfaEmailOtpConfig } from "@lib/appConfig";
import { getAuthAdapter } from "@lib/authAdapter";

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
  router.use("/auth/mfa/email-otp/enable", userAuth);
  router.use("/auth/mfa/email-otp/verify-setup", userAuth);
  router.use("/auth/mfa/email-otp", userAuth);
  router.use("/auth/mfa/methods", userAuth);

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
      description: "Verifies a TOTP code from the authenticator app and enables MFA. Returns one-time recovery codes that should be stored securely. If email OTP was previously enabled, recovery codes are regenerated.",
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
      description: "Completes login by verifying a TOTP code, email OTP code, or recovery code after password authentication. Requires the mfaToken returned from the login endpoint. Optionally specify 'method' to target a specific verification method.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                mfaToken: z.string().describe("MFA challenge token from the login response."),
                code: z.string().describe("6-digit TOTP/email OTP code or 8-character recovery code."),
                method: z.enum(["totp", "emailOtp"]).optional().describe("Specify which MFA method to verify. If omitted, methods are tried automatically."),
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
      const { mfaToken, code, method } = c.req.valid("json");

      const challenge = await consumeMfaChallenge(mfaToken);
      if (!challenge) return c.json({ error: "Invalid or expired MFA token" }, 401);

      const { userId, emailOtpHash } = challenge;
      let valid = false;

      if (method === "totp") {
        // Only try TOTP
        valid = await MfaService.verifyTotp(userId, code);
      } else if (method === "emailOtp") {
        // Only try email OTP
        if (emailOtpHash) valid = MfaService.verifyEmailOtp(emailOtpHash, code);
      } else {
        // Auto-detect: use emailOtpHash presence to pick order
        if (emailOtpHash) {
          // Email OTP first, then TOTP, then recovery
          valid = MfaService.verifyEmailOtp(emailOtpHash, code);
          if (!valid) valid = await MfaService.verifyTotp(userId, code);
        } else {
          // TOTP first
          valid = await MfaService.verifyTotp(userId, code);
        }
      }

      // Always try recovery code as fallback
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

  // ─── Email OTP: Enable (initiate) ────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/mfa/email-otp/enable",
      summary: "Initiate email OTP setup",
      description: "Sends a verification code to the user's email to confirm email OTP setup. Confirm via POST /auth/mfa/email-otp/verify-setup.",
      tags,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                message: z.string(),
                setupToken: z.string().describe("Setup challenge token. Pass to POST /auth/mfa/email-otp/verify-setup with the code."),
              }),
            },
          },
          description: "Verification code sent to email.",
        },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "No email address on account." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Email OTP is not configured." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const setupToken = await MfaService.initiateEmailOtp(userId);
      return c.json({ message: "Verification code sent", setupToken }, 200);
    }
  );

  // ─── Email OTP: Verify Setup ─────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "post",
      path: "/auth/mfa/email-otp/verify-setup",
      summary: "Confirm email OTP setup",
      description: "Verifies the code sent during email OTP initiation and enables email OTP as an MFA method. Returns recovery codes (new or regenerated if another MFA method was already active).",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                setupToken: z.string().describe("Setup challenge token from POST /auth/mfa/email-otp/enable."),
                code: z.string().describe("Verification code sent to email."),
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
                recoveryCodes: z.array(z.string()).optional().describe("Recovery codes (always returned when email OTP is enabled)."),
              }),
            },
          },
          description: "Email OTP enabled.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid setup token or code." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { setupToken, code } = c.req.valid("json");
      const recoveryCodes = await MfaService.confirmEmailOtp(userId, setupToken, code);
      return c.json({ message: "Email OTP enabled", recoveryCodes: recoveryCodes ?? undefined }, 200);
    }
  );

  // ─── Email OTP: Disable ──────────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "delete",
      path: "/auth/mfa/email-otp",
      summary: "Disable email OTP",
      description: "Disables email OTP for the authenticated user. Requires a TOTP code if TOTP is also enabled, or a password if email OTP is the only MFA method.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                code: z.string().optional().describe("6-digit TOTP code (required when TOTP is also enabled)."),
                password: z.string().optional().describe("Account password (required when email OTP is the only MFA method)."),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Email OTP disabled." },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing required verification." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid code/password or no valid session." },
        501: { content: { "application/json": { schema: ErrorResponse } }, description: "Auth adapter does not support MFA." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const { code, password } = c.req.valid("json");
      await MfaService.disableEmailOtp(userId, { code, password });
      return c.json({ message: "Email OTP disabled" }, 200);
    }
  );

  // ─── Resend Email OTP ────────────────────────────────────────────────────

  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/mfa/resend",
      summary: "Resend email OTP code",
      description: "Generates and sends a new email OTP code for the given MFA challenge. Rate-limited to 3 resends per challenge. Does not extend the challenge beyond 3x the original TTL.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                mfaToken: z.string().describe("MFA challenge token from the login response."),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Code sent." },
        400: { content: { "application/json": { schema: ErrorResponse } }, description: "Email OTP not configured." },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired MFA token." },
        429: { content: { "application/json": { schema: ErrorResponse } }, description: "Maximum resends reached." },
      },
    }),
    async (c) => {
      const { mfaToken } = c.req.valid("json");
      const emailOtpConfig = getMfaEmailOtpConfig();
      if (!emailOtpConfig) return c.json({ error: "Email OTP is not configured" }, 400);

      const { code, hash } = MfaService.generateEmailOtpCode();
      const result = await replaceMfaChallengeOtp(mfaToken, hash);
      if (!result) return c.json({ error: "Invalid/expired MFA token or maximum resends reached" }, 401);

      // Get user email and send
      const adapter = getAuthAdapter();
      const user = adapter.getUser ? await adapter.getUser(result.userId) : null;
      if (user?.email) {
        await emailOtpConfig.onSend(user.email, code);
      }

      return c.json({ message: "Code sent" }, 200);
    }
  );

  // ─── Get MFA Methods ────────────────────────────────────────────────────

  router.openapi(
    withSecurity(createRoute({
      method: "get",
      path: "/auth/mfa/methods",
      summary: "Get enabled MFA methods",
      description: "Returns the MFA methods currently enabled for the authenticated user.",
      tags,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                methods: z.array(z.string()).describe("Enabled MFA methods (e.g., 'totp', 'emailOtp')."),
              }),
            },
          },
          description: "Enabled MFA methods.",
        },
        401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
      },
    }), { cookieAuth: [] }, { userToken: [] }),
    async (c) => {
      const userId = c.get("authUserId")!;
      const methods = await MfaService.getMfaMethods(userId);
      return c.json({ methods }, 200);
    }
  );

  return router;
};
