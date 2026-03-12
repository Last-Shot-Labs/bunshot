import Redis from "ioredis";
import { log } from "./logger";

const isProd = process.env.NODE_ENV === "production";

export const getRedisConnectionOptions = () => {
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

let client: Redis | null = null;

const createClient = (): Redis => {
  const redis = new Redis(getRedisConnectionOptions());

  redis.on("error", (err) => log(`[redis] error: ${err.message}`));

  return redis;
};

export const connectRedis = (): Promise<void> => {
  if (client) return Promise.resolve();
  client = createClient();
  return new Promise((resolve, reject) => {
    client!.once("ready", () => { log(`[redis] connected to ${getRedisConnectionOptions().host}:${getRedisConnectionOptions().port} as ${getRedisConnectionOptions().username || "default user"}`); resolve(); });
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

export const getRedis = (): Redis => {
  if (!client) throw new Error("Redis not connected — call connectRedis() first");
  return client;
};
