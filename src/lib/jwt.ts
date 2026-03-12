import { SignJWT, jwtVerify } from "jose";

const isProd = process.env.NODE_ENV === "production";
const secret = new TextEncoder().encode(
  isProd ? process.env.JWT_SECRET_PROD! : process.env.JWT_SECRET_DEV!
);

export const signToken = async (userId: string): Promise<string> =>
  new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(secret);

export const verifyToken = async (token: string) => {
  const { payload } = await jwtVerify(token, secret);
  return payload;
};
