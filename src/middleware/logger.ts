import type { Middleware } from ".";

export const logger: Middleware = async (req, next) => {
  const start = performance.now();
  const res = await next(req);
  const ms = (performance.now() - start).toFixed(2);
  console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${ms}ms`);
  return res;
};
