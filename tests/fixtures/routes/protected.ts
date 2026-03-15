import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import { requireRole } from "@middleware/requireRole";
import { cacheResponse } from "@middleware/cacheResponse";

export const router = createRouter();

router.get("/protected/admin", userAuth, requireRole("admin"), (c) => {
  return c.json({ message: "admin only" });
});

router.get("/cached", cacheResponse({ key: "test-cached", ttl: 60, store: "memory" }), (c) => {
  return c.json({ time: Date.now() });
});
