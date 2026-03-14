// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodSchema = any;

/** Check if a Zod type is nullable or optional */
function isNullable(zodType: ZodSchema): boolean {
  const defType = zodType?._zod?.def?.type;
  if (defType === "nullable") return true;
  if (defType === "optional") return true;
  if (defType === "default") return isNullable(zodType._zod.def.innerType);
  return false;
}

export type DtoMapperConfig = {
  /** DB field name → API field name for ObjectId refs (e.g., { account: "accountId" }) */
  refs?: Record<string, string>;
  /** API field names that are Date in DB, string in DTO */
  dates?: string[];
  /** Subdocument array fields mapped with a sub-mapper: { items: itemMapper } */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subdocs?: Record<string, (item: any) => any>;
};

/**
 * Create a toDto mapper function from a Zod schema.
 *
 * The Zod schema defines which fields exist in the DTO. The config declares
 * how to transform DB-specific types (ObjectId refs, Dates, subdocuments).
 *
 * Handles automatically:
 * - `_id` → `id` (toString)
 * - ObjectId refs → string (toString), with field renaming via `refs`
 * - Date fields → ISO string via `dates`
 * - Subdocument arrays via `subdocs`
 * - Nullable/optional fields → `null` coercion (from `undefined`)
 * - All other fields → passthrough
 *
 * @example
 * ```ts
 * const toDto = createDtoMapper<LedgerItemDto>(LedgerItemSchema, {
 *   refs: { account: "accountId" },
 *   dates: ["date"],
 * });
 * ```
 */
export function createDtoMapper<TDto>(
  zodSchema: ZodSchema,
  config: DtoMapperConfig = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (doc: any) => TDto {
  const apiFields = Object.keys(zodSchema.shape);
  const shape = zodSchema.shape as Record<string, ZodSchema>;

  // Build reverse lookup: apiField → dbField for refs
  const refByApiField = new Map<string, string>();
  if (config.refs) {
    for (const [dbField, apiField] of Object.entries(config.refs)) {
      refByApiField.set(apiField, dbField);
    }
  }

  const dateSet = new Set(config.dates ?? []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (doc: any): TDto => {
    const dto: Record<string, unknown> = {};

    for (const field of apiFields) {
      if (field === "id") {
        dto.id = doc._id.toString();
        continue;
      }

      if (refByApiField.has(field)) {
        dto[field] = doc[refByApiField.get(field)!].toString();
        continue;
      }

      if (dateSet.has(field)) {
        dto[field] = doc[field].toISOString();
        continue;
      }

      if (config.subdocs?.[field]) {
        dto[field] = (doc[field] ?? []).map(config.subdocs[field]);
        continue;
      }

      dto[field] = isNullable(shape[field]) ? (doc[field] ?? null) : doc[field];
    }

    return dto as TDto;
  };
}
