import { Queue, Worker } from "bullmq";
import type { Processor, QueueOptions, WorkerOptions, Job } from "bullmq";
import { getRedisConnectionOptions } from "./redis";

export const createQueue = <T = unknown, R = unknown>(
  name: string,
  options?: Omit<QueueOptions, "connection">
): Queue<T, R> =>
  new Queue<T, R>(name, { connection: getRedisConnectionOptions(), ...options });

export const createWorker = <T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  options?: Omit<WorkerOptions, "connection">
): Worker<T, R> =>
  new Worker<T, R>(name, processor, { connection: getRedisConnectionOptions(), ...options });

export type { Job };
