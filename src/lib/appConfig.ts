export type PrimaryField = "email" | "username" | "phone";

export interface EmailVerificationConfig {
  /** Block login until email is verified. Defaults to false (soft gate — emailVerified returned in login response). */
  required?: boolean;
  /** Token time-to-live in seconds. Defaults to 86 400 (24 hours). */
  tokenExpiry?: number;
  /** Called after registration with the identifier and verification token. Use to send the email. */
  onSend: (email: string, token: string) => Promise<void>;
}

let appName = "Core API";
let appRoles: string[] = [];
let defaultRole: string | null = null;
let _primaryField: PrimaryField = "email";
let _emailVerificationConfig: EmailVerificationConfig | null = null;

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
