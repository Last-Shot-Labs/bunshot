import { OpenAPIHono, type Hook } from "@hono/zod-openapi";

export type AppVariables = {
  authUserId: string | null;
  roles: string[] | null;
};

export type AppEnv = { Variables: AppVariables };

const defaultHook: Hook<any, AppEnv, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues.map((i: { message: string }) => i.message).join(", ");
    return c.json({ error: message }, 400);
  }
};

export const createRouter = () => new OpenAPIHono<AppEnv>({ defaultHook });
