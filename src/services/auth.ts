import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { signToken, verifyToken } from "@lib/jwt";
import { createSession, deleteSession, getActiveSessionCount, evictOldestSession } from "@lib/session";
import type { SessionMetadata } from "@lib/session";
import { getDefaultRole, getPrimaryField, getEmailVerificationConfig, getMaxSessions } from "@lib/appConfig";
import { createVerificationToken } from "@lib/emailVerification";

export const register = async (identifier: string, password: string, metadata?: SessionMetadata): Promise<{ token: string; userId: string; email?: string }> => {
  const hashed = await Bun.password.hash(password);
  const adapter = getAuthAdapter();
  const user = await adapter.create(identifier, hashed);
  const role = getDefaultRole();
  if (role) await adapter.setRoles!(user.id, [role]);

  const sessionId = crypto.randomUUID();
  const token = await signToken(user.id, sessionId);
  while (await getActiveSessionCount(user.id) >= getMaxSessions()) {
    await evictOldestSession(user.id);
  }
  await createSession(user.id, token, sessionId, metadata);

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email") {
    try {
      const verificationToken = await createVerificationToken(user.id, identifier);
      await evConfig.onSend(identifier, verificationToken);
    } catch (e) {
      console.error("[email-verification] Failed to send verification email:", e);
    }
  }

  return { token, userId: user.id, email: identifier };
};

export const login = async (identifier: string, password: string, metadata?: SessionMetadata): Promise<{ token: string; userId: string; email?: string; emailVerified?: boolean; googleLinked?: boolean }> => {
  const adapter = getAuthAdapter();
  const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
  const user = await findFn(identifier);
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid credentials");
  }

  const sessionId = crypto.randomUUID();
  const token = await signToken(user.id, sessionId);
  while (await getActiveSessionCount(user.id) >= getMaxSessions()) {
    await evictOldestSession(user.id);
  }

  const fullUser = adapter.getUser ? await adapter.getUser(user.id) : null;
  const googleLinked = fullUser?.providerIds?.some((id) => id.startsWith("google:")) ?? false;

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email" && adapter.getEmailVerified) {
    const verified = await adapter.getEmailVerified(user.id);
    if (evConfig.required && !verified) {
      throw new HttpError(403, "Email not verified");
    }
    await createSession(user.id, token, sessionId, metadata);
    return { token, userId: user.id, email: user.email, emailVerified: verified, googleLinked };
  }

  await createSession(user.id, token, sessionId, metadata);
  return { token, userId: user.id, email: user.email, googleLinked };
};

export const logout = async (token: string | null) => {
  if (token) {
    const payload = await verifyToken(token);
    const sessionId = payload.sid as string | undefined;
    if (sessionId) await deleteSession(sessionId);
  }
};
