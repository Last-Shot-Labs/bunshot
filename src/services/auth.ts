import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { signToken, verifyToken } from "@lib/jwt";
import { createSession, deleteSession, getActiveSessionCount, evictOldestSession, deleteUserSessions, setRefreshToken, getSessionByRefreshToken, rotateRefreshToken } from "@lib/session";
import type { SessionMetadata } from "@lib/session";
import { getDefaultRole, getPrimaryField, getEmailVerificationConfig, getMaxSessions, getRefreshTokenConfig, getAccessTokenExpiry, getRefreshTokenExpiry, getMfaConfig, getMfaEmailOtpConfig } from "@lib/appConfig";
import { createVerificationToken } from "@lib/emailVerification";
import { createMfaChallenge } from "@lib/mfaChallenge";
import { generateEmailOtpCode } from "@services/mfa";

export interface AuthResult {
  token: string;
  userId: string;
  email?: string;
  emailVerified?: boolean;
  googleLinked?: boolean;
  refreshToken?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethods?: string[];
}

async function createSessionWithRefreshToken(userId: string, sessionId: string, metadata?: SessionMetadata): Promise<{ token: string; refreshToken?: string; sessionId: string }> {
  const rtConfig = getRefreshTokenConfig();
  const expirySeconds = rtConfig ? getAccessTokenExpiry() : undefined;
  const token = await signToken(userId, sessionId, expirySeconds);

  while (await getActiveSessionCount(userId) >= getMaxSessions()) {
    await evictOldestSession(userId);
  }
  await createSession(userId, token, sessionId, metadata);

  let refreshToken: string | undefined;
  if (rtConfig) {
    refreshToken = crypto.randomUUID();
    await setRefreshToken(sessionId, refreshToken);
  }

  return { token, refreshToken, sessionId };
}

/** Create a session for a user (used internally and by MFA verify). */
export const createSessionForUser = async (userId: string, metadata?: SessionMetadata): Promise<{ token: string; refreshToken?: string }> => {
  const sessionId = crypto.randomUUID();
  return createSessionWithRefreshToken(userId, sessionId, metadata);
};

export const register = async (identifier: string, password: string, metadata?: SessionMetadata): Promise<AuthResult> => {
  const hashed = await Bun.password.hash(password);
  const adapter = getAuthAdapter();
  const user = await adapter.create(identifier, hashed);
  const role = getDefaultRole();
  if (role) await adapter.setRoles!(user.id, [role]);

  const sessionId = crypto.randomUUID();
  const { token, refreshToken } = await createSessionWithRefreshToken(user.id, sessionId, metadata);

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email") {
    try {
      const verificationToken = await createVerificationToken(user.id, identifier);
      await evConfig.onSend(identifier, verificationToken);
    } catch (e) {
      console.error("[email-verification] Failed to send verification email:", e);
    }
  }

  return { token, userId: user.id, email: identifier, refreshToken };
};

export const login = async (identifier: string, password: string, metadata?: SessionMetadata): Promise<AuthResult> => {
  const adapter = getAuthAdapter();
  const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
  const user = await findFn(identifier);
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid credentials");
  }

  // Check email verification before MFA to avoid leaking MFA status to unverified users
  const fullUser = adapter.getUser ? await adapter.getUser(user.id) : null;
  const googleLinked = fullUser?.providerIds?.some((id) => id.startsWith("google:")) ?? false;

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email" && adapter.getEmailVerified) {
    const verified = await adapter.getEmailVerified(user.id);
    if (evConfig.required && !verified) {
      throw new HttpError(403, "Email not verified");
    }
  }

  // Check MFA — if enabled, return challenge token instead of session
  if (getMfaConfig() && adapter.isMfaEnabled && await adapter.isMfaEnabled(user.id)) {
    const methods = adapter.getMfaMethods
      ? await adapter.getMfaMethods(user.id)
      : ["totp"];

    // Auto-send email OTP if enabled
    let emailOtpHash: string | undefined;
    const emailOtpConfig = getMfaEmailOtpConfig();
    if (methods.includes("emailOtp") && emailOtpConfig) {
      const { code, hash } = generateEmailOtpCode();
      emailOtpHash = hash;
      const email = fullUser?.email;
      if (email) await emailOtpConfig.onSend(email, code);
    }

    const mfaToken = await createMfaChallenge(user.id, emailOtpHash);
    return { token: "", userId: user.id, mfaRequired: true, mfaToken, mfaMethods: methods };
  }

  const sessionId = crypto.randomUUID();
  const { token, refreshToken } = await createSessionWithRefreshToken(user.id, sessionId, metadata);

  if (evConfig && getPrimaryField() === "email" && adapter.getEmailVerified) {
    const verified = await adapter.getEmailVerified(user.id);
    return { token, userId: user.id, email: fullUser?.email, emailVerified: verified, googleLinked, refreshToken };
  }

  return { token, userId: user.id, email: fullUser?.email, googleLinked, refreshToken };
};

export const refresh = async (refreshTokenValue: string): Promise<{ token: string; refreshToken: string; userId: string }> => {
  const result = await getSessionByRefreshToken(refreshTokenValue);
  if (!result) {
    throw new HttpError(401, "Invalid or expired refresh token");
  }

  const { sessionId, userId, newRefreshToken } = result;

  // If the returned newRefreshToken differs from what was sent, we're in a grace window replay.
  // Return the current tokens without rotating again.
  if (newRefreshToken !== refreshTokenValue) {
    const accessToken = await signToken(userId, sessionId, getAccessTokenExpiry());
    return { token: accessToken, refreshToken: newRefreshToken, userId };
  }

  // Normal rotation: generate new refresh + access tokens
  const newRT = crypto.randomUUID();
  const newAccessToken = await signToken(userId, sessionId, getAccessTokenExpiry());
  await rotateRefreshToken(sessionId, newRT, newAccessToken);

  return { token: newAccessToken, refreshToken: newRT, userId };
};

export const deleteAccount = async (userId: string, password?: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.deleteUser) {
    throw new HttpError(501, "Auth adapter does not support deleteUser");
  }

  // Verify password for credential accounts
  if (password) {
    const user = adapter.getUser ? await adapter.getUser(userId) : null;
    const email = user?.email;
    if (email) {
      const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
      const found = await findFn(email);
      if (found && !(await Bun.password.verify(password, found.passwordHash))) {
        throw new HttpError(401, "Invalid password");
      }
    }
  } else if (adapter.hasPassword && await adapter.hasPassword(userId)) {
    throw new HttpError(400, "Password is required to delete a credential account");
  }

  // Revoke all sessions
  await deleteUserSessions(userId);

  // Delete the user
  await adapter.deleteUser(userId);
};

export const logout = async (token: string | null) => {
  if (token) {
    const payload = await verifyToken(token);
    const sessionId = payload.sid as string | undefined;
    if (sessionId) await deleteSession(sessionId);
  }
};
