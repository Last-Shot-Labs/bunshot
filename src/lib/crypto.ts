import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "crypto";

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if both strings are equal, false otherwise.
 * Always compares the full length even on mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against self to burn the same time, then return false
    const buf = Buffer.from(a, "utf-8");
    nodeTimingSafeEqual(buf, buf);
    return false;
  }
  return nodeTimingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

/**
 * SHA-256 hash a string and return the hex digest.
 * Centralized to avoid duplicate implementations across modules.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
