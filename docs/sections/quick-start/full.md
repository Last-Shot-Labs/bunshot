## Quick Start

```bash
bun add @lastshotlabs/bunshot hono zod
```

```ts
// src/index.ts
import { createServer } from "@lastshotlabs/bunshot";

await createServer({
  routesDir: import.meta.dir + "/routes",
  db: { auth: "memory", mongo: false, redis: false, sessions: "memory", cache: "memory" },
});
```

```ts
// src/routes/hello.ts
import { z } from "zod";
import { createRoute, createRouter } from "@lastshotlabs/bunshot";

export const router = createRouter();

router.openapi(
  createRoute({
    method: "get",
    path: "/hello",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ message: z.string() }) } },
        description: "Hello",
      },
    },
  }),
  (c) => c.json({ message: "Hello world!" }, 200)
);
```

```bash
bun run src/index.ts
```

Auth, OpenAPI docs (`/docs`), health check, and WebSocket are all live. No databases required — swap `"memory"` for `"redis"` / `"mongo"` / `"sqlite"` when you're ready.
