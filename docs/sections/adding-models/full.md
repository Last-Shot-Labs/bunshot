## Adding Models

Import `appConnection` and register models on it. This ensures your models use the correct connection whether you're on a single DB or a separate tenant DB.

`appConnection` is a lazy proxy — calling `.model()` at the top level works fine even before `connectMongo()` has been called. Mongoose buffers any queries until the connection is established.

```ts
// src/models/Product.ts
import { appConnection } from "@lastshotlabs/bunshot";
import { Schema } from "mongoose";
import type { HydratedDocument } from "mongoose";

interface IProduct {
  name: string;
  price: number;
}

export type ProductDocument = HydratedDocument<IProduct>;

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { timestamps: true });

export const Product = appConnection.model<IProduct>("Product", ProductSchema);
```

> **Note:** Import types (`HydratedDocument`, `Schema`, etc.) directly from `"mongoose"` — the `appConnection` and `mongoose` exports from bunshot are runtime proxies and cannot be used as TypeScript namespaces.

### Zod as Single Source of Truth

If you use Zod schemas for your OpenAPI spec (via `createRoute` or `modelSchemas`), you can derive your Mongoose schemas and DTO mappers from those same Zod definitions — so each entity is defined **once**.

#### `zodToMongoose` — Zod → Mongoose SchemaDefinition

Converts a Zod object schema into a Mongoose field definition. Business fields are auto-converted; DB-specific concerns (ObjectId refs, type overrides, subdocuments) are declared via config. The `id` field is automatically excluded since Mongoose provides `_id`.

```ts
import { appConnection, zodToMongoose } from "@lastshotlabs/bunshot";
import { Schema, type HydratedDocument } from "mongoose";
import { ProductSchema } from "../schemas/product"; // your Zod schema
import type { ProductDto } from "../schemas/product";

// DB interface derives from Zod DTO type
interface IProduct extends Omit<ProductDto, "id" | "categoryId"> {
  user: Types.ObjectId;
  category: Types.ObjectId;
}

const ProductMongoSchema = new Schema<IProduct>(
  zodToMongoose(ProductSchema, {
    dbFields: {
      user: { type: Schema.Types.ObjectId, ref: "UserProfile", required: true },
    },
    refs: {
      categoryId: { dbField: "category", ref: "Category" },
    },
    typeOverrides: {
      createdAt: { type: Date, required: true },
    },
  }) as Record<string, unknown>,
  { timestamps: true }
);

export type ProductDocument = HydratedDocument<IProduct>;
export const Product = appConnection.model<IProduct>("Product", ProductMongoSchema);
```

**Config options:**

| Option | Description |
|---|---|
| `dbFields` | Fields that exist only in the DB, not in the API schema (e.g., `user` ObjectId ref) |
| `refs` | API fields that map to ObjectId refs: `{ accountId: { dbField: "account", ref: "Account" } }` |
| `typeOverrides` | Override the auto-converted Mongoose type for a field (e.g., Zod `z.string()` for dates → Mongoose `Date`) |
| `subdocSchemas` | Subdocument array fields: `{ items: mongooseSubSchema }` |

**Auto-conversion mapping:**

| Zod type | Mongoose type |
|---|---|
| `z.string()` | `String` |
| `z.number()` | `Number` |
| `z.boolean()` | `Boolean` |
| `z.date()` | `Date` |
| `z.enum([...])` | `String` with `enum` |
| `.nullable()` / `.optional()` | `required: false` |

#### `createDtoMapper` — Zod → toDto mapper

Creates a generic `toDto` function from a Zod schema. The schema defines which fields exist in the DTO; the config declares how to transform DB-specific types.

```ts
import { createDtoMapper } from "@lastshotlabs/bunshot";
import { ProductSchema, type ProductDto } from "../schemas/product";

const toDto = createDtoMapper<ProductDto>(ProductSchema, {
  refs: { category: "categoryId" },   // ObjectId ref → string, with rename
  dates: ["createdAt"],               // Date → ISO string
});

// Use it
const product = await Product.findOne({ _id: id });
return product ? toDto(product) : null;
```

**Auto-handled transforms:**

| Transform | Description |
|---|---|
| `_id` → `id` | Always converted via `.toString()` |
| `refs` | ObjectId fields → string (`.toString()`), with DB→API field renaming |
| `dates` | `Date` objects → ISO strings (`.toISOString()`) |
| `subdocs` | Array fields mapped with a sub-mapper (for nested documents) |
| nullable/optional | `undefined` → `null` coercion (based on Zod schema) |
| everything else | Passthrough |

**Subdocument example:**

```ts
const itemToDto = createDtoMapper<TemplateItemDto>(TemplateItemSchema);
const toDto = createDtoMapper<TemplateDto>(TemplateSchema, {
  subdocs: { items: itemToDto },
});
```
