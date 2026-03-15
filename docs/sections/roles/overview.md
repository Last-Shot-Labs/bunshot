## Roles

Declare roles in `createServer({ auth: { roles: ["admin", "editor", "user"], defaultRole: "user" } })`. The default role is auto-assigned on registration.

```ts
import { userAuth, requireRole, addUserRole } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth, requireRole("admin"));
await addUserRole(userId, "admin"); // also: setUserRoles, removeUserRole
```

Tenant-scoped roles are supported when multi-tenancy is enabled — `requireRole` checks tenant roles when `tenantId` is in context, falls back to app-wide roles otherwise. Use `requireRole.global("superadmin")` to always check app-wide roles.
