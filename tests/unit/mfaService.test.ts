import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore } from "../setup";
import {
  setupMfa,
  verifySetup,
  verifyTotp,
  verifyRecoveryCode,
  disableMfa,
  regenerateRecoveryCodes,
  getMfaMethods,
  generateEmailOtpCode,
  verifyEmailOtp,
  initiateEmailOtp,
  confirmEmailOtp,
  disableEmailOtp,
} from "../../src/services/mfa";
import { getAuthAdapter } from "../../src/lib/authAdapter";
import { setMfaChallengeStore } from "../../src/lib/mfaChallenge";

let adapter: ReturnType<typeof getAuthAdapter>;
const emailOtpCodes: { email: string; code: string }[] = [];

beforeAll(async () => {
  await createTestApp({
    auth: {
      enabled: true,
      roles: ["admin", "user"],
      defaultRole: "user",
      mfa: {
        challengeTtlSeconds: 300,
        emailOtp: {
          onSend: async (email, code) => {
            emailOtpCodes.push({ email, code });
          },
        },
      },
    },
  });
  setMfaChallengeStore("memory");
  adapter = getAuthAdapter();
});

beforeEach(() => {
  clearMemoryStore();
  emailOtpCodes.length = 0;
});

async function createUser(email = "mfa@example.com", password = "password123") {
  const user = await adapter.create(email, await Bun.password.hash(password));
  return user.id;
}

// Helper: get a valid TOTP code for a user
async function getValidTotp(userId: string): Promise<string> {
  const otpauth = await import("otpauth");
  const secretStr = await adapter.getMfaSecret!(userId);
  const totp = new otpauth.TOTP({
    secret: otpauth.Secret.fromBase32(secretStr!),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

// ---------------------------------------------------------------------------
// TOTP setup + management
// ---------------------------------------------------------------------------

describe("setupMfa", () => {
  test("returns secret and URI", async () => {
    const userId = await createUser();
    const result = await setupMfa(userId);
    expect(result.secret).toBeTruthy();
    expect(result.uri).toContain("otpauth://totp/");
  });
});

describe("verifySetup", () => {
  test("valid TOTP code enables MFA and returns recovery codes", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code);
    expect(recoveryCodes).toBeArray();
    expect(recoveryCodes.length).toBe(10);
    expect(await adapter.isMfaEnabled!(userId)).toBe(true);
  });

  test("invalid code throws 401", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    expect(verifySetup(userId, "000000")).rejects.toThrow("Invalid TOTP code");
  });

  test("adds 'totp' to mfaMethods", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).toContain("totp");
  });
});

describe("verifyTotp", () => {
  test("returns true for valid code", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    const freshCode = await getValidTotp(userId);
    expect(await verifyTotp(userId, freshCode)).toBe(true);
  });

  test("returns false for invalid code", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    expect(await verifyTotp(userId, "000000")).toBe(false);
  });
});

describe("verifyRecoveryCode", () => {
  test("valid code is consumed and returns true", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code);
    const firstCode = recoveryCodes[0];
    expect(await verifyRecoveryCode(userId, firstCode)).toBe(true);
  });

  test("already-used code returns false", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    const recoveryCodes = await verifySetup(userId, code);
    const firstCode = recoveryCodes[0];
    await verifyRecoveryCode(userId, firstCode);
    expect(await verifyRecoveryCode(userId, firstCode)).toBe(false);
  });

  test("invalid code returns false", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    expect(await verifyRecoveryCode(userId, "INVALIDCODE")).toBe(false);
  });
});

describe("disableMfa", () => {
  test("clears MFA with valid TOTP code", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    const disableCode = await getValidTotp(userId);
    await disableMfa(userId, disableCode);
    expect(await adapter.isMfaEnabled!(userId)).toBe(false);
  });

  test("rejects invalid TOTP code", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    expect(disableMfa(userId, "000000")).rejects.toThrow("Invalid TOTP code");
  });
});

describe("regenerateRecoveryCodes", () => {
  test("returns new recovery codes with valid TOTP", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    const oldCodes = await verifySetup(userId, code);
    const regenCode = await getValidTotp(userId);
    const newCodes = await regenerateRecoveryCodes(userId, regenCode);
    expect(newCodes).toBeArray();
    expect(newCodes.length).toBe(10);
    // New codes should differ from old
    expect(newCodes[0]).not.toBe(oldCodes[0]);
  });
});

describe("getMfaMethods", () => {
  test("returns empty array for user with no MFA", async () => {
    const userId = await createUser();
    expect(await getMfaMethods(userId)).toEqual([]);
  });

  test("returns ['totp'] when TOTP enabled", async () => {
    const userId = await createUser();
    await setupMfa(userId);
    const code = await getValidTotp(userId);
    await verifySetup(userId, code);
    expect(await getMfaMethods(userId)).toEqual(["totp"]);
  });
});

// ---------------------------------------------------------------------------
// Email OTP
// ---------------------------------------------------------------------------

describe("generateEmailOtpCode", () => {
  test("generates a code of the configured length", () => {
    const { code, hash } = generateEmailOtpCode(6);
    expect(code).toHaveLength(6);
    expect(/^\d+$/.test(code)).toBe(true);
    expect(hash).toBeTruthy();
  });
});

describe("verifyEmailOtp", () => {
  test("returns true for matching code", () => {
    const { code, hash } = generateEmailOtpCode();
    expect(verifyEmailOtp(hash, code)).toBe(true);
  });

  test("returns false for wrong code", () => {
    const { hash } = generateEmailOtpCode();
    expect(verifyEmailOtp(hash, "000000")).toBe(false);
  });
});

describe("initiateEmailOtp", () => {
  test("calls onSend callback and returns challenge token", async () => {
    const userId = await createUser("emailotp@example.com");
    const setupToken = await initiateEmailOtp(userId);
    expect(typeof setupToken).toBe("string");
    expect(emailOtpCodes).toHaveLength(1);
    expect(emailOtpCodes[0].email).toBe("emailotp@example.com");
    expect(emailOtpCodes[0].code).toBeTruthy();
  });
});

describe("confirmEmailOtp", () => {
  test("enables email OTP method and returns recovery codes", async () => {
    const userId = await createUser("confirm@example.com");
    const setupToken = await initiateEmailOtp(userId);
    const code = emailOtpCodes[0].code;
    const recoveryCodes = await confirmEmailOtp(userId, setupToken, code);
    expect(recoveryCodes).toBeArray();
    expect(recoveryCodes!.length).toBe(10);
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).toContain("emailOtp");
    expect(await adapter.isMfaEnabled!(userId)).toBe(true);
  });

  test("rejects invalid code", async () => {
    const userId = await createUser("bad@example.com");
    const setupToken = await initiateEmailOtp(userId);
    expect(confirmEmailOtp(userId, setupToken, "000000")).rejects.toThrow("Invalid verification code");
  });

  test("rejects expired/invalid setup token", async () => {
    const userId = await createUser("expired@example.com");
    expect(confirmEmailOtp(userId, "invalid-token", "123456")).rejects.toThrow("Invalid or expired setup token");
  });
});

describe("disableEmailOtp", () => {
  test("removes email OTP method with password verification", async () => {
    const userId = await createUser("disable@example.com", "password123");
    const setupToken = await initiateEmailOtp(userId);
    const code = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, code);
    await disableEmailOtp(userId, { password: "password123" });
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).not.toContain("emailOtp");
  });

  test("disables MFA entirely when last method removed", async () => {
    const userId = await createUser("lastmethod@example.com", "password123");
    const setupToken = await initiateEmailOtp(userId);
    const code = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, code);
    await disableEmailOtp(userId, { password: "password123" });
    expect(await adapter.isMfaEnabled!(userId)).toBe(false);
  });

  test("requires TOTP code when TOTP is also enabled", async () => {
    const userId = await createUser("both@example.com", "password123");
    // Enable TOTP first
    await setupMfa(userId);
    const totpCode = await getValidTotp(userId);
    await verifySetup(userId, totpCode);
    // Enable email OTP
    const setupToken = await initiateEmailOtp(userId);
    const otpCode = emailOtpCodes[0].code;
    await confirmEmailOtp(userId, setupToken, otpCode);
    // Disable email OTP requires TOTP code
    const disableCode = await getValidTotp(userId);
    await disableEmailOtp(userId, { code: disableCode });
    const methods = await adapter.getMfaMethods!(userId);
    expect(methods).not.toContain("emailOtp");
    expect(methods).toContain("totp");
  });
});
