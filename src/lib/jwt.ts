import { SignJWT, jwtVerify } from "jose";

let _secret: Uint8Array | null = null;

function getSecret(): Uint8Array {
  if (_secret) return _secret;

  const isProd = process.env.NODE_ENV === "production";
  const envKey = isProd ? "JWT_SECRET_PROD" : "JWT_SECRET_DEV";
  const rawSecret = process.env[envKey];

  if (!rawSecret || rawSecret.length < 32) {
    throw new Error(
      `[security] ${envKey} is missing or too short (${rawSecret?.length ?? 0} chars). ` +
      `JWT secrets must be at least 32 characters. Generate one with: ` +
      `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
    );
  }

  _secret = new TextEncoder().encode(rawSecret);
  return _secret;
}

export const signToken = async (userId: string, sessionId: string, expirySeconds?: number): Promise<string> =>
  new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expirySeconds ? `${expirySeconds}s` : "7d")
    .sign(getSecret());

export const verifyToken = async (token: string) => {
  const { payload } = await jwtVerify(token, getSecret());
  return payload;
};
