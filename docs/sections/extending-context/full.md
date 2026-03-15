## Extending the Context (Custom Variables)

When building a tenant app or any app that needs extra typed context variables (beyond the built-in), extend `AppEnv["Variables"]` and create a typed router factory.

```ts
// src/lib/context.ts
import { createRouter as coreCreateRouter, type AppEnv } from "@lastshotlabs/bunshot";
import type { OpenAPIHono } from "@hono/zod-openapi";

export type MyVariables = AppEnv["Variables"] & {
  tenantId: string;
};

export type MyEnv = { Variables: MyVariables };

export const createRouter = () => coreCreateRouter() as unknown as OpenAPIHono<MyEnv>;
```

Use the local `createRouter` instead of the one from the package — your routes will then have full TypeScript access to the extra variables:

```ts
// src/routes/items.ts
import { createRouter } from "../lib/context";
import { userAuth } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.use("/items", userAuth);

router.get("/items", async (c) => {
  const tenantId = c.get("tenantId"); // fully typed
  const userId   = c.get("userId");   // still available from AppEnv
  return c.json({ tenantId, userId });
});
```

Populate the extra variables from a global middleware:

```ts
// src/middleware/tenant.ts
import type { MiddlewareHandler } from "hono";
import type { MyEnv } from "../lib/context";

export const tenantMiddleware: MiddlewareHandler<MyEnv> = async (c, next) => {
  const tenantId = c.req.header("x-tenant-id") ?? "default";
  c.set("tenantId", tenantId);
  await next();
};
```

Then register it in `createServer`:

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  middleware: [tenantMiddleware],
});
```
