import { z } from "zod";
import { HttpError } from "./HttpError";

export const validate = async <T extends z.ZodType>(schema: T, req: Request): Promise<z.output<T>> => {
  try {
    const body = await req.json();
    return schema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new HttpError(400, err.issues.map((i) => i.message).join(", "));
    }
    throw err;
  }
};
