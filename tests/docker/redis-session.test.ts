import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { connectTestRedis, flushTestServices, disconnectTestServices } from "../setup-docker";
import {
  setSessionStore,
  createSession,
  getSession,
  deleteSession,
  getUserSessions,
  getActiveSessionCount,
  evictOldestSession,
  updateSessionLastActive,
  setRefreshToken,
  getSessionByRefreshToken,
  rotateRefreshToken,
} from "../../src/lib/session";
import {
  setAppName,
  setPersistSessionMetadata,
  setIncludeInactiveSessions,
  setRefreshTokenConfig,
} from "../../src/lib/appConfig";

beforeAll(async () => {
  await connectTestRedis();
  setSessionStore("redis");
  setAppName("test-app");
  setPersistSessionMetadata(false);
  setIncludeInactiveSessions(false);
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe("Redis session store", () => {
  it("creates and retrieves a session", async () => {
    await createSession("user-1", "jwt-token-1", "sess-1", {
      ipAddress: "127.0.0.1",
      userAgent: "TestAgent",
    });
    const token = await getSession("sess-1");
    expect(token).toBe("jwt-token-1");
  });

  it("returns null for non-existent session", async () => {
    expect(await getSession("nope")).toBeNull();
  });

  it("deletes a session", async () => {
    await createSession("user-1", "jwt-token-1", "sess-del");
    await deleteSession("sess-del");
    expect(await getSession("sess-del")).toBeNull();
  });

  it("lists user sessions", async () => {
    await createSession("user-list", "t1", "sess-a", { ipAddress: "1.1.1.1" });
    await createSession("user-list", "t2", "sess-b", { userAgent: "Agent2" });

    const sessions = await getUserSessions("user-list");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.isActive)).toBe(true);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
  });

  it("counts active sessions", async () => {
    await createSession("user-count", "t1", "s1");
    await createSession("user-count", "t2", "s2");
    expect(await getActiveSessionCount("user-count")).toBe(2);

    await deleteSession("s1");
    expect(await getActiveSessionCount("user-count")).toBe(1);
  });

  it("evicts oldest session", async () => {
    await createSession("user-evict", "t1", "oldest");
    // Small delay to ensure different createdAt
    await new Promise((r) => setTimeout(r, 50));
    await createSession("user-evict", "t2", "newest");

    await evictOldestSession("user-evict");
    expect(await getSession("oldest")).toBeNull();
    expect(await getSession("newest")).toBe("t2");
  });

  it("updates lastActiveAt", async () => {
    await createSession("user-active", "t1", "sess-active");
    const before = (await getUserSessions("user-active"))[0].lastActiveAt;
    await new Promise((r) => setTimeout(r, 50));
    await updateSessionLastActive("sess-active");
    const after = (await getUserSessions("user-active"))[0].lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  it("includes metadata in session info", async () => {
    await createSession("user-meta", "t1", "sess-meta", {
      ipAddress: "10.0.0.1",
      userAgent: "Chrome/100",
    });
    const sessions = await getUserSessions("user-meta");
    expect(sessions[0].ipAddress).toBe("10.0.0.1");
    expect(sessions[0].userAgent).toBe("Chrome/100");
  });

  // -----------------------------------------------------------------------
  // Refresh tokens
  // -----------------------------------------------------------------------

  describe("refresh tokens", () => {
    beforeAll(() => {
      setRefreshTokenConfig({
        accessTokenExpiry: "15m",
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 30,
      });
    });

    it("sets and retrieves by refresh token", async () => {
      await createSession("user-rt", "access-1", "sess-rt");
      await setRefreshToken("sess-rt", "refresh-1");

      const result = await getSessionByRefreshToken("refresh-1");
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sess-rt");
      expect(result!.userId).toBe("user-rt");
    });

    it("returns null for unknown refresh token", async () => {
      expect(await getSessionByRefreshToken("unknown")).toBeNull();
    });

    it("rotates refresh token with grace window", async () => {
      await createSession("user-rotate", "access-old", "sess-rotate");
      await setRefreshToken("sess-rotate", "refresh-old");
      await rotateRefreshToken("sess-rotate", "refresh-new", "access-new");

      // New token works
      const newResult = await getSessionByRefreshToken("refresh-new");
      expect(newResult).not.toBeNull();
      expect(newResult!.sessionId).toBe("sess-rotate");

      // Old token works within grace window
      const graceResult = await getSessionByRefreshToken("refresh-old");
      expect(graceResult).not.toBeNull();
      expect(graceResult!.newRefreshToken).toBe("refresh-new");
    });

    it("detects theft when old token used after grace window", async () => {
      setRefreshTokenConfig({
        accessTokenExpiry: "15m",
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 0, // no grace window
      });

      await createSession("user-theft", "access-1", "sess-theft");
      await setRefreshToken("sess-theft", "rt-original");
      await rotateRefreshToken("sess-theft", "rt-rotated", "access-2");

      // Wait a tick so grace window (0s) expires
      await new Promise((r) => setTimeout(r, 50));

      // Old token used after grace → session invalidated
      const result = await getSessionByRefreshToken("rt-original");
      expect(result).toBeNull();

      // Session should be deleted (theft detection)
      expect(await getSession("sess-theft")).toBeNull();

      // Reset grace window
      setRefreshTokenConfig({
        accessTokenExpiry: "15m",
        refreshTokenExpiry: 86400,
        rotationGraceSeconds: 30,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Persist metadata mode
  // -----------------------------------------------------------------------

  describe("persist metadata mode", () => {
    beforeAll(() => setPersistSessionMetadata(true));
    afterAll(() => setPersistSessionMetadata(false));

    it("soft-deletes session (nulls token, keeps record)", async () => {
      await createSession("user-persist", "t1", "sess-persist");
      await deleteSession("sess-persist");

      // Token should be null (not returned by getSession)
      expect(await getSession("sess-persist")).toBeNull();
    });
  });
});
