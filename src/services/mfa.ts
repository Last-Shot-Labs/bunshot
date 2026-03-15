import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { getMfaIssuer, getMfaAlgorithm, getMfaDigits, getMfaPeriod, getMfaRecoveryCodeCount, getMfaEmailOtpConfig, getMfaEmailOtpCodeLength } from "@lib/appConfig";
import { createMfaChallenge } from "@lib/mfaChallenge";

// Lazy-load otpauth to keep it as an optional peer dependency
let _otpauth: typeof import("otpauth") | null = null;
async function getOtpAuth() {
  if (!_otpauth) _otpauth = await import("otpauth");
  return _otpauth;
}

function sha256(input: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(input);
  return hash.digest("hex");
}

function generateRandomCode(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars: I/1/O/0
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function generateRecoveryCodes(): { plainCodes: string[]; hashedCodes: string[] } {
  const count = getMfaRecoveryCodeCount();
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const plain = generateRandomCode(8);
    plainCodes.push(plain);
    hashedCodes.push(sha256(plain));
  }
  return { plainCodes, hashedCodes };
}

// ---------------------------------------------------------------------------
// TOTP setup + management
// ---------------------------------------------------------------------------

export interface MfaSetupResult {
  secret: string;
  uri: string;
}

export const setupMfa = async (userId: string): Promise<MfaSetupResult> => {
  const adapter = getAuthAdapter();
  if (!adapter.setMfaSecret) throw new HttpError(501, "Auth adapter does not support MFA");

  const otpauth = await getOtpAuth();
  const secret = new otpauth.Secret();

  const totp = new otpauth.TOTP({
    issuer: getMfaIssuer(),
    label: userId,
    algorithm: getMfaAlgorithm(),
    digits: getMfaDigits(),
    period: getMfaPeriod(),
    secret,
  });

  // Store the secret but don't enable MFA yet — user must confirm with a code
  await adapter.setMfaSecret(userId, secret.base32);

  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
};

export const verifySetup = async (userId: string, code: string): Promise<string[]> => {
  const adapter = getAuthAdapter();
  if (!adapter.getMfaSecret || !adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, "Auth adapter does not support MFA");
  }

  const secretStr = await adapter.getMfaSecret(userId);
  if (!secretStr) throw new HttpError(400, "MFA setup not initiated. Call POST /auth/mfa/setup first.");

  const otpauth = await getOtpAuth();
  const totp = new otpauth.TOTP({
    issuer: getMfaIssuer(),
    algorithm: getMfaAlgorithm(),
    digits: getMfaDigits(),
    period: getMfaPeriod(),
    secret: otpauth.Secret.fromBase32(secretStr),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw new HttpError(401, "Invalid TOTP code");

  // Generate recovery codes (regenerates if enabling a second method)
  const { plainCodes, hashedCodes } = generateRecoveryCodes();

  await adapter.setRecoveryCodes(userId, hashedCodes);
  await adapter.setMfaEnabled(userId, true);

  // Add "totp" to mfaMethods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes("totp")) {
      await adapter.setMfaMethods(userId, [...methods, "totp"]);
    }
  }

  return plainCodes;
};

export const verifyTotp = async (userId: string, code: string): Promise<boolean> => {
  const adapter = getAuthAdapter();
  if (!adapter.getMfaSecret) throw new HttpError(501, "Auth adapter does not support MFA");

  const secretStr = await adapter.getMfaSecret(userId);
  if (!secretStr) return false;

  const otpauth = await getOtpAuth();
  const totp = new otpauth.TOTP({
    issuer: getMfaIssuer(),
    algorithm: getMfaAlgorithm(),
    digits: getMfaDigits(),
    period: getMfaPeriod(),
    secret: otpauth.Secret.fromBase32(secretStr),
  });

  return totp.validate({ token: code, window: 1 }) !== null;
};

export const verifyRecoveryCode = async (userId: string, code: string): Promise<boolean> => {
  const adapter = getAuthAdapter();
  if (!adapter.getRecoveryCodes || !adapter.removeRecoveryCode) return false;

  const hashedCodes = await adapter.getRecoveryCodes(userId);
  const hashedInput = sha256(code.toUpperCase());

  const match = hashedCodes.find((h) => h === hashedInput);
  if (!match) return false;

  await adapter.removeRecoveryCode(userId, match);
  return true;
};

export const disableMfa = async (userId: string, code: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.setMfaEnabled || !adapter.setMfaSecret || !adapter.setRecoveryCodes) {
    throw new HttpError(501, "Auth adapter does not support MFA");
  }

  const valid = await verifyTotp(userId, code);
  if (!valid) throw new HttpError(401, "Invalid TOTP code");

  await adapter.setMfaEnabled(userId, false);
  await adapter.setMfaSecret(userId, null);
  await adapter.setRecoveryCodes(userId, []);

  // Clear all mfaMethods
  if (adapter.setMfaMethods) {
    await adapter.setMfaMethods(userId, []);
  }
};

export const regenerateRecoveryCodes = async (userId: string, code: string): Promise<string[]> => {
  const adapter = getAuthAdapter();
  if (!adapter.setRecoveryCodes) throw new HttpError(501, "Auth adapter does not support MFA");

  const valid = await verifyTotp(userId, code);
  if (!valid) throw new HttpError(401, "Invalid TOTP code");

  const { plainCodes, hashedCodes } = generateRecoveryCodes();
  await adapter.setRecoveryCodes(userId, hashedCodes);
  return plainCodes;
};

// ---------------------------------------------------------------------------
// Email OTP
// ---------------------------------------------------------------------------

/** Generate a cryptographically random numeric OTP code. Returns { code, hash }. */
export const generateEmailOtpCode = (length?: number): { code: string; hash: string } => {
  const len = length ?? getMfaEmailOtpCodeLength();
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let code = "";
  for (let i = 0; i < len; i++) {
    code += (bytes[i] % 10).toString();
  }
  return { code, hash: sha256(code) };
};

/** Verify an email OTP code against a stored hash. */
export const verifyEmailOtp = (emailOtpHash: string, code: string): boolean => {
  return sha256(code) === emailOtpHash;
};

/**
 * Initiate email OTP setup: sends a verification code to the user's email.
 * Returns a setup challenge token that must be confirmed via confirmEmailOtp.
 */
export const initiateEmailOtp = async (userId: string): Promise<string> => {
  const adapter = getAuthAdapter();
  const emailOtpConfig = getMfaEmailOtpConfig();
  if (!emailOtpConfig) throw new HttpError(501, "Email OTP is not configured");

  const user = adapter.getUser ? await adapter.getUser(userId) : null;
  if (!user?.email) throw new HttpError(400, "No email address on account");

  const { code, hash } = generateEmailOtpCode();
  await emailOtpConfig.onSend(user.email, code);

  // Store the hash in a challenge token for verification
  const setupToken = await createMfaChallenge(userId, hash);
  return setupToken;
};

/**
 * Confirm email OTP setup: verifies the code sent during initiateEmailOtp.
 * Enables email OTP as an MFA method. Returns recovery codes if MFA was not previously active.
 */
export const confirmEmailOtp = async (userId: string, setupToken: string, code: string): Promise<string[] | null> => {
  const adapter = getAuthAdapter();
  if (!adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, "Auth adapter does not support MFA");
  }

  // Import consumeMfaChallenge here to avoid circular dependency issues at module level
  const { consumeMfaChallenge } = await import("@lib/mfaChallenge");
  const challenge = await consumeMfaChallenge(setupToken);
  if (!challenge) throw new HttpError(401, "Invalid or expired setup token");
  if (challenge.userId !== userId) throw new HttpError(401, "Token does not match user");
  if (!challenge.emailOtpHash) throw new HttpError(400, "Invalid setup token — no OTP hash");

  if (!verifyEmailOtp(challenge.emailOtpHash, code)) {
    throw new HttpError(401, "Invalid verification code");
  }

  // Check if MFA was already active
  const wasEnabled = adapter.isMfaEnabled ? await adapter.isMfaEnabled(userId) : false;

  // Add "emailOtp" to mfaMethods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes("emailOtp")) {
      await adapter.setMfaMethods(userId, [...methods, "emailOtp"]);
    }
  }

  await adapter.setMfaEnabled(userId, true);

  // Generate recovery codes if MFA was not previously active
  if (!wasEnabled) {
    const { plainCodes, hashedCodes } = generateRecoveryCodes();
    await adapter.setRecoveryCodes(userId, hashedCodes);
    return plainCodes;
  }

  // Regenerate recovery codes when adding a second method
  const { plainCodes, hashedCodes } = generateRecoveryCodes();
  await adapter.setRecoveryCodes(userId, hashedCodes);
  return plainCodes;
};

/**
 * Disable email OTP for a user.
 * If TOTP is also enabled, requires a TOTP code. Otherwise requires password.
 */
export const disableEmailOtp = async (
  userId: string,
  params: { code?: string; password?: string }
): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.setMfaEnabled) throw new HttpError(501, "Auth adapter does not support MFA");

  // Get current methods
  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const hasTotpEnabled = methods.includes("totp");

  // Verify identity
  if (hasTotpEnabled) {
    if (!params.code) throw new HttpError(400, "TOTP code required to disable email OTP");
    const valid = await verifyTotp(userId, params.code);
    if (!valid) throw new HttpError(401, "Invalid TOTP code");
  } else {
    if (!params.password) throw new HttpError(400, "Password required to disable email OTP");
    // Verify password — look up the user's hash and compare
    const user = adapter.findByIdentifier
      ? await adapter.findByIdentifier((await adapter.getUser?.(userId))?.email ?? "")
      : await adapter.findByEmail((await adapter.getUser?.(userId))?.email ?? "");
    if (!user) throw new HttpError(404, "User not found");
    const valid = await Bun.password.verify(params.password, user.passwordHash);
    if (!valid) throw new HttpError(401, "Invalid password");
  }

  // Remove "emailOtp" from methods
  if (adapter.setMfaMethods) {
    const updated = methods.filter((m) => m !== "emailOtp");
    await adapter.setMfaMethods(userId, updated);

    // If no methods remain, disable MFA entirely
    if (updated.length === 0) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

/** Get the MFA methods enabled for a user. */
export const getMfaMethods = async (userId: string): Promise<string[]> => {
  const adapter = getAuthAdapter();
  if (adapter.getMfaMethods) return adapter.getMfaMethods(userId);
  // Backward compat
  if (adapter.isMfaEnabled && await adapter.isMfaEnabled(userId)) return ["totp"];
  return [];
};
