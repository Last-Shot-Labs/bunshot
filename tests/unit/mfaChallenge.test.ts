import { describe, test, expect, beforeEach } from "bun:test";
import {
  setMfaChallengeStore,
  createMfaChallenge,
  consumeMfaChallenge,
  replaceMfaChallengeOtp,
  createWebAuthnRegistrationChallenge,
  consumeWebAuthnRegistrationChallenge,
} from "../../src/lib/mfaChallenge";
import { setMfaConfig } from "../../src/lib/appConfig";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";

setMfaChallengeStore("memory");
setMfaConfig({ challengeTtlSeconds: 300 });

beforeEach(() => {
  clearMemoryStore();
});

// ---------------------------------------------------------------------------
// createMfaChallenge + consumeMfaChallenge
// ---------------------------------------------------------------------------

describe("createMfaChallenge + consumeMfaChallenge", () => {
  test("creates and consumes a login challenge", async () => {
    const token = await createMfaChallenge("user1");
    const data = await consumeMfaChallenge(token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe("user1");
    expect(data!.purpose).toBe("login");
  });

  test("stores emailOtpHash when provided", async () => {
    const token = await createMfaChallenge("user1", { emailOtpHash: "hash123" });
    const data = await consumeMfaChallenge(token);
    expect(data!.emailOtpHash).toBe("hash123");
  });

  test("stores webauthnChallenge when provided", async () => {
    const token = await createMfaChallenge("user1", { webauthnChallenge: "challenge-xyz" });
    const data = await consumeMfaChallenge(token);
    expect(data!.webauthnChallenge).toBe("challenge-xyz");
  });

  test("second consume returns null (single-use)", async () => {
    const token = await createMfaChallenge("user1");
    await consumeMfaChallenge(token);
    expect(await consumeMfaChallenge(token)).toBeNull();
  });

  test("returns null for non-existent token", async () => {
    expect(await consumeMfaChallenge("nonexistent")).toBeNull();
  });

  test("returns null for expired token", async () => {
    setMfaConfig({ challengeTtlSeconds: 1 });
    const token = await createMfaChallenge("user1");
    await Bun.sleep(1100);
    expect(await consumeMfaChallenge(token)).toBeNull();
    setMfaConfig({ challengeTtlSeconds: 300 });
  });
});

// ---------------------------------------------------------------------------
// Cross-purpose rejection
// ---------------------------------------------------------------------------

describe("cross-purpose rejection", () => {
  test("consumeMfaChallenge rejects webauthn-registration purpose", async () => {
    const token = await createWebAuthnRegistrationChallenge("user1", "challenge-abc");
    const data = await consumeMfaChallenge(token);
    expect(data).toBeNull();
  });

  test("consumeWebAuthnRegistrationChallenge rejects login purpose", async () => {
    const token = await createMfaChallenge("user1");
    const data = await consumeWebAuthnRegistrationChallenge(token);
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replaceMfaChallengeOtp
// ---------------------------------------------------------------------------

describe("replaceMfaChallengeOtp", () => {
  test("replaces the OTP hash on an existing challenge", async () => {
    const token = await createMfaChallenge("user1", { emailOtpHash: "old-hash" });
    const result = await replaceMfaChallengeOtp(token, "new-hash");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user1");
    expect(result!.resendCount).toBe(1);

    // Verify the hash was updated by consuming
    const data = await consumeMfaChallenge(token);
    expect(data!.emailOtpHash).toBe("new-hash");
  });

  test("increments resendCount on successive calls", async () => {
    const token = await createMfaChallenge("user1", { emailOtpHash: "h0" });
    const r1 = await replaceMfaChallengeOtp(token, "h1");
    expect(r1!.resendCount).toBe(1);
    const r2 = await replaceMfaChallengeOtp(token, "h2");
    expect(r2!.resendCount).toBe(2);
    const r3 = await replaceMfaChallengeOtp(token, "h3");
    expect(r3!.resendCount).toBe(3);
  });

  test("returns null after MAX_RESENDS (3) exceeded", async () => {
    const token = await createMfaChallenge("user1", { emailOtpHash: "h0" });
    await replaceMfaChallengeOtp(token, "h1");
    await replaceMfaChallengeOtp(token, "h2");
    await replaceMfaChallengeOtp(token, "h3");
    // 4th attempt should fail
    expect(await replaceMfaChallengeOtp(token, "h4")).toBeNull();
  });

  test("returns null for non-existent token", async () => {
    expect(await replaceMfaChallengeOtp("nonexistent", "hash")).toBeNull();
  });

  test("returns null for expired token", async () => {
    setMfaConfig({ challengeTtlSeconds: 1 });
    const token = await createMfaChallenge("user1", { emailOtpHash: "h0" });
    await Bun.sleep(1100);
    expect(await replaceMfaChallengeOtp(token, "h1")).toBeNull();
    setMfaConfig({ challengeTtlSeconds: 300 });
  });
});

// ---------------------------------------------------------------------------
// WebAuthn registration challenges
// ---------------------------------------------------------------------------

describe("createWebAuthnRegistrationChallenge + consumeWebAuthnRegistrationChallenge", () => {
  test("creates and consumes a webauthn-registration challenge", async () => {
    const token = await createWebAuthnRegistrationChallenge("user1", "challenge-abc");
    const data = await consumeWebAuthnRegistrationChallenge(token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe("user1");
    expect(data!.challenge).toBe("challenge-abc");
  });

  test("second consume returns null (single-use)", async () => {
    const token = await createWebAuthnRegistrationChallenge("user1", "c1");
    await consumeWebAuthnRegistrationChallenge(token);
    expect(await consumeWebAuthnRegistrationChallenge(token)).toBeNull();
  });

  test("returns null for expired token", async () => {
    setMfaConfig({ challengeTtlSeconds: 1 });
    const token = await createWebAuthnRegistrationChallenge("user1", "c1");
    await Bun.sleep(1100);
    expect(await consumeWebAuthnRegistrationChallenge(token)).toBeNull();
    setMfaConfig({ challengeTtlSeconds: 300 });
  });
});
