import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { getMfaIssuer, getMfaAlgorithm, getMfaDigits, getMfaPeriod, getMfaRecoveryCodeCount } from "@lib/appConfig";

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

  // Generate recovery codes
  const count = getMfaRecoveryCodeCount();
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const plain = generateRandomCode(8);
    plainCodes.push(plain);
    hashedCodes.push(sha256(plain));
  }

  await adapter.setRecoveryCodes(userId, hashedCodes);
  await adapter.setMfaEnabled(userId, true);

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
};

export const regenerateRecoveryCodes = async (userId: string, code: string): Promise<string[]> => {
  const adapter = getAuthAdapter();
  if (!adapter.setRecoveryCodes) throw new HttpError(501, "Auth adapter does not support MFA");

  const valid = await verifyTotp(userId, code);
  if (!valid) throw new HttpError(401, "Invalid TOTP code");

  const count = getMfaRecoveryCodeCount();
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const plain = generateRandomCode(8);
    plainCodes.push(plain);
    hashedCodes.push(sha256(plain));
  }

  await adapter.setRecoveryCodes(userId, hashedCodes);
  return plainCodes;
};
