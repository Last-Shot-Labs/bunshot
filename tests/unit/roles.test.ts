import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createTestApp, clearMemoryStore } from "../setup";
import { getAuthAdapter } from "../../src/lib/authAdapter";
import {
  setUserRoles,
  addUserRole,
  removeUserRole,
  getTenantRoles,
  setTenantRoles,
  addTenantRole,
  removeTenantRole,
} from "../../src/lib/roles";

let adapter: ReturnType<typeof getAuthAdapter>;

beforeAll(async () => {
  await createTestApp();
  adapter = getAuthAdapter();
});

beforeEach(() => {
  clearMemoryStore();
});

async function createUser(email = "roles@example.com") {
  const user = await adapter.create(email, await Bun.password.hash("password123"));
  return user.id;
}

// ---------------------------------------------------------------------------
// App-wide roles
// ---------------------------------------------------------------------------

describe("setUserRoles", () => {
  test("sets roles on a user", async () => {
    const userId = await createUser();
    await setUserRoles(userId, ["admin", "editor"]);
    const roles = await adapter.getRoles!(userId);
    expect(roles).toEqual(["admin", "editor"]);
  });

  test("replaces existing roles", async () => {
    const userId = await createUser();
    await setUserRoles(userId, ["admin"]);
    await setUserRoles(userId, ["editor"]);
    const roles = await adapter.getRoles!(userId);
    expect(roles).toEqual(["editor"]);
  });
});

describe("addUserRole", () => {
  test("adds a role", async () => {
    const userId = await createUser();
    await addUserRole(userId, "admin");
    const roles = await adapter.getRoles!(userId);
    expect(roles).toContain("admin");
  });
});

describe("removeUserRole", () => {
  test("removes a role", async () => {
    const userId = await createUser();
    await addUserRole(userId, "admin");
    await addUserRole(userId, "editor");
    await removeUserRole(userId, "admin");
    const roles = await adapter.getRoles!(userId);
    expect(roles).not.toContain("admin");
    expect(roles).toContain("editor");
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped roles
// ---------------------------------------------------------------------------

describe("getTenantRoles", () => {
  test("returns roles for a userId+tenantId pair", async () => {
    const userId = await createUser();
    await setTenantRoles(userId, "tenant-1", ["admin"]);
    const roles = await getTenantRoles(userId, "tenant-1");
    expect(roles).toEqual(["admin"]);
  });

  test("returns empty array for unknown tenant", async () => {
    const userId = await createUser();
    const roles = await getTenantRoles(userId, "nonexistent");
    expect(roles).toEqual([]);
  });
});

describe("setTenantRoles", () => {
  test("replaces tenant roles", async () => {
    const userId = await createUser();
    await setTenantRoles(userId, "t1", ["admin"]);
    await setTenantRoles(userId, "t1", ["viewer"]);
    const roles = await getTenantRoles(userId, "t1");
    expect(roles).toEqual(["viewer"]);
  });
});

describe("addTenantRole", () => {
  test("adds a single tenant role", async () => {
    const userId = await createUser();
    await addTenantRole(userId, "t1", "editor");
    const roles = await getTenantRoles(userId, "t1");
    expect(roles).toContain("editor");
  });
});

describe("removeTenantRole", () => {
  test("removes a single tenant role", async () => {
    const userId = await createUser();
    await setTenantRoles(userId, "t1", ["admin", "editor"]);
    await removeTenantRole(userId, "t1", "admin");
    const roles = await getTenantRoles(userId, "t1");
    expect(roles).not.toContain("admin");
    expect(roles).toContain("editor");
  });
});
