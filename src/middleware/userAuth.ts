import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lib/context";

export const userAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("authUserId")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};
