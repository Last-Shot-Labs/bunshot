import { z } from "zod";
import type { PrimaryField } from "@lib/appConfig";

export const makeRegisterSchema = (primaryField: PrimaryField) =>
  z.object({
    [primaryField]: primaryField === "email" ? z.string().email() : z.string().min(3),
    password: z.string().min(8),
  });

export const makeLoginSchema = (primaryField: PrimaryField) =>
  z.object({
    [primaryField]: primaryField === "email" ? z.string().email() : z.string().min(1),
    password: z.string().min(1),
  });
