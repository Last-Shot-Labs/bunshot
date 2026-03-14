import { createRoute as _createRoute } from "@hono/zod-openapi";
import { getRefId, zodToOpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import type { ZodType } from "zod";

/**
 * Converts a route method + path into a PascalCase base name for auto-generated schema names.
 * Examples:
 *   POST /ledger-items       → PostLedgerItems
 *   GET  /ledger-items/{id}  → GetLedgerItemsById
 *   DELETE /auth/sessions/{sessionId} → DeleteAuthSessionsBySessionId
 */
function toBaseName(method: string, path: string): string {
  const m = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith("{") && seg.endsWith("}")) {
        const param = seg.slice(1, -1);
        return "By" + param.charAt(0).toUpperCase() + param.slice(1);
      }
      // kebab-case and plain segments → PascalCase
      return seg.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());
    });
  return m + segments.join("");
}

function maybeRegister(schema: unknown, name: string): void {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) return;
  if (getRefId(schema as ZodType)) return; // already named via .openapi()
  // Write directly to the registry instead of calling schema.openapi(name) — the
  // .openapi() method requires extendZodWithOpenApi() to have been called on the
  // same zod instance that created the schema, which isn't guaranteed in tenant apps.
  zodToOpenAPIRegistry.add(schema as any, { _internal: { refId: name } } as any);
}

/**
 * Adds an OpenAPI `security` requirement to a route without affecting TypeScript
 * type inference on the handler. Pass each security scheme as a separate object.
 *
 * Use this instead of inlining `security` in `createRoute(...)` — inlining a
 * field typed as `{ [name: string]: string[] }` breaks `c.req.valid()` inference.
 *
 * @example
 * router.openapi(
 *   withSecurity(createRoute({ method: "get", path: "/me", ... }), { cookieAuth: [] }, { userToken: [] }),
 *   async (c) => { ... }
 * )
 */
export const withSecurity = <T extends RouteConfig>(route: T, ...schemes: Array<Record<string, string[]>>): T =>
  Object.assign(route, { security: schemes }) as T;

/**
 * Drop-in replacement for `createRoute` from `@hono/zod-openapi`.
 *
 * Automatically registers unnamed request body and response schemas as named
 * OpenAPI components so they appear in `components/schemas` instead of being
 * inlined at every use site. Generated names follow the convention:
 *
 *   {Method}{PathSegments}Body         — request body
 *   {Method}{PathSegments}{StatusCode} — response body
 *
 * Schemas already named via `.openapi("Name")` are never overwritten.
 */
export const createRoute = <T extends RouteConfig>(config: T): T => {
  const base = toBaseName(config.method, config.path);

  // Auto-name the JSON request body schema if present and unnamed
  const bodySchema = (config.request as any)?.body?.content?.["application/json"]?.schema;
  maybeRegister(bodySchema, `${base}Body`);

  // Auto-name each JSON response schema if present and unnamed
  for (const [status, response] of Object.entries(config.responses ?? {})) {
    const resSchema = (response as any)?.content?.["application/json"]?.schema;
    maybeRegister(resSchema, `${base}${status}`);
  }

  return _createRoute(config);
};
