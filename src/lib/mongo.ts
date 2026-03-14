import type { Connection, Mongoose } from "mongoose";
import { log } from "./logger";

type MongooseModule = Mongoose;

const isProd = process.env.NODE_ENV === "production";

function requireMongoose(): MongooseModule {
  try {
    // Bun supports require() in ESM; this defers the import to call time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("mongoose");
    return mod.default ?? mod;
  } catch {
    throw new Error("mongoose is not installed. Run: bun add mongoose");
  }
}

function buildUri(user: string, password: string, host: string, db: string): string {
  const [hostPart, queryPart] = host.split("?");
  return `mongodb+srv://${user}:${password}@${hostPart.replace(/\/$/, "")}/${db}${queryPart ? `?${queryPart}` : ""}`;
}

// Internal mutable references — set inside connect functions
let _authConn: Connection | null = null;
let _appConn: Connection | null = null;
let _mongoose: MongooseModule | null = null;

function makeConnectionProxy(label: string, getConn: () => Connection | null): Connection {
  return new Proxy({} as Connection, {
    get(_, prop) {
      const conn = getConn();
      if (!conn) {
        throw new Error(
          `MongoDB ${label} connection not initialized — call connect${label === "auth" ? "AuthMongo" : "AppMongo"}() or connectMongo() first`
        );
      }
      const val = (conn as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(conn) : val;
    },
  });
}

/**
 * Named connection used exclusively for auth data (AuthUser model).
 * Connected via connectAuthMongo() or connectMongo() (backward compat).
 */
export const authConnection: Connection = makeConnectionProxy("auth", () => _authConn);

/**
 * Named connection for app/tenant data.
 * Connected via connectAppMongo() or connectMongo() (backward compat).
 * Use this when registering your own models: appConnection.model("Product", schema).
 */
export const appConnection: Connection = makeConnectionProxy("app", () => _appConn);

/**
 * The mongoose instance. Available after connectMongo() / connectAuthMongo() is called.
 */
export const mongoose: MongooseModule = new Proxy({} as MongooseModule, {
  get(_, prop) {
    if (!_mongoose) {
      throw new Error("mongoose not loaded — call connectMongo() or connectAuthMongo() first");
    }
    const val = (_mongoose as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(_mongoose) : val;
  },
});

/**
 * Connect the auth connection to its dedicated MongoDB server.
 * Uses MONGO_AUTH_USER_*, MONGO_AUTH_PW_*, MONGO_AUTH_HOST_*, MONGO_AUTH_DB_* env vars.
 */
export const connectAuthMongo = async (): Promise<void> => {
  const mg = requireMongoose();
  _mongoose = mg;
  if (!_authConn) _authConn = mg.createConnection();
  const user     = isProd ? process.env.MONGO_AUTH_USER_PROD!  : process.env.MONGO_AUTH_USER_DEV!;
  const password = isProd ? process.env.MONGO_AUTH_PW_PROD!    : process.env.MONGO_AUTH_PW_DEV!;
  const host     = isProd ? process.env.MONGO_AUTH_HOST_PROD!  : process.env.MONGO_AUTH_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_AUTH_DB_PROD!    : process.env.MONGO_AUTH_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await _authConn.openUri(uri);
  log(`[mongo] auth connected to ${host} as ${user}`);
};

/**
 * Connect the app connection to its MongoDB server.
 * Uses MONGO_USER_*, MONGO_PW_*, MONGO_HOST_*, MONGO_DB_* env vars.
 */
export const connectAppMongo = async (): Promise<void> => {
  const mg = requireMongoose();
  _mongoose = mg;
  if (!_appConn) _appConn = mg.createConnection();
  const user     = isProd ? process.env.MONGO_USER_PROD!  : process.env.MONGO_USER_DEV!;
  const password = isProd ? process.env.MONGO_PW_PROD!    : process.env.MONGO_PW_DEV!;
  const host     = isProd ? process.env.MONGO_HOST_PROD!  : process.env.MONGO_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_DB_PROD!    : process.env.MONGO_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await _appConn.openUri(uri);
  log(`[mongo] app connected to ${host} as ${user}`);
};

/**
 * Connect both auth and app connections to the same MongoDB server.
 * Backward-compatible shorthand for single-DB setups.
 * Uses MONGO_USER_*, MONGO_PW_*, MONGO_HOST_*, MONGO_DB_* env vars.
 */
export const connectMongo = async (): Promise<void> => {
  const mg = requireMongoose();
  _mongoose = mg;
  if (!_authConn) _authConn = mg.createConnection();
  if (!_appConn) _appConn = mg.createConnection();
  const user     = isProd ? process.env.MONGO_USER_PROD!  : process.env.MONGO_USER_DEV!;
  const password = isProd ? process.env.MONGO_PW_PROD!    : process.env.MONGO_PW_DEV!;
  const host     = isProd ? process.env.MONGO_HOST_PROD!  : process.env.MONGO_HOST_DEV!;
  const db       = isProd ? process.env.MONGO_DB_PROD!    : process.env.MONGO_DB_DEV!;
  const uri = buildUri(user, password, host, db);
  await Promise.all([
    _authConn.openUri(uri),
    _appConn.openUri(uri),
  ]);
  log(`[mongo] connected to ${host} as ${user}`);
};

/**
 * Close both auth and app Mongo connections.
 * Useful for one-off scripts that need a clean exit.
 */
export const disconnectMongo = async (): Promise<void> => {
  await Promise.all([
    _authConn && _authConn.readyState !== 0 ? _authConn.close() : Promise.resolve(),
    _appConn  && _appConn.readyState  !== 0 ? _appConn.close()  : Promise.resolve(),
  ]);
  log("[mongo] disconnected");
};
