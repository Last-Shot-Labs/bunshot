import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore } from "../setup";
import { storeOAuthState, consumeOAuthState, setOAuthStateStore } from "../../src/lib/oauth";
import { storeOAuthCode, consumeOAuthCode, setOAuthCodeStore } from "../../src/lib/oauthCode";

beforeAll(async () => {
  await createTestApp();
  setOAuthStateStore("memory");
  setOAuthCodeStore("memory");
});

beforeEach(() => {
  clearMemoryStore();
});

// ---------------------------------------------------------------------------
// OAuth State
// ---------------------------------------------------------------------------

describe("storeOAuthState + consumeOAuthState", () => {
  test("round-trip stores and retrieves state", async () => {
    await storeOAuthState("state-1");
    const result = await consumeOAuthState("state-1");
    expect(result).not.toBeNull();
  });

  test("consuming same state twice returns null", async () => {
    await storeOAuthState("state-2");
    await consumeOAuthState("state-2");
    const result = await consumeOAuthState("state-2");
    expect(result).toBeNull();
  });

  test("preserves codeVerifier", async () => {
    await storeOAuthState("state-3", "verifier-abc");
    const result = await consumeOAuthState("state-3");
    expect(result!.codeVerifier).toBe("verifier-abc");
  });

  test("preserves linkUserId", async () => {
    await storeOAuthState("state-4", undefined, "user-xyz");
    const result = await consumeOAuthState("state-4");
    expect(result!.linkUserId).toBe("user-xyz");
  });

  test("returns null for non-existent state", async () => {
    const result = await consumeOAuthState("nonexistent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth Code
// ---------------------------------------------------------------------------

describe("storeOAuthCode + consumeOAuthCode", () => {
  test("round-trip stores and retrieves code", async () => {
    const code = await storeOAuthCode({ token: "jwt-token", userId: "u1" });
    expect(typeof code).toBe("string");
    const result = await consumeOAuthCode(code);
    expect(result).not.toBeNull();
    expect(result!.token).toBe("jwt-token");
    expect(result!.userId).toBe("u1");
  });

  test("consuming same code twice returns null", async () => {
    const code = await storeOAuthCode({ token: "jwt", userId: "u2" });
    await consumeOAuthCode(code);
    const result = await consumeOAuthCode(code);
    expect(result).toBeNull();
  });

  test("preserves full payload", async () => {
    const code = await storeOAuthCode({
      token: "t",
      userId: "u3",
      email: "test@example.com",
      refreshToken: "rt-123",
    });
    const result = await consumeOAuthCode(code);
    expect(result!.email).toBe("test@example.com");
    expect(result!.refreshToken).toBe("rt-123");
  });
});
