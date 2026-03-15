import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "@lib/crypto";

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const isProd = process.env.NODE_ENV === "production";
  const validToken = isProd ? process.env.BEARER_TOKEN_PROD : process.env.BEARER_TOKEN_DEV;
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || !validToken || !timingSafeEqual(token, validToken)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};
