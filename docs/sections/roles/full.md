## Roles

### Setup

Declare the valid roles for your app in `createServer` / `createApp`:

```ts
await createServer({
  auth: {
    roles: ["admin", "editor", "user"],
    defaultRole: "user",  // automatically assigned on /auth/register
  },
  // ...
});
```

`roles` makes the list available anywhere via `getAppRoles()`. `defaultRole` is assigned to every new user that registers via `POST /auth/register` — no extra code needed.

### Assigning roles to a user

Three helpers are available depending on what you need:

| Helper | Behaviour |
|---|---|
| `setUserRoles(userId, roles)` | Replace all roles — pass the full desired set |
| `addUserRole(userId, role)` | Add a single role, leaving others unchanged |
| `removeUserRole(userId, role)` | Remove a single role, leaving others unchanged |

```ts
import { setUserRoles, addUserRole, removeUserRole, userAuth, requireRole } from "@lastshotlabs/bunshot";

// promote a user to admin
router.post("/admin/users/:id/promote", userAuth, requireRole("admin"), async (c) => {
  await addUserRole(c.req.param("id"), "admin");
  return c.json({ ok: true });
});

// revoke a role
router.post("/admin/users/:id/demote", userAuth, requireRole("admin"), async (c) => {
  await removeUserRole(c.req.param("id"), "admin");
  return c.json({ ok: true });
});

// replace all roles at once
router.put("/admin/users/:id/roles", userAuth, requireRole("admin"), async (c) => {
  const { roles } = await c.req.json();
  await setUserRoles(c.req.param("id"), roles);
  return c.json({ ok: true });
});
```

### Protecting routes by role

`requireRole` is a middleware factory. It lazy-fetches roles on the first role-checked request and caches them on the Hono context, so multiple `requireRole` calls in a middleware chain only hit the DB once.

```ts
import { userAuth, requireRole } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth, requireRole("admin"));
router.use("/content", userAuth, requireRole("admin", "editor")); // allow either role
```

| Scenario | Response |
|---|---|
| No session | `401 Unauthorized` |
| Authenticated, wrong role | `403 Forbidden` |
| Authenticated, correct role | passes through |

### Custom adapter with roles

If you're using a custom `authAdapter`, implement the role methods to back role operations with your own store:

| Method | Required for |
|---|---|
| `getRoles(userId)` | `requireRole` middleware |
| `setRoles(userId, roles)` | `defaultRole` assignment on registration, full replace |
| `addRole(userId, role)` | Granular role addition |
| `removeRole(userId, role)` | Granular role removal |

All are optional — only implement what your app uses. `setRoles` is **required** if you configure `defaultRole` (the app will throw at startup if this combination is misconfigured). The exported helpers `setUserRoles`, `addUserRole`, and `removeUserRole` route through your adapter, so they work regardless of which store you use.

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async getRoles(userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    return user?.roles ?? [];
  },
  async setRoles(userId, roles) {
    await db.update(users).set({ roles }).where(eq(users.id, userId));
  },
  async addRole(userId, role) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user && !user.roles.includes(role)) {
      await db.update(users).set({ roles: [...user.roles, role] }).where(eq(users.id, userId));
    }
  },
  async removeRole(userId, role) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user) {
      await db.update(users).set({ roles: user.roles.filter((r: string) => r !== role) }).where(eq(users.id, userId));
    }
  },
};
```

### Tenant-scoped roles

When multi-tenancy is enabled (see below), `requireRole` automatically checks **tenant-scoped roles** instead of app-wide roles when a `tenantId` is present in the request context.

```ts
// Assign a tenant-scoped role
import { addTenantRole, setTenantRoles, removeTenantRole, getTenantRoles } from "@lastshotlabs/bunshot";

await addTenantRole(userId, "acme", "admin");
await setTenantRoles(userId, "acme", ["admin", "editor"]);
await removeTenantRole(userId, "acme", "editor");
const roles = await getTenantRoles(userId, "acme"); // ["admin"]
```

`requireRole("admin")` checks tenant-scoped roles when `tenantId` is in context, and falls back to app-wide roles when there is no tenant context. Use `requireRole.global("superadmin")` to always check app-wide roles regardless of tenant.

```ts
router.use("/tenant-admin", userAuth, requireRole("admin"));           // checks tenant roles when in tenant context
router.use("/super-admin", userAuth, requireRole.global("superadmin")); // always checks app-wide roles
```

If you're using a custom `authAdapter`, implement the tenant role methods:

| Method | Purpose |
|---|---|
| `getTenantRoles(userId, tenantId)` | Required for tenant-scoped `requireRole` |
| `setTenantRoles(userId, tenantId, roles)` | Full replace |
| `addTenantRole(userId, tenantId, role)` | Granular addition |
| `removeTenantRole(userId, tenantId, role)` | Granular removal |
