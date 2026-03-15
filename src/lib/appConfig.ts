export type PrimaryField = "email" | "username" | "phone";

export interface EmailVerificationConfig {
  /** Block login until email is verified. Defaults to false (soft gate — emailVerified returned in login response). */
  required?: boolean;
  /** Token time-to-live in seconds. Defaults to 86 400 (24 hours). */
  tokenExpiry?: number;
  /** Called after registration with the identifier and verification token. Use to send the email. */
  onSend: (email: string, token: string) => Promise<void>;
}

export interface PasswordResetConfig {
  /** Token time-to-live in seconds. Defaults to 3 600 (1 hour). */
  tokenExpiry?: number;
  /** Called with the user's email and the reset token. Use to send the reset email. */
  onSend: (email: string, token: string) => Promise<void>;
}

let appName = "Core API";
let appRoles: string[] = [];
let defaultRole: string | null = null;
let _primaryField: PrimaryField = "email";
let _emailVerificationConfig: EmailVerificationConfig | null = null;
let _passwordResetConfig: PasswordResetConfig | null = null;

export const setAppName = (name: string) => { appName = name; };
export const getAppName = () => appName;

export const setAppRoles = (roles: string[]) => { appRoles = roles; };
export const getAppRoles = () => appRoles;

export const setDefaultRole = (role: string | null) => { defaultRole = role; };
export const getDefaultRole = () => defaultRole;

export const setPrimaryField = (field: PrimaryField) => { _primaryField = field; };
export const getPrimaryField = () => _primaryField;

export const setEmailVerificationConfig = (config: EmailVerificationConfig | null) => { _emailVerificationConfig = config; };
export const getEmailVerificationConfig = () => _emailVerificationConfig;

const DEFAULT_TOKEN_EXPIRY = 60 * 60 * 24; // 24 hours
export const getTokenExpiry = (): number => _emailVerificationConfig?.tokenExpiry ?? DEFAULT_TOKEN_EXPIRY;

export const setPasswordResetConfig = (config: PasswordResetConfig | null) => { _passwordResetConfig = config; };
export const getPasswordResetConfig = () => _passwordResetConfig;

const DEFAULT_RESET_TOKEN_EXPIRY = 60 * 60; // 1 hour
export const getResetTokenExpiry = (): number => _passwordResetConfig?.tokenExpiry ?? DEFAULT_RESET_TOKEN_EXPIRY;

// ---------------------------------------------------------------------------
// Session policy
// ---------------------------------------------------------------------------

let _maxSessions = 6;
let _persistSessionMetadata = true;
let _includeInactiveSessions = false;
let _trackLastActive = false;

export const setMaxSessions = (n: number) => { _maxSessions = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1; };
export const getMaxSessions = () => _maxSessions;

export const setPersistSessionMetadata = (v: boolean) => { _persistSessionMetadata = v; };
export const getPersistSessionMetadata = () => _persistSessionMetadata;

export const setIncludeInactiveSessions = (v: boolean) => { _includeInactiveSessions = v; };
export const getIncludeInactiveSessions = () => _includeInactiveSessions;

export const setTrackLastActive = (v: boolean) => { _trackLastActive = v; };
export const getTrackLastActive = () => _trackLastActive;

// ---------------------------------------------------------------------------
// Refresh token config
// ---------------------------------------------------------------------------

export interface RefreshTokenConfig {
  /** Access token expiry in seconds. Default: 900 (15 min). */
  accessTokenExpiry?: number;
  /** Refresh token expiry in seconds. Default: 2_592_000 (30 days). */
  refreshTokenExpiry?: number;
  /** Grace window in seconds where the old refresh token still works after rotation.
   *  Prevents lockout when the client's network drops mid-refresh. Default: 30. */
  rotationGraceSeconds?: number;
}

let _refreshTokenConfig: RefreshTokenConfig | null = null;

export const setRefreshTokenConfig = (config: RefreshTokenConfig | null) => { _refreshTokenConfig = config; };
export const getRefreshTokenConfig = () => _refreshTokenConfig;

const DEFAULT_ACCESS_TOKEN_EXPIRY = 900; // 15 min
const DEFAULT_REFRESH_TOKEN_EXPIRY = 2_592_000; // 30 days
const DEFAULT_ROTATION_GRACE_SECONDS = 30;

export const getAccessTokenExpiry = (): number => _refreshTokenConfig?.accessTokenExpiry ?? DEFAULT_ACCESS_TOKEN_EXPIRY;
export const getRefreshTokenExpiry = (): number => _refreshTokenConfig?.refreshTokenExpiry ?? DEFAULT_REFRESH_TOKEN_EXPIRY;
export const getRotationGraceSeconds = (): number => _refreshTokenConfig?.rotationGraceSeconds ?? DEFAULT_ROTATION_GRACE_SECONDS;

// ---------------------------------------------------------------------------
// MFA config
// ---------------------------------------------------------------------------

export interface MfaConfig {
  /** Issuer name shown in authenticator apps. Defaults to app name. */
  issuer?: string;
  /** TOTP algorithm. Default: "SHA1" (most compatible). */
  algorithm?: "SHA1" | "SHA256" | "SHA512";
  /** TOTP digits. Default: 6. */
  digits?: number;
  /** TOTP period in seconds. Default: 30. */
  period?: number;
  /** Number of recovery codes to generate. Default: 10. */
  recoveryCodes?: number;
  /** MFA challenge window in seconds. Default: 300 (5 min). */
  challengeTtlSeconds?: number;
}

let _mfaConfig: MfaConfig | null = null;

export const setMfaConfig = (config: MfaConfig | null) => { _mfaConfig = config; };
export const getMfaConfig = () => _mfaConfig;

export const getMfaIssuer = (): string => _mfaConfig?.issuer ?? getAppName();
export const getMfaAlgorithm = (): string => _mfaConfig?.algorithm ?? "SHA1";
export const getMfaDigits = (): number => _mfaConfig?.digits ?? 6;
export const getMfaPeriod = (): number => _mfaConfig?.period ?? 30;
export const getMfaRecoveryCodeCount = (): number => _mfaConfig?.recoveryCodes ?? 10;
export const getMfaChallengeTtl = (): number => _mfaConfig?.challengeTtlSeconds ?? 300;
