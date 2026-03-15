export interface OAuthProfile {
  email?: string;
  name?: string;
  avatarUrl?: string;
}

export interface AuthAdapter {
  findByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>;
  create(email: string, passwordHash: string): Promise<{ id: string }>;
  /** Required when using OAuth providers. Find or create a user by provider + provider user ID. */
  findOrCreateByProvider?(provider: string, providerId: string, profile: OAuthProfile): Promise<{ id: string; created: boolean }>;
  /** Optional. Set or update the password hash for a user (used by /auth/set-password). */
  setPassword?(userId: string, passwordHash: string): Promise<void>;
  /** Optional. Link a provider identity to an existing user (used by /auth/:provider/link). */
  linkProvider?(userId: string, provider: string, providerId: string): Promise<void>;
  /** Optional. Return the roles assigned to a user (used by requireRole middleware). */
  getRoles?(userId: string): Promise<string[]>;
  /** Optional. Set the roles for a user, replacing any existing roles. */
  setRoles?(userId: string, roles: string[]): Promise<void>;
  /** Optional. Add a single role to a user without affecting their other roles. */
  addRole?(userId: string, role: string): Promise<void>;
  /** Optional. Remove a single role from a user without affecting their other roles. */
  removeRole?(userId: string, role: string): Promise<void>;
  /** Optional. Return basic profile info for a user by ID (used by GET /auth/me). */
  getUser?(userId: string): Promise<{ email?: string; providerIds?: string[]; emailVerified?: boolean } | null>;
  /** Optional. Unlink a provider identity from a user (used by DELETE /auth/:provider/link). */
  unlinkProvider?(userId: string, provider: string): Promise<void>;
  /**
   * Optional. Look up a user by their primary identifier (email, username, or phone depending on config).
   * When provided, used instead of findByEmail for credential login/register flows.
   */
  findByIdentifier?(value: string): Promise<{ id: string; passwordHash: string } | null>;
  /** Optional. Mark a user's email address as verified (used by POST /auth/verify-email). */
  setEmailVerified?(userId: string, verified: boolean): Promise<void>;
  /** Optional. Return whether a user's email address has been verified. */
  getEmailVerified?(userId: string): Promise<boolean>;
  /** Optional. Permanently delete a user account. Used by DELETE /auth/me. */
  deleteUser?(userId: string): Promise<void>;
  /** Optional. Check whether a user has a password set (credential account vs OAuth-only). */
  hasPassword?(userId: string): Promise<boolean>;
  /** Optional. Store the TOTP secret for MFA setup (encrypted or plaintext, adapter decides). */
  setMfaSecret?(userId: string, secret: string | null): Promise<void>;
  /** Optional. Retrieve the TOTP secret for MFA verification. */
  getMfaSecret?(userId: string): Promise<string | null>;
  /** Optional. Check whether MFA is enabled for a user. */
  isMfaEnabled?(userId: string): Promise<boolean>;
  /** Optional. Enable or disable MFA for a user. */
  setMfaEnabled?(userId: string, enabled: boolean): Promise<void>;
  /** Optional. Store hashed recovery codes for MFA. */
  setRecoveryCodes?(userId: string, codes: string[]): Promise<void>;
  /** Optional. Retrieve hashed recovery codes for MFA. */
  getRecoveryCodes?(userId: string): Promise<string[]>;
  /** Optional. Remove a single recovery code after use. */
  removeRecoveryCode?(userId: string, code: string): Promise<void>;
  /** Optional. Get the MFA methods enabled for a user (e.g., ["totp"], ["emailOtp"], ["totp", "emailOtp"]). */
  getMfaMethods?(userId: string): Promise<string[]>;
  /** Optional. Set the MFA methods enabled for a user. */
  setMfaMethods?(userId: string, methods: string[]): Promise<void>;
  /** Optional. Get roles for a user within a specific tenant. */
  getTenantRoles?(userId: string, tenantId: string): Promise<string[]>;
  /** Optional. Set roles for a user within a specific tenant (replaces existing). */
  setTenantRoles?(userId: string, tenantId: string, roles: string[]): Promise<void>;
  /** Optional. Add a single role to a user within a specific tenant. */
  addTenantRole?(userId: string, tenantId: string, role: string): Promise<void>;
  /** Optional. Remove a single role from a user within a specific tenant. */
  removeTenantRole?(userId: string, tenantId: string, role: string): Promise<void>;
}

let _adapter: AuthAdapter | null = null;

export const setAuthAdapter = (adapter: AuthAdapter) => { _adapter = adapter; };

export const getAuthAdapter = (): AuthAdapter => {
  if (!_adapter) throw new Error("No auth adapter set — pass authAdapter to createApp/createServer, or call setAuthAdapter()");
  return _adapter;
};
