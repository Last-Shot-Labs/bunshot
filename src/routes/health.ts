import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter } from "@lib/context";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["Core"],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              status: z.enum(["ok"]),
              timestamp: z.string(),
            }),
          },
        },
        description: "Service health check",
      },
    },
  }),
  (c) => c.json({ status: "ok" as "ok", timestamp: new Date().toISOString() })
);
