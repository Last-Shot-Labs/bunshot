import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "@lib/crypto";

const isProd = process.env.NODE_ENV === "production";
const validToken = isProd ? process.env.BEARER_TOKEN_PROD! : process.env.BEARER_TOKEN_DEV!;

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || !timingSafeEqual(token, validToken)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};
