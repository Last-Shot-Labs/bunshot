## Adding Routes

Drop a file in your `routes/` directory that exports a `router` — routes are auto-discovered via glob. Subdirectories are supported.

```ts
import { z } from "zod";
import { createRoute, createRouter } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/hello",
    responses: {
      200: { content: { "application/json": { schema: z.object({ message: z.string() }) } }, description: "Hello" },
    },
  }),
  (c) => c.json({ message: "Hello world!" }, 200)
);
```

Import `createRoute` from `@lastshotlabs/bunshot` (not `@hono/zod-openapi`) to get automatic OpenAPI schema registration. Four registration methods are available — route-level auto-registration, directory/glob auto-discovery via `modelSchemas`, batch explicit via `registerSchemas`, and single explicit via `registerSchema`. Use `withSecurity` to add auth requirements without breaking type inference.
