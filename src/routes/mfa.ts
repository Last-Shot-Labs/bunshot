import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { setCookie } from "hono/cookie";
import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import * as MfaService from "@services/mfa";
import * as AuthService from "@services/auth";
import { consumeMfaChallenge, replaceMfaChallengeOtp } from "@lib/mfaChallenge";
import { COOKIE_TOKEN, COOKIE_REFRESH_TOKEN } from "@lib/constants";
import { getRefreshTokenConfig, getAccessTokenExpiry, getRefreshTokenExpiry, getMfaEmailOtpConfig, getMfaWebAuthnConfig } from "@lib/appConfig";
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
      description: "Completes login by verifying a TOTP code, email OTP code, recovery code, or WebAuthn assertion after password authentication. Requires the mfaToken returned from the login endpoint. Optionally specify 'method' to target a specific verification method.",
      tags,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                mfaToken: z.string().describe("MFA challenge token from the login response."),
                code: z.string().optional().describe("6-digit TOTP/email OTP code or 8-character recovery code. Required unless using WebAuthn."),
                method: z.enum(["totp", "emailOtp", "webauthn"]).optional().describe("Specify which MFA method to verify. If omitted, methods are tried automatically."),
                webauthnResponse: z.record(z.string(), z.unknown()).optional().describe("WebAuthn authentication response from navigator.credentials.get(). Pass the entire response object."),
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
      const { mfaToken, code, method, webauthnResponse } = c.req.valid("json");

      if (!code && !webauthnResponse) {
        return c.json({ error: "Either 'code' or 'webauthnResponse' is required" }, 401);
      }

      const challenge = await consumeMfaChallenge(mfaToken);
      if (!challenge) return c.json({ error: "Invalid or expired MFA token" }, 401);

      const { userId, emailOtpHash, webauthnChallenge } = challenge;
      let valid = false;

      if (method === "webauthn" || (!method && webauthnResponse)) {
        // WebAuthn verification
        if (webauthnResponse && webauthnChallenge) {
          valid = await MfaService.verifyWebAuthn(userId, webauthnResponse, webauthnChallenge);
        }
      } else if (method === "totp") {
        // Only try TOTP
        if (code) valid = await MfaService.verifyTotp(userId, code);
      } else if (method === "emailOtp") {
        // Only try email OTP
        if (code && emailOtpHash) valid = MfaService.verifyEmailOtp(emailOtpHash, code);
      } else if (code) {
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

      // Always try recovery code as fallback (code-based only)
      if (!valid && code) {
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

  // ─── WebAuthn / Security Keys ─────────────────────────────────────────────

  if (getMfaWebAuthnConfig()) {
    // Eager dependency check — fail fast at server start
    MfaService.assertWebAuthnDependency().catch((err) => { throw err; });

    router.use("/auth/mfa/webauthn/*", userAuth);

    // Register options
    router.openapi(
      withSecurity(createRoute({
        method: "post",
        path: "/auth/mfa/webauthn/register-options",
        summary: "Generate WebAuthn registration options",
        description: "Generates registration options for the client to pass to navigator.credentials.create(). Returns a registrationToken to confirm registration.",
        tags,
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({
                  options: z.record(z.string(), z.unknown()).describe("PublicKeyCredentialCreationOptions — pass directly to navigator.credentials.create()."),
                  registrationToken: z.string().describe("Token to pass back when completing registration."),
                }),
              },
            },
            description: "Registration options generated.",
          },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "WebAuthn not configured or adapter does not support it." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const userId = c.get("authUserId")!;
        const result = await MfaService.initiateWebAuthnRegistration(userId);
        return c.json(result, 200);
      }
    );

    // Complete registration
    router.openapi(
      withSecurity(createRoute({
        method: "post",
        path: "/auth/mfa/webauthn/register",
        summary: "Complete WebAuthn registration",
        description: "Verifies the attestation response from navigator.credentials.create() and stores the credential. Returns recovery codes.",
        tags,
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  registrationToken: z.string().describe("Token from POST /auth/mfa/webauthn/register-options."),
                  attestationResponse: z.record(z.string(), z.unknown()).describe("Full response from navigator.credentials.create()."),
                  name: z.string().optional().describe("User-friendly name for the key (e.g. 'YubiKey 5')."),
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
                  credentialId: z.string(),
                  recoveryCodes: z.array(z.string()).nullable().describe("Recovery codes (always returned when WebAuthn is enabled)."),
                }),
              },
            },
            description: "Security key registered.",
          },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid registration token or verification failed." },
          409: { content: { "application/json": { schema: ErrorResponse } }, description: "Security key already registered to another account." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "WebAuthn not configured or adapter does not support it." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const userId = c.get("authUserId")!;
        const { registrationToken, attestationResponse, name } = c.req.valid("json");
        const result = await MfaService.completeWebAuthnRegistration(userId, registrationToken, attestationResponse, name);
        return c.json({ message: "Security key registered", ...result }, 200);
      }
    );

    // List credentials
    router.openapi(
      withSecurity(createRoute({
        method: "get",
        path: "/auth/mfa/webauthn/credentials",
        summary: "List WebAuthn credentials",
        description: "Returns the security keys registered for the authenticated user. Does not include private key data.",
        tags,
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({
                  credentials: z.array(z.object({
                    credentialId: z.string(),
                    name: z.string().optional(),
                    createdAt: z.number(),
                    transports: z.array(z.string()).optional(),
                  })),
                }),
              },
            },
            description: "List of registered security keys.",
          },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "No valid session." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const userId = c.get("authUserId")!;
        const adapter = getAuthAdapter();
        const creds = adapter.getWebAuthnCredentials ? await adapter.getWebAuthnCredentials(userId) : [];
        return c.json({
          credentials: creds.map((cr) => ({
            credentialId: cr.credentialId,
            name: cr.name,
            createdAt: cr.createdAt,
            transports: cr.transports,
          })),
        }, 200);
      }
    );

    // Remove a single credential
    router.openapi(
      withSecurity(createRoute({
        method: "delete",
        path: "/auth/mfa/webauthn/credentials/{credentialId}",
        summary: "Remove a WebAuthn credential",
        description: "Removes a single security key. Identity verification is only required when removing the last MFA credential.",
        tags,
        request: {
          params: z.object({ credentialId: z.string() }),
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  code: z.string().optional().describe("TOTP code (required when removing the last MFA credential, if TOTP is enabled)."),
                  password: z.string().optional().describe("Password (required when removing the last MFA credential, if no TOTP)."),
                }),
              },
            },
          },
        },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Credential removed." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing required verification." },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid code/password or no valid session." },
          404: { content: { "application/json": { schema: ErrorResponse } }, description: "Credential not found." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "Adapter does not support WebAuthn." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const userId = c.get("authUserId")!;
        const { credentialId } = c.req.valid("param");
        const { code, password } = c.req.valid("json");
        await MfaService.removeWebAuthnCredential(userId, credentialId, { code, password });
        return c.json({ message: "Credential removed" }, 200);
      }
    );

    // Disable WebAuthn entirely
    router.openapi(
      withSecurity(createRoute({
        method: "delete",
        path: "/auth/mfa/webauthn",
        summary: "Disable WebAuthn MFA",
        description: "Removes all WebAuthn credentials and disables WebAuthn as an MFA method. Requires identity verification.",
        tags,
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  code: z.string().optional().describe("TOTP code (if TOTP is enabled)."),
                  password: z.string().optional().describe("Password (if TOTP is not enabled)."),
                }),
              },
            },
          },
        },
        responses: {
          200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "WebAuthn disabled." },
          400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing required verification." },
          401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid code/password or no valid session." },
          501: { content: { "application/json": { schema: ErrorResponse } }, description: "Adapter does not support WebAuthn." },
        },
      }), { cookieAuth: [] }, { userToken: [] }),
      async (c) => {
        const userId = c.get("authUserId")!;
        const { code, password } = c.req.valid("json");
        await MfaService.disableWebAuthn(userId, { code, password });
        return c.json({ message: "WebAuthn disabled" }, 200);
      }
    );
  }

  return router;
};
