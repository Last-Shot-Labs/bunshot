import type { Middleware } from ".";
import { HttpError } from "@lib/HttpError";

export const errorHandler: Middleware = async (req, next) => {
  try {
    return await next(req);
  } catch (err) {
    console.error(err);
    if (err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
};
