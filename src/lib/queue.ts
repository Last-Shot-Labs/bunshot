import type { Queue as QueueType, Worker as WorkerType, Processor, QueueOptions, WorkerOptions, Job } from "bullmq";
import { getRedisConnectionOptions } from "./redis";

function requireBullMQ(): typeof import("bullmq") {
  try {
    // Bun supports require() in ESM; this defers the import to call time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("bullmq");
  } catch {
    throw new Error("bullmq is not installed. Run: bun add bullmq");
  }
}

export const createQueue = <T = unknown, R = unknown>(
  name: string,
  options?: Omit<QueueOptions, "connection">
): QueueType<T, R> => {
  const { Queue } = requireBullMQ();
  return new Queue<T, R>(name, { connection: getRedisConnectionOptions(), ...options });
};

export const createWorker = <T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  options?: Omit<WorkerOptions, "connection">
): WorkerType<T, R> => {
  const { Worker } = requireBullMQ();
  return new Worker<T, R>(name, processor, { connection: getRedisConnectionOptions(), ...options });
};

export type { Job };
