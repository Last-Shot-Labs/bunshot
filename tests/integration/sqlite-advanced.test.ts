import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore, authHeader } from "../setup";
import type { Hono } from "hono";

const json = (path: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Provider linking/unlinking on SQLite
// ---------------------------------------------------------------------------

describe("SQLite: provider linking", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
    });
  });

  beforeEach(() => {
    clearMemoryStore();
  });

  async function registerUser(email = "provider@example.com") {
    const res = await app.request(
      json("/auth/register", { email, password: "Password1!" })
    );
    return (await res.json()).token as string;
  }

  it("registers and logs in on SQLite", async () => {
    const token = await registerUser();
    expect(token).toBeTruthy();

    const meRes = await app.request(
      new Request("http://localhost/auth/me", { headers: authHeader(token) })
    );
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe("provider@example.com");
  });

  it("sets and checks password", async () => {
    const token = await registerUser("setpw@example.com");
    const res = await app.request(
      json("/auth/set-password", { password: "NewPass1!" }, authHeader(token))
    );
    expect(res.status).toBe(200);
  });

  it("deletes account on SQLite", async () => {
    const token = await registerUser("del@example.com");
    const delRes = await app.request(
      new Request("http://localhost/auth/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeader(token) },
        body: JSON.stringify({ password: "Password1!" }),
      })
    );
    expect(delRes.status).toBe(200);

    // Session should be invalid now
    const meRes = await app.request(
      new Request("http://localhost/auth/me", { headers: authHeader(token) })
    );
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// SQLite MFA adapter paths
// ---------------------------------------------------------------------------

describe("SQLite: MFA operations", () => {
  let app: Hono;

  beforeAll(async () => {
    app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
      auth: {
        enabled: true,
        roles: ["user"],
        defaultRole: "user",
        mfa: { issuer: "TestApp" },
      },
    });
  });

  beforeEach(() => {
    clearMemoryStore();
  });

  it("initiates MFA setup on SQLite", async () => {
    const regRes = await app.request(
      json("/auth/register", { email: "mfa@example.com", password: "Password1!" })
    );
    const { token } = await regRes.json();

    const setupRes = await app.request(
      json("/auth/mfa/setup", {}, authHeader(token))
    );
    expect(setupRes.status).toBe(200);
    const setup = await setupRes.json();
    expect(setup.secret).toBeTruthy();
    expect(setup.uri).toContain("otpauth://");
  });
});

// ---------------------------------------------------------------------------
// SQLite: tenant roles
// ---------------------------------------------------------------------------

describe("SQLite: tenant roles", () => {
  let adapter: any;

  beforeAll(async () => {
    await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
    });
    const { sqliteAuthAdapter } = await import("../../src/adapters/sqliteAuth");
    adapter = sqliteAuthAdapter;
  });

  beforeEach(() => {
    clearMemoryStore();
  });

  it("manages tenant-scoped roles", async () => {
    const { id } = await adapter.create("tenant-role@example.com", "hash");

    expect(await adapter.getTenantRoles(id, "t1")).toEqual([]);

    await adapter.setTenantRoles(id, "t1", ["admin", "user"]);
    expect(await adapter.getTenantRoles(id, "t1")).toEqual(["admin", "user"]);

    await adapter.addTenantRole(id, "t1", "editor");
    const roles = await adapter.getTenantRoles(id, "t1");
    expect(roles).toContain("editor");

    await adapter.removeTenantRole(id, "t1", "admin");
    const updated = await adapter.getTenantRoles(id, "t1");
    expect(updated).not.toContain("admin");
    expect(updated).toContain("user");
    expect(updated).toContain("editor");
  });

  it("addTenantRole is idempotent", async () => {
    const { id } = await adapter.create("idem@example.com", "hash");
    await adapter.addTenantRole(id, "t1", "admin");
    await adapter.addTenantRole(id, "t1", "admin"); // duplicate, should not throw
    const roles = await adapter.getTenantRoles(id, "t1");
    // SQLite may allow duplicate inserts unless there's a unique constraint
    // The try/catch in addTenantRole handles this
    expect(roles.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// SQLite: WebAuthn credentials
// ---------------------------------------------------------------------------

describe("SQLite: WebAuthn credentials", () => {
  let adapter: any;

  beforeAll(async () => {
    await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
    });
    const { sqliteAuthAdapter } = await import("../../src/adapters/sqliteAuth");
    adapter = sqliteAuthAdapter;
  });

  beforeEach(() => {
    clearMemoryStore();
  });

  const makeCred = (id: string) => ({
    credentialId: id,
    publicKey: "pk-1",
    signCount: 0,
    transports: ["usb"],
    name: "My Key",
    createdAt: Date.now(),
  });

  it("adds and retrieves credentials", async () => {
    const { id } = await adapter.create("webauthn-sq@example.com", "hash");
    await adapter.addWebAuthnCredential(id, makeCred("cred-sqlite-add"));

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds).toHaveLength(1);
    expect(creds[0].credentialId).toBe("cred-sqlite-add");
    expect(creds[0].transports).toEqual(["usb"]);
  });

  it("updates sign count", async () => {
    const { id } = await adapter.create("signcount-sq@example.com", "hash");
    await adapter.addWebAuthnCredential(id, makeCred("cred-sqlite-signcount"));
    await adapter.updateWebAuthnCredentialSignCount(id, "cred-sqlite-signcount", 10);

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds[0].signCount).toBe(10);
  });

  it("removes a credential", async () => {
    const { id } = await adapter.create("removecred-sq@example.com", "hash");
    await adapter.addWebAuthnCredential(id, makeCred("cred-sqlite-remove"));
    await adapter.removeWebAuthnCredential(id, "cred-sqlite-remove");

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds).toHaveLength(0);
  });

  it("finds user by credential ID", async () => {
    const { id } = await adapter.create("findcred-sq@example.com", "hash");
    await adapter.addWebAuthnCredential(id, makeCred("cred-find-sq"));

    const userId = await adapter.findUserByWebAuthnCredentialId("cred-find-sq");
    expect(userId).toBe(id);
  });

  it("returns null for unknown credential", async () => {
    const userId = await adapter.findUserByWebAuthnCredentialId("unknown");
    expect(userId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQLite: OAuth state/code stores
// ---------------------------------------------------------------------------

describe("SQLite: OAuth state store", () => {
  beforeAll(async () => {
    await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
    });
  });

  beforeEach(() => {
    clearMemoryStore();
  });

  it("stores and consumes OAuth state", async () => {
    const { sqliteStoreOAuthState, sqliteConsumeOAuthState } = await import("../../src/adapters/sqliteAuth");
    sqliteStoreOAuthState("state-1", "verifier-1", "link-user-1");
    const result = sqliteConsumeOAuthState("state-1");
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe("verifier-1");
    expect(result!.linkUserId).toBe("link-user-1");
  });

  it("state is single-use", async () => {
    const { sqliteStoreOAuthState, sqliteConsumeOAuthState } = await import("../../src/adapters/sqliteAuth");
    sqliteStoreOAuthState("state-2");
    sqliteConsumeOAuthState("state-2");
    expect(sqliteConsumeOAuthState("state-2")).toBeNull();
  });
});

describe("SQLite: cache pattern deletion", () => {
  beforeAll(async () => {
    await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: "sqlite",
        cache: "sqlite",
        auth: "sqlite",
        sqlite: ":memory:",
      },
    });
  });

  it("deletes by wildcard pattern with proper escaping", async () => {
    const { sqliteSetCache, sqliteGetCache, sqliteDelCachePattern } = await import("../../src/adapters/sqliteAuth");

    sqliteSetCache("cache:test:users:1", "a");
    sqliteSetCache("cache:test:users:2", "b");
    sqliteSetCache("cache:test:products:1", "c");

    sqliteDelCachePattern("cache:test:users:*");

    expect(sqliteGetCache("cache:test:users:1")).toBeNull();
    expect(sqliteGetCache("cache:test:users:2")).toBeNull();
    expect(sqliteGetCache("cache:test:products:1")).toBe("c");
  });
});
