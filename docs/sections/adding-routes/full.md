## Adding Routes

Drop a file in your `routes/` directory that exports a `router` — see the [Quick Start](#quick-start) example above. Routes are auto-discovered via glob — no registration needed. Subdirectories are supported, so you can organise by feature:

```
routes/
  products.ts
  ingredients/
    list.ts
    detail.ts
```

### OpenAPI Schema Registration

Import `createRoute` from `@lastshotlabs/bunshot` (not from `@hono/zod-openapi`). The wrapper automatically registers every unnamed request body and response schema as a named entry in `components/schemas`. Schemas you already named via `registerSchema` are never overwritten.

Every Zod schema that appears in your OpenAPI spec ends up as a named entry in `components/schemas` — either auto-named by the framework or explicitly named by you. There are four registration methods, each suited to a different scenario.

---

### Method 1 — Route-level auto-registration (via `createRoute`)

The most common case. When you define a route with `createRoute`, every unnamed request body and response schema is automatically registered under a name derived from the HTTP method and path.

**Naming convention**

| Route | Part | Generated name |
|-------|------|----------------|
| `POST /products` | request body | `CreateProductsRequest` |
| `POST /products` | 201 response | `CreateProductsResponse` |
| `GET /products/{id}` | 200 response | `GetProductsByIdResponse` |
| `DELETE /products/{id}` | 404 response | `DeleteProductsByIdNotFoundError` |
| `PATCH /products/{id}` | request body | `UpdateProductsByIdRequest` |

HTTP methods → verbs: `GET → Get`, `POST → Create`, `PUT → Replace`, `PATCH → Update`, `DELETE → Delete`.

Status codes → suffixes: `200/201/204 → Response`, `400 → BadRequestError`, `401 → UnauthorizedError`, `403 → ForbiddenError`, `404 → NotFoundError`, `409 → ConflictError`, `422 → ValidationError`, `429 → RateLimitError`, `500 → InternalError`, `501 → NotImplementedError`, `503 → UnavailableError`. Unknown codes fall back to the number.

**Limitation:** if the same Zod object is used in two different routes, each route names it after itself — you get two identical inline shapes instead of one shared `$ref`. Use Method 2 or 3 to fix this.

---

### Method 2 — Directory / glob auto-discovery (via `modelSchemas`)

Use this when you have schemas shared across multiple routes. Point `modelSchemas` at one or more directories and Bunshot imports every `.ts` file **before** routes are loaded. Any exported Zod schema is registered automatically — same object referenced in multiple routes → same `$ref` in the spec.

**Naming:** export name with the trailing `Schema` suffix stripped (`LedgerItemSchema` → `"LedgerItem"`). Already-registered schemas are never overwritten.

```ts
// src/schemas/ledgerItem.ts
import { z } from "zod";
export const LedgerItemSchema = z.object({ id: z.string(), name: z.string(), amount: z.number() });
// → auto-registered as "LedgerItem"
```

```ts
// src/config/index.ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  modelSchemas: import.meta.dir + "/schemas",  // string shorthand — registration: "auto"
});
```

```ts
// src/routes/ledger.ts  AND  src/routes/ledgerDetail.ts
import { LedgerItemSchema } from "@schemas/ledgerItem"; // same Zod object instance
createRoute({ responses: { 200: { content: { "application/json": { schema: LedgerItemSchema } } } } });
// → $ref: "#/components/schemas/LedgerItem" in both routes
```

**Multiple directories and glob patterns**

```ts
modelSchemas: [
  import.meta.dir + "/schemas",                         // dedicated schemas dir
  import.meta.dir + "/models",                           // co-located with DB models
  import.meta.dir + "/services/**/*.schema.ts",          // selective glob
]
```

**Full config object** — use when you need to set `registration` or mix paths and globs:

```ts
modelSchemas: {
  paths: [import.meta.dir + "/schemas", import.meta.dir + "/models"],
  registration: "auto",   // default — auto-registers exports with suffix stripping
}
```

**`registration: "explicit"`** — files are imported but nothing is auto-registered. Registration is left entirely to `registerSchema` / `registerSchemas` calls inside each file. Use this when you want zero magic and full name control:

```ts
modelSchemas: { paths: import.meta.dir + "/schemas", registration: "explicit" }
```

---

### Method 3 — Batch explicit registration (via `registerSchemas`)

`registerSchemas` lets you name a group of schemas all at once. Object keys become the `components/schemas` names; the same object is returned so you can destructure and export normally. No suffix stripping — names are taken as-is.

```ts
// src/schemas/index.ts
import { registerSchemas } from "@lastshotlabs/bunshot";
import { z } from "zod";

export const { LedgerItem, Product, ErrorResponse } = registerSchemas({
  LedgerItem:    z.object({ id: z.string(), name: z.string(), amount: z.number() }),
  Product:       z.object({ id: z.string(), price: z.number() }),
  ErrorResponse: z.object({ error: z.string() }),
});
```

Pair with `registration: "explicit"` in `modelSchemas` so the file is imported before routes, or call it inline at the top of any route file — route files are auto-discovered so the top-level call runs before the spec is served.

---

### Method 4 — Single explicit registration (via `registerSchema`)

`registerSchema("Name", schema)` registers one schema and returns it unchanged. Useful for a single shared type (e.g. a common error envelope) or to override the name auto-discovery would generate.

```ts
// src/schemas/errors.ts
import { registerSchema } from "@lastshotlabs/bunshot";
import { z } from "zod";

export const ErrorResponse = registerSchema("ErrorResponse",
  z.object({ error: z.string() })
);
```

Registration is idempotent — calling `registerSchema` on an already-registered schema is a no-op. This means you can safely call it in files that are also covered by `modelSchemas` auto-discovery: whichever runs first wins, and the other is silently skipped.

---

### Priority and interaction

All four methods write to the same process-global registry. The rules are simple:

1. **First write wins** — once a schema has a name, it cannot be renamed.
2. **`modelSchemas` files are imported before routes**, so explicit calls inside them always take precedence over what `createRoute` would generate for the same object.
3. **`registerSchema` / `registerSchemas` take precedence over auto-discovery** when they appear at module top level (they run at import time, before `maybeAutoRegister` inspects the export list).
4. **`createRoute` never overwrites** a schema already in the registry — it only fills gaps.

**Decision guide:**

| Situation | Use |
|-----------|-----|
| Route-specific, one-off schema | `createRoute` auto-registration (Method 1) |
| Shared across routes, happy with suffix-stripped export name | `modelSchemas` auto-discovery (Method 2) |
| Shared across routes, want explicit names or batch control | `registerSchemas` (Method 3) |
| Single shared schema or custom name override | `registerSchema` (Method 4) |

**Protected routes**

Use `withSecurity` to declare security schemes on a route without breaking `c.req.valid()` type inference. (Inlining `security` directly in `createRoute({...})` causes TypeScript to collapse the handler's input types to `never`.)

```ts
import { createRoute, withSecurity } from "@lastshotlabs/bunshot";

router.openapi(
  withSecurity(
    createRoute({ method: "get", path: "/me", ... }),
    { cookieAuth: [] },
    { userToken: [] }
  ),
  async (c) => {
    const userId = c.get("authUserId"); // fully typed
  }
);
```

Pass each security scheme as a separate object argument. The security scheme names (`cookieAuth`, `userToken`, `bearerAuth`) are registered globally by `createApp`.

**Load order:** By default, routes load in filesystem order. If a route needs to be registered before another (e.g. for Hono's first-match-wins routing), export a `priority` number — lower values load first. Routes without a `priority` load last.

```ts
// routes/tenants.ts — must match before generic routes
export const priority = 1;
export const router = createRouter();
// ...
```
