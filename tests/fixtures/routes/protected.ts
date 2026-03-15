import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import { requireRole } from "@middleware/requireRole";
import { cacheResponse } from "@middleware/cacheResponse";

export const router = createRouter();

router.get("/protected/admin", userAuth, requireRole("admin"), (c) => {
  return c.json({ message: "admin only" });
});

router.get("/protected/multi-role", userAuth, requireRole("admin", "moderator"), (c) => {
  return c.json({ message: "multi-role access" });
});

router.get("/protected/global-role", userAuth, requireRole.global("admin"), (c) => {
  return c.json({ message: "global admin" });
});

router.get(
  "/protected/tenant-admin",
  async (c, next) => {
    const tenantId = c.req.header("x-tenant-id") ?? null;
    if (tenantId) c.set("tenantId", tenantId);
    await next();
  },
  userAuth,
  requireRole("admin"),
  (c) => {
    return c.json({ message: "tenant admin" });
  }
);

router.get("/cached", cacheResponse({ key: "test-cached", ttl: 60, store: "memory" }), (c) => {
  return c.json({ time: Date.now() });
});

router.get("/cached-dynamic", cacheResponse({ key: (c) => "dyn:" + (c.req.query("k") ?? "default"), ttl: 60, store: "memory" }), (c) => {
  return c.json({ time: Date.now(), key: c.req.query("k") });
});

router.get("/cached-default", cacheResponse({ key: "test-cached-default", ttl: 60 }), (c) => {
  return c.json({ time: Date.now() });
});

router.post("/protected/action", userAuth, (c) => {
  return c.json({ message: "action performed" });
});

router.post("/public/action", (c) => {
  return c.json({ message: "public action performed" });
});
