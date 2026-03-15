## Adding Models

Import `appConnection` and register Mongoose models on it. `appConnection` is a lazy proxy — `.model()` works before `connectMongo()` has been called.

```ts
import { appConnection } from "@lastshotlabs/bunshot";
import { Schema, type HydratedDocument } from "mongoose";

const ProductSchema = new Schema({ name: String, price: Number }, { timestamps: true });
export const Product = appConnection.model("Product", ProductSchema);
```

Bunshot also provides `zodToMongoose` (Zod -> Mongoose schema conversion) and `createDtoMapper` (DB document -> API DTO) to use Zod as the single source of truth for your models and OpenAPI spec.
