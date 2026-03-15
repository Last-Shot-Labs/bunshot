import { getAuthAdapter } from "@lib/authAdapter";
import { HttpError } from "@lib/HttpError";
import { getMfaIssuer, getMfaAlgorithm, getMfaDigits, getMfaPeriod, getMfaRecoveryCodeCount, getMfaEmailOtpConfig, getMfaEmailOtpCodeLength, getMfaWebAuthnConfig, getAppName } from "@lib/appConfig";
import type { WebAuthnCredential } from "@lib/authAdapter";
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
  const setupToken = await createMfaChallenge(userId, { emailOtpHash: hash });
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

// ---------------------------------------------------------------------------
// WebAuthn / FIDO2
// ---------------------------------------------------------------------------

// Lazy-load @simplewebauthn/server to keep it as an optional peer dependency
let _simplewebauthn: typeof import("@simplewebauthn/server") | null = null;
async function getSimpleWebAuthn() {
  if (!_simplewebauthn) _simplewebauthn = await import("@simplewebauthn/server");
  return _simplewebauthn;
}

/**
 * Eager startup check — call at route mount time to fail fast if the peer dependency is missing.
 */
export const assertWebAuthnDependency = async (): Promise<void> => {
  try {
    await import("@simplewebauthn/server");
  } catch {
    throw new Error(
      "@simplewebauthn/server is required when mfa.webauthn is configured. Install it: bun add @simplewebauthn/server"
    );
  }
};

/**
 * Generate WebAuthn authentication options for the login MFA flow.
 * Called from auth.ts login when the user has "webauthn" in their methods.
 */
export const generateWebAuthnAuthenticationOptions = async (
  userId: string
): Promise<{ challenge: string; options: Record<string, unknown> } | null> => {
  const config = getMfaWebAuthnConfig();
  if (!config) return null;
  const adapter = getAuthAdapter();
  if (!adapter.getWebAuthnCredentials) return null;

  const credentials = await adapter.getWebAuthnCredentials(userId);
  if (credentials.length === 0) return null;

  const { generateAuthenticationOptions } = await getSimpleWebAuthn();
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    userVerification: config.userVerification ?? "preferred",
    timeout: config.timeout ?? 60000,
  });

  return { challenge: options.challenge, options: options as unknown as Record<string, unknown> };
};

// Re-use the type from the WebAuthn spec — imported dynamically
type AuthenticatorTransport = "usb" | "ble" | "nfc" | "internal" | "hybrid";

/**
 * Initiate WebAuthn registration: generates registration options for the client.
 * Returns options + a registration challenge token.
 */
export const initiateWebAuthnRegistration = async (
  userId: string
): Promise<{ options: Record<string, unknown>; registrationToken: string }> => {
  const config = getMfaWebAuthnConfig();
  if (!config) throw new HttpError(501, "WebAuthn is not configured");
  const adapter = getAuthAdapter();
  if (!adapter.getWebAuthnCredentials) throw new HttpError(501, "Auth adapter does not support WebAuthn");

  const user = adapter.getUser ? await adapter.getUser(userId) : null;

  // Get existing credentials to exclude (prevent re-registration)
  const existingCreds = await adapter.getWebAuthnCredentials(userId);

  const { generateRegistrationOptions } = await getSimpleWebAuthn();
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? getAppName(),
    rpID: config.rpId,
    userName: user?.email ?? userId,
    attestationType: config.attestationType ?? "none",
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      authenticatorAttachment: config.authenticatorAttachment,
      userVerification: config.userVerification ?? "preferred",
      residentKey: "preferred",
    },
    timeout: config.timeout ?? 60000,
  });

  const { createWebAuthnRegistrationChallenge } = await import("@lib/mfaChallenge");
  const registrationToken = await createWebAuthnRegistrationChallenge(userId, options.challenge);

  return { options: options as unknown as Record<string, unknown>, registrationToken };
};

/**
 * Complete WebAuthn registration: verifies attestation and stores the credential.
 * Returns recovery codes if this is the first MFA method.
 */
export const completeWebAuthnRegistration = async (
  userId: string,
  registrationToken: string,
  attestationResponse: any,
  name?: string
): Promise<{ credentialId: string; recoveryCodes: string[] | null }> => {
  const config = getMfaWebAuthnConfig();
  if (!config) throw new HttpError(501, "WebAuthn is not configured");
  const adapter = getAuthAdapter();
  if (!adapter.addWebAuthnCredential || !adapter.setMfaEnabled || !adapter.setRecoveryCodes) {
    throw new HttpError(501, "Auth adapter does not support WebAuthn");
  }

  const { consumeWebAuthnRegistrationChallenge } = await import("@lib/mfaChallenge");
  const challenge = await consumeWebAuthnRegistrationChallenge(registrationToken);
  if (!challenge) throw new HttpError(401, "Invalid or expired registration token");
  if (challenge.userId !== userId) throw new HttpError(401, "Token does not match user");

  const { verifyRegistrationResponse } = await getSimpleWebAuthn();
  const verification = await verifyRegistrationResponse({
    response: attestationResponse,
    expectedChallenge: challenge.challenge,
    expectedOrigin: Array.isArray(config.origin) ? config.origin : [config.origin],
    expectedRPID: config.rpId,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(401, "WebAuthn registration verification failed");
  }

  const { credential } = verification.registrationInfo;
  const credentialId = credential.id;

  // Cross-user uniqueness check
  if (adapter.findUserByWebAuthnCredentialId) {
    const existingOwner = await adapter.findUserByWebAuthnCredentialId(credentialId);
    if (existingOwner && existingOwner !== userId) {
      throw new HttpError(409, "This security key is already registered to another account");
    }
  }

  const newCredential: WebAuthnCredential = {
    credentialId,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    signCount: credential.counter,
    transports: (attestationResponse.response?.transports as string[]) ?? [],
    name: name ?? undefined,
    createdAt: Date.now(),
  };

  await adapter.addWebAuthnCredential(userId, newCredential);

  // Add "webauthn" to methods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    if (!methods.includes("webauthn")) {
      await adapter.setMfaMethods(userId, [...methods, "webauthn"]);
    }
  }

  // Enable MFA + generate/regenerate recovery codes
  await adapter.setMfaEnabled(userId, true);
  const { plainCodes, hashedCodes } = generateRecoveryCodes();
  await adapter.setRecoveryCodes(userId, hashedCodes);

  return { credentialId, recoveryCodes: plainCodes };
};

/**
 * Verify a WebAuthn authentication assertion during login MFA.
 */
export const verifyWebAuthn = async (
  userId: string,
  assertionResponse: any,
  expectedChallenge: string
): Promise<boolean> => {
  const config = getMfaWebAuthnConfig();
  if (!config) return false;
  const adapter = getAuthAdapter();
  if (!adapter.getWebAuthnCredentials || !adapter.updateWebAuthnCredentialSignCount) return false;

  const credentials = await adapter.getWebAuthnCredentials(userId);
  const credentialId = assertionResponse.id as string;
  const matchedCred = credentials.find((c) => c.credentialId === credentialId);
  if (!matchedCred) return false;

  const { verifyAuthenticationResponse } = await getSimpleWebAuthn();
  try {
    const verification = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: Array.isArray(config.origin) ? config.origin : [config.origin],
      expectedRPID: config.rpId,
      credential: {
        id: matchedCred.credentialId,
        publicKey: new Uint8Array(Buffer.from(matchedCred.publicKey, "base64url")),
        counter: matchedCred.signCount,
        transports: matchedCred.transports as AuthenticatorTransport[],
      },
    });

    if (!verification.verified) return false;

    const { authenticationInfo } = verification;

    // Sign count policy
    if (authenticationInfo.newCounter < matchedCred.signCount) {
      if (config.strictSignCount) {
        console.warn(`[webauthn] Sign count went backward for credential ${credentialId} (user ${userId}) — rejecting (strictSignCount enabled)`);
        return false;
      }
      console.warn(`[webauthn] Sign count went backward for credential ${credentialId} (user ${userId}) — possible cloned authenticator`);
    }

    await adapter.updateWebAuthnCredentialSignCount(userId, credentialId, authenticationInfo.newCounter);
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove a single WebAuthn credential.
 * Only requires identity verification when removing the last credential of the last MFA method.
 */
export const removeWebAuthnCredential = async (
  userId: string,
  credentialId: string,
  params: { code?: string; password?: string }
): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
    throw new HttpError(501, "Auth adapter does not support WebAuthn");
  }

  const credentials = await adapter.getWebAuthnCredentials(userId);
  if (!credentials.some((c) => c.credentialId === credentialId)) {
    throw new HttpError(404, "Credential not found");
  }

  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const otherMethodsExist = methods.some((m) => m !== "webauthn");
  const otherCredsExist = credentials.length > 1;

  // Only require verification when removing the last credential of the last method
  if (!otherMethodsExist && !otherCredsExist) {
    await verifyIdentity(userId, params);
  }

  await adapter.removeWebAuthnCredential(userId, credentialId);

  // If that was the last credential, remove "webauthn" from methods
  if (!otherCredsExist && adapter.setMfaMethods) {
    const updated = methods.filter((m) => m !== "webauthn");
    await adapter.setMfaMethods(userId, updated);

    // If no methods remain, disable MFA entirely
    if (updated.length === 0 && adapter.setMfaEnabled) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

/**
 * Disable WebAuthn entirely: removes all credentials and the method.
 */
export const disableWebAuthn = async (
  userId: string,
  params: { code?: string; password?: string }
): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
    throw new HttpError(501, "Auth adapter does not support WebAuthn");
  }

  await verifyIdentity(userId, params);

  const credentials = await adapter.getWebAuthnCredentials(userId);
  for (const cred of credentials) {
    await adapter.removeWebAuthnCredential(userId, cred.credentialId);
  }

  // Remove "webauthn" from methods
  if (adapter.getMfaMethods && adapter.setMfaMethods) {
    const methods = await adapter.getMfaMethods(userId);
    const updated = methods.filter((m) => m !== "webauthn");
    await adapter.setMfaMethods(userId, updated);

    if (updated.length === 0 && adapter.setMfaEnabled) {
      await adapter.setMfaEnabled(userId, false);
      if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
    }
  }
};

/** Internal: verify identity via TOTP code or password. */
async function verifyIdentity(userId: string, params: { code?: string; password?: string }): Promise<void> {
  const adapter = getAuthAdapter();
  const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
  const hasTotpEnabled = methods.includes("totp");

  if (hasTotpEnabled) {
    if (!params.code) throw new HttpError(400, "TOTP code required");
    const valid = await verifyTotp(userId, params.code);
    if (!valid) throw new HttpError(401, "Invalid TOTP code");
  } else {
    if (!params.password) throw new HttpError(400, "Password required");
    const user = adapter.findByIdentifier
      ? await adapter.findByIdentifier((await adapter.getUser?.(userId))?.email ?? "")
      : await adapter.findByEmail((await adapter.getUser?.(userId))?.email ?? "");
    if (!user) throw new HttpError(404, "User not found");
    const valid = await Bun.password.verify(params.password, user.passwordHash);
    if (!valid) throw new HttpError(401, "Invalid password");
  }
}
