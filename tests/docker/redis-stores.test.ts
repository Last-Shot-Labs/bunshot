import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { connectTestRedis, flushTestServices, disconnectTestServices } from "../setup-docker";
import { setAppName, setRefreshTokenConfig } from "../../src/lib/appConfig";

// Store setters
import { setEmailVerificationStore } from "../../src/lib/emailVerification";
import { setPasswordResetStore } from "../../src/lib/resetPassword";
import { setOAuthCodeStore } from "../../src/lib/oauthCode";
import { setMfaChallengeStore } from "../../src/lib/mfaChallenge";
import { setAuthRateLimitStore } from "../../src/lib/authRateLimit";
import { setOAuthStateStore } from "../../src/lib/oauth";

// Public APIs
import { createVerificationToken, getVerificationToken, deleteVerificationToken } from "../../src/lib/emailVerification";
import { createResetToken, consumeResetToken } from "../../src/lib/resetPassword";
import { storeOAuthCode, consumeOAuthCode } from "../../src/lib/oauthCode";
import { createMfaChallenge, consumeMfaChallenge, replaceMfaChallengeOtp, createWebAuthnRegistrationChallenge, consumeWebAuthnRegistrationChallenge } from "../../src/lib/mfaChallenge";
import { trackAttempt, isLimited, bustAuthLimit } from "../../src/lib/authRateLimit";
import { storeOAuthState, consumeOAuthState } from "../../src/lib/oauth";

beforeAll(async () => {
  await connectTestRedis();
  setAppName("test-app");
  setEmailVerificationStore("redis");
  setPasswordResetStore("redis");
  setOAuthCodeStore("redis");
  setMfaChallengeStore("redis");
  setAuthRateLimitStore("redis");
  setOAuthStateStore("redis");
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

// ---------------------------------------------------------------------------
// Email Verification
// ---------------------------------------------------------------------------

describe("Redis: email verification", () => {
  it("creates and retrieves a token", async () => {
    const raw = await createVerificationToken("user-1", "test@example.com");
    const result = await getVerificationToken(raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.email).toBe("test@example.com");
  });

  it("returns null for invalid token", async () => {
    expect(await getVerificationToken("invalid")).toBeNull();
  });

  it("deletes a token", async () => {
    const raw = await createVerificationToken("user-1", "del@example.com");
    await deleteVerificationToken(raw);
    expect(await getVerificationToken(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Password Reset
// ---------------------------------------------------------------------------

describe("Redis: password reset", () => {
  it("creates and consumes a token (single-use)", async () => {
    const raw = await createResetToken("user-1", "reset@example.com");
    const result = await consumeResetToken(raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.email).toBe("reset@example.com");

    // Second consume should return null (single-use)
    expect(await consumeResetToken(raw)).toBeNull();
  });

  it("returns null for invalid token", async () => {
    expect(await consumeResetToken("invalid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe("Redis: OAuth code", () => {
  it("stores and consumes a code (single-use)", async () => {
    const code = await storeOAuthCode({
      token: "jwt-token",
      userId: "user-1",
      email: "oauth@example.com",
      refreshToken: "rt-1",
    });
    const result = await consumeOAuthCode(code);
    expect(result).not.toBeNull();
    expect(result!.token).toBe("jwt-token");
    expect(result!.userId).toBe("user-1");
    expect(result!.email).toBe("oauth@example.com");
    expect(result!.refreshToken).toBe("rt-1");

    // Single-use
    expect(await consumeOAuthCode(code)).toBeNull();
  });

  it("returns null for invalid code", async () => {
    expect(await consumeOAuthCode("invalid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MFA Challenge
// ---------------------------------------------------------------------------

describe("Redis: MFA challenge", () => {
  it("creates and consumes a login challenge", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "hash-abc" });
    const result = await consumeMfaChallenge(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.purpose).toBe("login");
    expect(result!.emailOtpHash).toBe("hash-abc");
  });

  it("consume is single-use", async () => {
    const token = await createMfaChallenge("user-1");
    await consumeMfaChallenge(token);
    expect(await consumeMfaChallenge(token)).toBeNull();
  });

  it("returns null for invalid token", async () => {
    expect(await consumeMfaChallenge("nope")).toBeNull();
  });

  it("creates challenge with webauthn data", async () => {
    const token = await createMfaChallenge("user-1", { webauthnChallenge: "challenge-xyz" });
    const result = await consumeMfaChallenge(token);
    expect(result!.webauthnChallenge).toBe("challenge-xyz");
  });

  it("replaces OTP hash (resend)", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "hash-1" });
    const result = await replaceMfaChallengeOtp(token, "hash-2");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.resendCount).toBe(1);

    // Consume should get the new OTP hash
    const consumed = await consumeMfaChallenge(token);
    expect(consumed!.emailOtpHash).toBe("hash-2");
  });

  it("caps resends at 3", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "h" });
    await replaceMfaChallengeOtp(token, "h2");
    await replaceMfaChallengeOtp(token, "h3");
    await replaceMfaChallengeOtp(token, "h4");
    const result = await replaceMfaChallengeOtp(token, "h5");
    expect(result).toBeNull();
  });

  it("returns null for expired/invalid resend", async () => {
    expect(await replaceMfaChallengeOtp("nonexistent", "h")).toBeNull();
  });
});

describe("Redis: WebAuthn registration challenge", () => {
  it("creates and consumes a webauthn-registration challenge", async () => {
    const token = await createWebAuthnRegistrationChallenge("user-1", "webauthn-challenge-data");
    const result = await consumeWebAuthnRegistrationChallenge(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.challenge).toBe("webauthn-challenge-data");
  });

  it("login consume rejects webauthn-registration tokens", async () => {
    const token = await createWebAuthnRegistrationChallenge("user-1", "challenge");
    const result = await consumeMfaChallenge(token);
    expect(result).toBeNull();
  });

  it("is single-use", async () => {
    const token = await createWebAuthnRegistrationChallenge("user-1", "challenge");
    await consumeWebAuthnRegistrationChallenge(token);
    expect(await consumeWebAuthnRegistrationChallenge(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth Rate Limit
// ---------------------------------------------------------------------------

describe("Redis: auth rate limit", () => {
  const opts = { windowMs: 60_000, max: 3 };

  it("tracks attempts and limits", async () => {
    expect(await isLimited("key-1", opts)).toBe(false);

    await trackAttempt("key-1", opts);
    await trackAttempt("key-1", opts);
    expect(await isLimited("key-1", opts)).toBe(false);

    const limited = await trackAttempt("key-1", opts);
    expect(limited).toBe(true);
    expect(await isLimited("key-1", opts)).toBe(true);
  });

  it("busts a rate limit", async () => {
    await trackAttempt("key-bust", opts);
    await trackAttempt("key-bust", opts);
    await trackAttempt("key-bust", opts);
    expect(await isLimited("key-bust", opts)).toBe(true);

    await bustAuthLimit("key-bust");
    expect(await isLimited("key-bust", opts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe("Redis: OAuth state", () => {
  it("stores and consumes state", async () => {
    await storeOAuthState("state-abc", "code-verifier-1", undefined);
    const result = await consumeOAuthState("state-abc");
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe("code-verifier-1");
  });

  it("state is single-use", async () => {
    await storeOAuthState("state-single", undefined, "link-user-1");
    await consumeOAuthState("state-single");
    expect(await consumeOAuthState("state-single")).toBeNull();
  });

  it("returns null for invalid state", async () => {
    expect(await consumeOAuthState("invalid")).toBeNull();
  });

  it("stores linkUserId", async () => {
    await storeOAuthState("state-link", undefined, "link-user-id");
    const result = await consumeOAuthState("state-link");
    expect(result!.linkUserId).toBe("link-user-id");
  });
});
