import { mongoose } from "./mongo";
import type { Schema as SchemaType } from "mongoose";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodSchema = any;

/** Unwrap nullable, optional, and default wrappers to get the core Zod type */
function unwrap(zodType: ZodSchema): { core: ZodSchema; required: boolean } {
  let t = zodType;
  let required = true;

  while (true) {
    const defType = t._zod?.def?.type;
    if (defType === "nullable") { t = t._zod.def.innerType; required = false; }
    else if (defType === "optional") { t = t._zod.def.innerType; required = false; }
    else if (defType === "default") { t = t._zod.def.innerType; required = false; }
    else break;
  }

  return { core: t, required };
}

/** Lazily access the Mongoose Schema class (avoids top-level require of mongoose) */
function getSchema() {
  return (mongoose as unknown as typeof import("mongoose")).Schema;
}

/** Convert a single Zod type to a Mongoose field definition */
function toMongooseField(zodType: ZodSchema): Record<string, unknown> {
  const { core, required } = unwrap(zodType);
  const defType = core._zod?.def?.type;

  if (defType === "string") return { type: String, required };
  if (defType === "number") return { type: Number, required };
  if (defType === "boolean") return { type: Boolean, required };
  if (defType === "date") return { type: Date, required };
  if (defType === "enum") return { type: String, enum: core.options, required };

  return { type: getSchema().Types.Mixed, required };
}

export type ZodToMongooseRefConfig = {
  /** DB field name (e.g., "account") */
  dbField: string;
  /** Referenced model name (e.g., "Account") */
  ref: string;
};

export type ZodToMongooseConfig = {
  /** DB-only fields not in the Zod schema (e.g., user ref) */
  dbFields?: Record<string, unknown>;
  /** API fields that map to ObjectId refs: { accountId: { dbField: "account", ref: "Account" } } */
  refs?: Record<string, ZodToMongooseRefConfig>;
  /** Override Mongoose type for specific fields (e.g., { date: { type: Date, required: true } }) */
  typeOverrides?: Record<string, unknown>;
  /** Subdocument array fields: { items: mongooseSubSchema } */
  subdocSchemas?: Record<string, SchemaType>;
};

/**
 * Derive a Mongoose SchemaDefinition from a Zod object schema.
 *
 * Business fields are auto-converted from Zod types to Mongoose types.
 * DB-specific concerns (ObjectId refs, type overrides, subdocuments) are declared via config.
 *
 * The `id` field is automatically excluded (Mongoose provides `_id`).
 *
 * @example
 * ```ts
 * const AccountMongoSchema = new Schema(
 *   zodToMongoose(AccountSchema, {
 *     dbFields: { user: { type: Schema.Types.ObjectId, ref: "UserProfile", required: true } },
 *   }),
 *   { timestamps: true }
 * );
 * ```
 */
export function zodToMongoose(
  zodSchema: ZodSchema,
  config: ZodToMongooseConfig = {},
): Record<string, unknown> {
  const shape = zodSchema.shape as Record<string, ZodSchema>;
  const fields: Record<string, unknown> = {};

  for (const [apiField, zodType] of Object.entries(shape)) {
    if (apiField === "id") continue;

    if (config.refs?.[apiField]) {
      const { dbField, ref } = config.refs[apiField];
      fields[dbField] = { type: getSchema().Types.ObjectId, ref, required: true };
      continue;
    }

    if (config.typeOverrides?.[apiField]) {
      fields[apiField] = config.typeOverrides[apiField];
      continue;
    }

    if (config.subdocSchemas?.[apiField]) {
      fields[apiField] = [config.subdocSchemas[apiField]];
      continue;
    }

    fields[apiField] = toMongooseField(zodType);
  }

  if (config.dbFields) {
    Object.assign(fields, config.dbFields);
  }

  return fields;
}
