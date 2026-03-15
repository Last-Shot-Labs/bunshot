import { describe, test, expect } from "bun:test";
import { setMfaConfig } from "@lib/appConfig";
import { generateEmailOtpCode, verifyEmailOtp } from "@services/mfa";

// generateEmailOtpCode reads config for default code length
setMfaConfig({ emailOtp: { onSend: async () => {} } });

describe("generateEmailOtpCode", () => {
  test("generates a 6-digit numeric code by default", () => {
    const { code, hash } = generateEmailOtpCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
    expect(hash).toBeString();
    expect(hash.length).toBeGreaterThan(0);
  });

  test("generates a code of custom length", () => {
    const { code } = generateEmailOtpCode(8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^\d{8}$/);
  });

  test("produces unique codes on successive calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateEmailOtpCode().code));
    // With 6 digits and 20 samples, collisions are astronomically unlikely
    expect(codes.size).toBeGreaterThan(1);
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

  test("returns false for empty code", () => {
    const { hash } = generateEmailOtpCode();
    expect(verifyEmailOtp(hash, "")).toBe(false);
  });
});
