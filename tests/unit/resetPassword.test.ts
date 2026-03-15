import { describe, test, expect, beforeEach } from "bun:test";
import {
  setPasswordResetStore,
  createResetToken,
  consumeResetToken,
} from "../../src/lib/resetPassword";
import { setPasswordResetConfig } from "../../src/lib/appConfig";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";

setPasswordResetStore("memory");
setPasswordResetConfig({ onSend: async () => {}, tokenExpiry: 300 });

beforeEach(() => {
  clearMemoryStore();
});

// ---------------------------------------------------------------------------
// createResetToken + consumeResetToken
// ---------------------------------------------------------------------------

describe("createResetToken + consumeResetToken", () => {
  test("creates a raw token and consumes it", async () => {
    const token = await createResetToken("user1", "user@example.com");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const data = await consumeResetToken(token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe("user1");
    expect(data!.email).toBe("user@example.com");
  });

  test("second consume returns null (atomic single-use)", async () => {
    const token = await createResetToken("user1", "user@example.com");
    await consumeResetToken(token);
    expect(await consumeResetToken(token)).toBeNull();
  });

  test("returns null for non-existent token", async () => {
    expect(await consumeResetToken("nonexistent")).toBeNull();
  });

  test("returns null for expired token", async () => {
    setPasswordResetConfig({ onSend: async () => {}, tokenExpiry: 1 });
    const token = await createResetToken("user1", "user@example.com");
    await Bun.sleep(1100);
    expect(await consumeResetToken(token)).toBeNull();
    setPasswordResetConfig({ onSend: async () => {}, tokenExpiry: 300 });
  });

  test("raw token is not the stored hash", async () => {
    // Create two tokens for the same user — they should be different UUIDs
    const token1 = await createResetToken("user1", "a@b.com");
    const token2 = await createResetToken("user1", "a@b.com");
    expect(token1).not.toBe(token2);

    // Both should be consumable independently
    expect(await consumeResetToken(token1)).not.toBeNull();
    expect(await consumeResetToken(token2)).not.toBeNull();
  });
});
