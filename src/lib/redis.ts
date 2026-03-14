import type { default as RedisClass, RedisOptions } from "ioredis";
import { log } from "./logger";

const isProd = process.env.NODE_ENV === "production";

function requireIoredis(): new (opts: RedisOptions) => RedisClass {
  try {
    // Bun supports require() in ESM; this defers the import to call time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("ioredis");
    return mod.default ?? mod;
  } catch {
    throw new Error("ioredis is not installed. Run: bun add ioredis");
  }
}

export const getRedisConnectionOptions = (): RedisOptions => {
  const host_port = isProd ? process.env.REDIS_HOST_PROD : process.env.REDIS_HOST_DEV;
  if (!host_port) throw new Error(`Missing env var: ${isProd ? "REDIS_HOST_PROD" : "REDIS_HOST_DEV"}`);
  const [host, port] = host_port.split(":");
  if (!host || !port) throw new Error(`Invalid Redis host format — expected "host:port", got "${host_port}"`);

  const username = isProd ? process.env.REDIS_USER_PROD : process.env.REDIS_USER_DEV;
  const password = isProd ? process.env.REDIS_PW_PROD : process.env.REDIS_PW_DEV;

  return {
    host,
    port: Number(port),
    ...(username && { username }),
    ...(password && { password }),
  };
};

let client: RedisClass | null = null;

export const connectRedis = (): Promise<void> => {
  if (client) return Promise.resolve();
  const Redis = requireIoredis();
  client = new Redis(getRedisConnectionOptions());
  client.on("error", (err) => log(`[redis] error: ${err.message}`));
  return new Promise((resolve, reject) => {
    client!.once("ready", () => {
      const opts = getRedisConnectionOptions();
      log(`[redis] connected to ${opts.host}:${opts.port} as ${opts.username || "default user"}`);
      resolve();
    });
    client!.once("error", reject);
  });
};

/**
 * Gracefully close the Redis connection.
 * Useful for one-off scripts that need a clean exit.
 */
export const disconnectRedis = async (): Promise<void> => {
  if (!client) return;
  await client.quit();
  client = null;
  log("[redis] disconnected");
};

export const getRedis = (): RedisClass => {
  if (!client) throw new Error("Redis not connected — call connectRedis() first");
  return client;
};
