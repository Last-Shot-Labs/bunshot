import { AuthUser } from "@models/AuthUser";
import { TenantRole } from "@models/TenantRole";
import { HttpError } from "@lib/HttpError";
import type { AuthAdapter, WebAuthnCredential } from "@lib/authAdapter";

export const mongoAuthAdapter: AuthAdapter = {
  async findByEmail(email) {
    const user = await AuthUser.findOne({ email });
    if (!user) return null;
    return { id: String(user._id), passwordHash: user.password as string };
  },
  async create(email, passwordHash) {
    try {
      const user = await AuthUser.create({ email, password: passwordHash });
      return { id: String(user._id) };
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, "Email already registered");
      throw err;
    }
  },
  async setPassword(userId, passwordHash) {
    await AuthUser.findByIdAndUpdate(userId, { password: passwordHash });
  },
  async findOrCreateByProvider(provider, providerId, profile) {
    const key = `${provider}:${providerId}`;

    // Find by provider key
    let user = await AuthUser.findOne({ providerIds: key });
    if (user) return { id: String(user._id), created: false };

    // Reject if the email belongs to a credential account — user must link manually
    if (profile.email) {
      const existing = await AuthUser.findOne({ email: profile.email });
      if (existing) throw new HttpError(409, "An account with this email already exists. Sign in with your credentials, then link Google from your account settings.");
    }

    // Create new user
    user = await AuthUser.create({ email: profile.email, providerIds: [key] });
    return { id: String(user._id), created: true };
  },
  async linkProvider(userId, provider, providerId) {
    const key = `${provider}:${providerId}`;
    const user = await AuthUser.findById(userId);
    if (!user) throw new HttpError(404, "User not found");
    if (!(user.providerIds as string[]).includes(key)) {
      user.providerIds = [...(user.providerIds as string[]), key];
      await user.save();
    }
  },
  async getRoles(userId) {
    const user = await AuthUser.findById(userId, "roles").lean();
    return (user?.roles as string[]) ?? [];
  },
  async setRoles(userId, roles) {
    await AuthUser.findByIdAndUpdate(userId, { roles });
  },
  async addRole(userId, role) {
    await AuthUser.findByIdAndUpdate(userId, { $addToSet: { roles: role } });
  },
  async removeRole(userId, role) {
    await AuthUser.findByIdAndUpdate(userId, { $pull: { roles: role } });
  },
  async getUser(userId) {
    const user = await AuthUser.findById(userId, "email providerIds emailVerified").lean();
    if (!user) return null;
    return {
      email: user.email as string | undefined,
      providerIds: user.providerIds as string[] | undefined,
      emailVerified: (user.emailVerified as boolean | undefined) ?? false,
    };
  },
  async unlinkProvider(userId, provider) {
    const user = await AuthUser.findById(userId);
    if (!user) throw new HttpError(404, "User not found");
    user.providerIds = (user.providerIds as string[]).filter(
      (id) => !id.startsWith(`${provider}:`)
    );
    await user.save();
  },
  async findByIdentifier(value) {
    const user = await AuthUser.findOne({ email: value });
    if (!user) return null;
    return { id: String(user._id), passwordHash: user.password as string };
  },
  async setEmailVerified(userId, verified) {
    await AuthUser.findByIdAndUpdate(userId, { emailVerified: verified });
  },
  async getEmailVerified(userId) {
    const user = await AuthUser.findById(userId, "emailVerified").lean();
    return (user?.emailVerified as boolean | undefined) ?? false;
  },
  async deleteUser(userId) {
    await AuthUser.findByIdAndDelete(userId);
  },
  async hasPassword(userId) {
    const user = await AuthUser.findById(userId, "password").lean();
    return !!user?.password;
  },
  async setMfaSecret(userId, secret) {
    await AuthUser.findByIdAndUpdate(userId, { mfaSecret: secret });
  },
  async getMfaSecret(userId) {
    const user = await AuthUser.findById(userId, "mfaSecret").lean();
    return (user?.mfaSecret as string | undefined) ?? null;
  },
  async isMfaEnabled(userId) {
    const user = await AuthUser.findById(userId, "mfaEnabled").lean();
    return (user?.mfaEnabled as boolean | undefined) ?? false;
  },
  async setMfaEnabled(userId, enabled) {
    await AuthUser.findByIdAndUpdate(userId, { mfaEnabled: enabled });
  },
  async setRecoveryCodes(userId, codes) {
    await AuthUser.findByIdAndUpdate(userId, { recoveryCodes: codes });
  },
  async getRecoveryCodes(userId) {
    const user = await AuthUser.findById(userId, "recoveryCodes").lean();
    return (user?.recoveryCodes as string[] | undefined) ?? [];
  },
  async removeRecoveryCode(userId, code) {
    await AuthUser.findByIdAndUpdate(userId, { $pull: { recoveryCodes: code } });
  },
  async getMfaMethods(userId) {
    const user = await AuthUser.findById(userId, "mfaMethods mfaEnabled").lean();
    const methods = (user?.mfaMethods as string[] | undefined) ?? [];
    // Backward compat: if mfaEnabled but no methods recorded, assume TOTP
    if (methods.length === 0 && (user?.mfaEnabled as boolean | undefined)) return ["totp"];
    return methods;
  },
  async setMfaMethods(userId, methods) {
    await AuthUser.findByIdAndUpdate(userId, { mfaMethods: methods });
  },
  async getWebAuthnCredentials(userId) {
    const user = await AuthUser.findById(userId, "webauthnCredentials").lean();
    const creds = (user as any)?.webauthnCredentials ?? [];
    return creds.map((c: any) => ({
      credentialId: c.credentialId as string,
      publicKey: c.publicKey as string,
      signCount: c.signCount as number,
      transports: c.transports as string[] | undefined,
      name: c.name as string | undefined,
      createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : (c.createdAt as number),
    }));
  },
  async addWebAuthnCredential(userId, credential) {
    await AuthUser.findByIdAndUpdate(userId, {
      $push: {
        webauthnCredentials: {
          credentialId: credential.credentialId,
          publicKey: credential.publicKey,
          signCount: credential.signCount,
          transports: credential.transports,
          name: credential.name,
          createdAt: new Date(credential.createdAt),
        },
      },
    });
  },
  async removeWebAuthnCredential(userId, credentialId) {
    await AuthUser.findByIdAndUpdate(userId, {
      $pull: { webauthnCredentials: { credentialId } },
    });
  },
  async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
    await AuthUser.findOneAndUpdate(
      { _id: userId, "webauthnCredentials.credentialId": credentialId },
      { $set: { "webauthnCredentials.$.signCount": signCount } }
    );
  },
  async findUserByWebAuthnCredentialId(credentialId) {
    const user = await AuthUser.findOne(
      { "webauthnCredentials.credentialId": credentialId },
      "_id"
    ).lean();
    return user ? String(user._id) : null;
  },
  async getTenantRoles(userId, tenantId) {
    const doc = await TenantRole.findOne({ userId, tenantId }, "roles").lean();
    return (doc?.roles as string[]) ?? [];
  },
  async setTenantRoles(userId, tenantId, roles) {
    await TenantRole.findOneAndUpdate(
      { userId, tenantId },
      { roles },
      { upsert: true }
    );
  },
  async addTenantRole(userId, tenantId, role) {
    await TenantRole.findOneAndUpdate(
      { userId, tenantId },
      { $addToSet: { roles: role } },
      { upsert: true }
    );
  },
  async removeTenantRole(userId, tenantId, role) {
    await TenantRole.findOneAndUpdate(
      { userId, tenantId },
      { $pull: { roles: role } }
    );
  },
};
