import { z } from "zod";
import type { PrimaryField } from "@lib/appConfig";
import { getPasswordPolicy } from "@lib/appConfig";

/** Build a Zod schema for the password field based on the configured policy.
 *  Applied to registration and reset-password. Login uses min(1) intentionally
 *  to avoid locking out users registered under older/weaker policies. */
const passwordSchema = () => {
  const policy = getPasswordPolicy();
  const minLen = policy.minLength ?? 8;
  let schema = z.string().min(minLen, `Password must be at least ${minLen} characters`);

  if (policy.requireLetter !== false) {
    schema = schema.regex(/[a-zA-Z]/, "Password must contain at least one letter");
  }
  if (policy.requireDigit !== false) {
    schema = schema.regex(/\d/, "Password must contain at least one digit");
  }
  if (policy.requireSpecial) {
    schema = schema.regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character");
  }
  return schema;
};

export const makeRegisterSchema = (primaryField: PrimaryField) =>
  z.object({
    [primaryField]: primaryField === "email" ? z.string().email() : z.string().min(3),
    password: passwordSchema(),
  });

export const makeLoginSchema = (primaryField: PrimaryField) =>
  z.object({
    [primaryField]: primaryField === "email" ? z.string().email() : z.string().min(1),
    password: z.string().min(1),
  });

/** Password schema for reset-password — same policy as registration. */
export const resetPasswordSchema = () => passwordSchema();
