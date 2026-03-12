import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { getAppName } from "@lib/appConfig";
import { createRouter } from "@lib/context";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Core"],
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ message: z.string() }) } },
        description: "API is running",
      },
    },
  }),
  (c) => c.json({ message: `${getAppName()} is running` })
);
