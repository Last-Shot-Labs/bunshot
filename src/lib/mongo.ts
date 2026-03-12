import mongoose from "mongoose";
import { log } from "./logger";

const isProd = process.env.NODE_ENV === "production";

function buildUri(user: string, password: string, host: string, db: string): string {
  const [hostPart, queryPart] = host.split("?");
  return `mongodb+srv://${user}:${password}@${hostPart.replace(/\/$/, "")}/${db}${queryPart ? `?${queryPart}` : ""}`;
}

/**
 * Named connection used exclusively for auth data (AuthUser model).
 * Connected via connectAuthMongo() or connectMongo() (backward compat).
 */
export const authConnection = mongoose.createConnection();

/**
 * Named connection for app/tenant data.
 * Connected via connectAppMongo() or connectMongo() (backward compat).
 * Use this when registering your own models: appConnection.model("Product", schema).
 */
export const appConnection = mongoose.createConnection();

/**
 * Connect the auth connection to its dedicated MongoDB server.
 * Uses MONGO_AUTH_USER_*, MONGO_AUTH_PW_*, MONGO_AUTH_HOST_*, MONGO_AUTH_DB_* env vars.
 */
export const connectAuthMongo = async (): Promise<void> => {
  const user     = isProd ? process.env.MONGO_AUTH_USER_PROD!     : process.env.MONGO_AUTH_USER_DEV!;
  const password = isProd ? process.env.MONGO_AUTH_PW_PROD!       : process.env.MONGO_AUTH_PW_DEV!;
  const host     = isProd ? process.env.MONGO_AUTH_HOST_PROD!     : process.env.MONGO_AUTH_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_AUTH_DB_PROD!       : process.env.MONGO_AUTH_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await authConnection.openUri(uri);
  log(`[mongo] auth connected to ${host} as ${user}`);
};

/**
 * Connect the app connection to its MongoDB server.
 * Uses MONGO_USER_*, MONGO_PW_*, MONGO_HOST_*, MONGO_DB_* env vars.
 */
export const connectAppMongo = async (): Promise<void> => {
  const user     = isProd ? process.env.MONGO_USER_PROD!     : process.env.MONGO_USER_DEV!;
  const password = isProd ? process.env.MONGO_PW_PROD!       : process.env.MONGO_PW_DEV!;
  const host     = isProd ? process.env.MONGO_HOST_PROD!     : process.env.MONGO_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_DB_PROD!       : process.env.MONGO_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await appConnection.openUri(uri);
  log(`[mongo] app connected to ${host} as ${user}`);
};

/**
 * Connect both auth and app connections to the same MongoDB server.
 * Backward-compatible shorthand for single-DB setups.
 * Uses MONGO_USER_*, MONGO_PW_*, MONGO_HOST_*, MONGO_DB_* env vars.
 */
export const connectMongo = async (): Promise<void> => {
  const user     = isProd ? process.env.MONGO_USER_PROD!     : process.env.MONGO_USER_DEV!;
  const password = isProd ? process.env.MONGO_PW_PROD!       : process.env.MONGO_PW_DEV!;
  const host     = isProd ? process.env.MONGO_HOST_PROD!     : process.env.MONGO_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_DB_PROD!       : process.env.MONGO_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await Promise.all([
    authConnection.openUri(uri),
    appConnection.openUri(uri),
  ]);
  log(`[mongo] connected to ${host} as ${user}`);
};

export { mongoose };
