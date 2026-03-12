import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { signToken, verifyToken } from "@lib/jwt";
import { createSession, deleteSession } from "@lib/session";
import { getDefaultRole, getPrimaryField, getEmailVerificationConfig } from "@lib/appConfig";
import { createVerificationToken } from "@lib/emailVerification";

export const register = async (identifier: string, password: string): Promise<string> => {
  const hashed = await Bun.password.hash(password);
  const adapter = getAuthAdapter();
  const user = await adapter.create(identifier, hashed);
  const role = getDefaultRole();
  if (role) await adapter.setRoles!(user.id, [role]);
  const token = await signToken(user.id);
  await createSession(user.id, token);

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email") {
    try {
      const verificationToken = await createVerificationToken(user.id, identifier);
      await evConfig.onSend(identifier, verificationToken);
    } catch (e) {
      console.error("[email-verification] Failed to send verification email:", e);
    }
  }

  return token;
};

export const login = async (identifier: string, password: string): Promise<{ token: string; emailVerified?: boolean }> => {
  const adapter = getAuthAdapter();
  const findFn = adapter.findByIdentifier ?? adapter.findByEmail.bind(adapter);
  const user = await findFn(identifier);
  if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid credentials");
  }

  const evConfig = getEmailVerificationConfig();
  if (evConfig && getPrimaryField() === "email" && adapter.getEmailVerified) {
    const verified = await adapter.getEmailVerified(user.id);
    if (evConfig.required && !verified) {
      throw new HttpError(403, "Email not verified");
    }
    const token = await signToken(user.id);
    await createSession(user.id, token);
    return { token, emailVerified: verified };
  }

  const token = await signToken(user.id);
  await createSession(user.id, token);
  return { token };
};

export const logout = async (token: string | null) => {
  if (token) {
    const payload = await verifyToken(token);
    await deleteSession(payload.sub!);
  }
};
