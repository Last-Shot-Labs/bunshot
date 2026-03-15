import { describe, test, expect, beforeEach } from "bun:test";
import {
  setEmailVerificationStore,
  createVerificationToken,
  getVerificationToken,
  deleteVerificationToken,
} from "../../src/lib/emailVerification";
import { setEmailVerificationConfig } from "../../src/lib/appConfig";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";

setEmailVerificationStore("memory");
setEmailVerificationConfig({ onSend: async () => {}, tokenExpiry: 300 });

beforeEach(() => {
  clearMemoryStore();
});

// ---------------------------------------------------------------------------
// createVerificationToken + getVerificationToken
// ---------------------------------------------------------------------------

describe("createVerificationToken + getVerificationToken", () => {
  test("creates a token and retrieves its data", async () => {
    const token = await createVerificationToken("user1", "user@example.com");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const data = await getVerificationToken(token);
    expect(data).not.toBeNull();
    expect(data!.userId).toBe("user1");
    expect(data!.email).toBe("user@example.com");
  });

  test("returns null for non-existent token", async () => {
    expect(await getVerificationToken("nonexistent")).toBeNull();
  });

  test("returns null for expired token", async () => {
    setEmailVerificationConfig({ onSend: async () => {}, tokenExpiry: 1 });
    const token = await createVerificationToken("user1", "user@example.com");
    await Bun.sleep(1100);
    expect(await getVerificationToken(token)).toBeNull();
    setEmailVerificationConfig({ onSend: async () => {}, tokenExpiry: 300 });
  });
});

// ---------------------------------------------------------------------------
// deleteVerificationToken
// ---------------------------------------------------------------------------

describe("deleteVerificationToken", () => {
  test("deletes token so subsequent get returns null", async () => {
    const token = await createVerificationToken("user1", "user@example.com");
    await deleteVerificationToken(token);
    expect(await getVerificationToken(token)).toBeNull();
  });

  test("is safe to call on non-existent token", async () => {
    await deleteVerificationToken("nonexistent"); // should not throw
  });
});
