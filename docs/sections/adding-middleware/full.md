## Adding Middleware

### Global (runs on every request)

Pass via `middleware` config — injected after `identify`, before route matching:

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  middleware: [myMiddleware],
});
```

Write it using core's exported types:

```ts
// src/middleware/tenant.ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@lastshotlabs/bunshot";

export const tenantMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // c.get("userId") is available — identify has already run
  await next();
};
```

### Per-route

```ts
import { userAuth, rateLimit } from "@lastshotlabs/bunshot";

router.use("/admin", userAuth);
router.use("/admin", rateLimit({ windowMs: 60_000, max: 10 }));
```
