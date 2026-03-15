import { AuthUser } from "@models/AuthUser";
import { HttpError } from "@lib/HttpError";
import type { AuthAdapter } from "@lib/authAdapter";

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
};
