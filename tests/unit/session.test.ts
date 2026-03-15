import { describe, test, expect, beforeEach } from "bun:test";
import {
  setSessionStore,
  createSession,
  getSession,
  deleteSession,
  getUserSessions,
  getActiveSessionCount,
  evictOldestSession,
  deleteUserSessions,
  updateSessionLastActive,
  setRefreshToken,
  getSessionByRefreshToken,
  rotateRefreshToken,
} from "../../src/lib/session";
import { clearMemoryStore } from "../../src/adapters/memoryAuth";
import { setRefreshTokenConfig, setPersistSessionMetadata, setIncludeInactiveSessions } from "../../src/lib/appConfig";

setSessionStore("memory");

beforeEach(() => {
  clearMemoryStore();
  setPersistSessionMetadata(true);
  setIncludeInactiveSessions(false);
  setRefreshTokenConfig(null);
});

// ---------------------------------------------------------------------------
// createSession + getSession
// ---------------------------------------------------------------------------

describe("createSession + getSession", () => {
  test("creates a session and retrieves the token", async () => {
    await createSession("user1", "token-abc", "sid-1");
    const token = await getSession("sid-1");
    expect(token).toBe("token-abc");
  });

  test("returns null for non-existent sessionId", async () => {
    expect(await getSession("unknown")).toBeNull();
  });

  test("stores session metadata", async () => {
    await createSession("user1", "token-abc", "sid-1", {
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
    });
    const sessions = await getUserSessions("user1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ipAddress).toBe("1.2.3.4");
    expect(sessions[0].userAgent).toBe("TestAgent/1.0");
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe("deleteSession", () => {
  test("removes a session so getSession returns null", async () => {
    await createSession("user1", "token-abc", "sid-1");
    await deleteSession("sid-1");
    expect(await getSession("sid-1")).toBeNull();
  });

  test("is idempotent — deleting twice does not throw", async () => {
    await createSession("user1", "token-abc", "sid-1");
    await deleteSession("sid-1");
    await deleteSession("sid-1"); // no throw
    expect(await getSession("sid-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUserSessions
// ---------------------------------------------------------------------------

describe("getUserSessions", () => {
  test("returns empty array for unknown user", async () => {
    expect(await getUserSessions("nobody")).toEqual([]);
  });

  test("returns all active sessions for a user", async () => {
    await createSession("user1", "t1", "sid-1");
    await createSession("user1", "t2", "sid-2");
    const sessions = await getUserSessions("user1");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.isActive)).toBe(true);
  });

  test("excludes deleted sessions by default", async () => {
    await createSession("user1", "t1", "sid-1");
    await createSession("user1", "t2", "sid-2");
    await deleteSession("sid-1");
    const sessions = await getUserSessions("user1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sid-2");
  });

  test("includes inactive sessions when configured", async () => {
    setIncludeInactiveSessions(true);
    await createSession("user1", "t1", "sid-1");
    await createSession("user1", "t2", "sid-2");
    await deleteSession("sid-1");
    const sessions = await getUserSessions("user1");
    expect(sessions).toHaveLength(2);
    const inactive = sessions.find((s) => s.sessionId === "sid-1");
    expect(inactive?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getActiveSessionCount
// ---------------------------------------------------------------------------

describe("getActiveSessionCount", () => {
  test("returns 0 for unknown user", async () => {
    expect(await getActiveSessionCount("nobody")).toBe(0);
  });

  test("returns correct count with mixed active/deleted sessions", async () => {
    await createSession("user1", "t1", "sid-1");
    await createSession("user1", "t2", "sid-2");
    await createSession("user1", "t3", "sid-3");
    await deleteSession("sid-2");
    expect(await getActiveSessionCount("user1")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// evictOldestSession
// ---------------------------------------------------------------------------

describe("evictOldestSession", () => {
  test("evicts the session with the earliest createdAt", async () => {
    await createSession("user1", "t1", "sid-1");
    // small delay to ensure different createdAt
    await Bun.sleep(10);
    await createSession("user1", "t2", "sid-2");
    await evictOldestSession("user1");
    expect(await getSession("sid-1")).toBeNull();
    expect(await getSession("sid-2")).toBe("t2");
  });

  test("no-op when user has no sessions", async () => {
    await evictOldestSession("nobody"); // should not throw
  });
});

// ---------------------------------------------------------------------------
// deleteUserSessions
// ---------------------------------------------------------------------------

describe("deleteUserSessions", () => {
  test("deletes all sessions for a user", async () => {
    await createSession("user1", "t1", "sid-1");
    await createSession("user1", "t2", "sid-2");
    await deleteUserSessions("user1");
    expect(await getSession("sid-1")).toBeNull();
    expect(await getSession("sid-2")).toBeNull();
  });

  test("works when user has zero sessions", async () => {
    await deleteUserSessions("nobody"); // should not throw
  });
});

// ---------------------------------------------------------------------------
// updateSessionLastActive
// ---------------------------------------------------------------------------

describe("updateSessionLastActive", () => {
  test("updates lastActiveAt timestamp", async () => {
    await createSession("user1", "t1", "sid-1");
    const before = (await getUserSessions("user1"))[0].lastActiveAt;
    await Bun.sleep(10);
    await updateSessionLastActive("sid-1");
    const after = (await getUserSessions("user1"))[0].lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  test("no-op for non-existent sessionId", async () => {
    await updateSessionLastActive("unknown"); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Refresh token API
// ---------------------------------------------------------------------------

describe("setRefreshToken + getSessionByRefreshToken", () => {
  test("stores and looks up a refresh token", async () => {
    await createSession("user1", "access-1", "sid-1");
    await setRefreshToken("sid-1", "refresh-1");
    const result = await getSessionByRefreshToken("refresh-1");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sid-1");
    expect(result!.userId).toBe("user1");
  });

  test("returns null for unknown refresh token", async () => {
    expect(await getSessionByRefreshToken("unknown")).toBeNull();
  });
});

describe("rotateRefreshToken", () => {
  test("moves current to prev and sets new token", async () => {
    setRefreshTokenConfig({ rotationGraceSeconds: 30 });
    await createSession("user1", "access-1", "sid-1");
    await setRefreshToken("sid-1", "refresh-1");
    await rotateRefreshToken("sid-1", "refresh-2", "access-2");

    // New token works
    const result = await getSessionByRefreshToken("refresh-2");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sid-1");

    // Access token was updated
    const accessToken = await getSession("sid-1");
    expect(accessToken).toBe("access-2");
  });

  test("previous token works within grace window", async () => {
    setRefreshTokenConfig({ rotationGraceSeconds: 30 });
    await createSession("user1", "access-1", "sid-1");
    await setRefreshToken("sid-1", "refresh-1");
    await rotateRefreshToken("sid-1", "refresh-2", "access-2");

    // Old token within grace window returns current refresh token
    const result = await getSessionByRefreshToken("refresh-1");
    expect(result).not.toBeNull();
    expect(result!.newRefreshToken).toBe("refresh-2");
  });

  test("previous token after grace window triggers theft detection", async () => {
    setRefreshTokenConfig({ rotationGraceSeconds: 1 });
    await createSession("user1", "access-1", "sid-1");
    await setRefreshToken("sid-1", "refresh-1");
    await rotateRefreshToken("sid-1", "refresh-2", "access-2");

    // Wait for grace window to expire
    await Bun.sleep(1100);

    // Old token after grace window → session deleted (theft detection)
    const result = await getSessionByRefreshToken("refresh-1");
    expect(result).toBeNull();

    // Session should be invalidated
    expect(await getSession("sid-1")).toBeNull();
  });
});
