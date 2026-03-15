import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { connectTestMongo, flushTestServices, disconnectTestServices } from "../setup-docker";
import { setAppName } from "../../src/lib/appConfig";

// Store setters
import { setEmailVerificationStore } from "../../src/lib/emailVerification";
import { setPasswordResetStore } from "../../src/lib/resetPassword";
import { setOAuthCodeStore } from "../../src/lib/oauthCode";
import { setMfaChallengeStore } from "../../src/lib/mfaChallenge";
import { setOAuthStateStore } from "../../src/lib/oauth";

// Public APIs
import { createVerificationToken, getVerificationToken, deleteVerificationToken } from "../../src/lib/emailVerification";
import { createResetToken, consumeResetToken } from "../../src/lib/resetPassword";
import { storeOAuthCode, consumeOAuthCode } from "../../src/lib/oauthCode";
import { createMfaChallenge, consumeMfaChallenge, replaceMfaChallengeOtp, createWebAuthnRegistrationChallenge, consumeWebAuthnRegistrationChallenge } from "../../src/lib/mfaChallenge";
import { storeOAuthState, consumeOAuthState } from "../../src/lib/oauth";

beforeAll(async () => {
  await connectTestMongo();
  setAppName("test-app");
  setEmailVerificationStore("mongo");
  setPasswordResetStore("mongo");
  setOAuthCodeStore("mongo");
  setMfaChallengeStore("mongo");
  setOAuthStateStore("mongo");
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

describe("Mongo: email verification", () => {
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

describe("Mongo: password reset", () => {
  it("creates and consumes a token (single-use)", async () => {
    const raw = await createResetToken("user-1", "reset@example.com");
    const result = await consumeResetToken(raw);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");

    expect(await consumeResetToken(raw)).toBeNull();
  });

  it("returns null for invalid token", async () => {
    expect(await consumeResetToken("invalid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe("Mongo: OAuth code", () => {
  it("stores and consumes a code (single-use)", async () => {
    const code = await storeOAuthCode({
      token: "jwt-token",
      userId: "user-1",
      email: "oauth@example.com",
    });
    const result = await consumeOAuthCode(code);
    expect(result).not.toBeNull();
    expect(result!.token).toBe("jwt-token");

    expect(await consumeOAuthCode(code)).toBeNull();
  });

  it("returns null for invalid code", async () => {
    expect(await consumeOAuthCode("invalid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MFA Challenge
// ---------------------------------------------------------------------------

describe("Mongo: MFA challenge", () => {
  it("creates and consumes a login challenge", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "hash-abc" });
    const result = await consumeMfaChallenge(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-1");
    expect(result!.emailOtpHash).toBe("hash-abc");
  });

  it("consume is single-use", async () => {
    const token = await createMfaChallenge("user-1");
    await consumeMfaChallenge(token);
    expect(await consumeMfaChallenge(token)).toBeNull();
  });

  it("replaces OTP hash (resend)", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "hash-1" });
    const result = await replaceMfaChallengeOtp(token, "hash-2");
    expect(result).not.toBeNull();
    expect(result!.resendCount).toBe(1);
  });

  it("caps resends at 3", async () => {
    const token = await createMfaChallenge("user-1", { emailOtpHash: "h" });
    await replaceMfaChallengeOtp(token, "h2");
    await replaceMfaChallengeOtp(token, "h3");
    await replaceMfaChallengeOtp(token, "h4");
    expect(await replaceMfaChallengeOtp(token, "h5")).toBeNull();
  });
});

describe("Mongo: WebAuthn registration challenge", () => {
  it("creates and consumes", async () => {
    const token = await createWebAuthnRegistrationChallenge("user-1", "challenge-data");
    const result = await consumeWebAuthnRegistrationChallenge(token);
    expect(result).not.toBeNull();
    expect(result!.challenge).toBe("challenge-data");
  });

  it("login consume rejects webauthn-registration tokens", async () => {
    const token = await createWebAuthnRegistrationChallenge("user-1", "challenge");
    expect(await consumeMfaChallenge(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe("Mongo: OAuth state", () => {
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

  it("stores linkUserId", async () => {
    await storeOAuthState("state-link", undefined, "link-user-id");
    const result = await consumeOAuthState("state-link");
    expect(result!.linkUserId).toBe("link-user-id");
  });
});
