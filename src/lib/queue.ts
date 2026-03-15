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

// ---------------------------------------------------------------------------
// Cron worker
// ---------------------------------------------------------------------------

/** Tracks all registered cron scheduler names for ghost job cleanup. */
const _registeredCronNames = new Set<string>();

export const getRegisteredCronNames = (): ReadonlySet<string> => _registeredCronNames;

export interface CronSchedule {
  /** Cron expression. Mutually exclusive with `every`. */
  cron?: string;
  /** Interval in milliseconds. Mutually exclusive with `cron`. */
  every?: number;
  /** Timezone for cron expressions. */
  timezone?: string;
}

export const createCronWorker = <T = void, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  schedule: CronSchedule,
  options?: Omit<WorkerOptions, "connection">
): { worker: WorkerType<T, R>; queue: QueueType<T, R> } => {
  const { Queue, Worker } = requireBullMQ();
  const connection = getRedisConnectionOptions();

  const queue = new Queue<T, R>(name, { connection });
  const worker = new Worker<T, R>(name, processor, { connection, ...options });

  _registeredCronNames.add(name);

  // Use upsertJobScheduler — idempotent across restarts
  if (schedule.cron) {
    (queue as any).upsertJobScheduler(
      name,
      { pattern: schedule.cron, tz: schedule.timezone },
      { name }
    );
  } else if (schedule.every) {
    (queue as any).upsertJobScheduler(
      name,
      { every: schedule.every },
      { name }
    );
  }

  return { worker, queue };
};

/**
 * Remove job schedulers that are no longer registered.
 * Called automatically after worker discovery in createServer.
 * Can also be called manually for workers managed outside workersDir.
 */
export const cleanupStaleSchedulers = async (activeNames: string[]): Promise<void> => {
  const { Queue } = requireBullMQ();
  const connection = getRedisConnectionOptions();
  const activeSet = new Set(activeNames);

  // Check all known queue names for stale schedulers
  for (const name of _registeredCronNames) {
    if (activeSet.has(name)) continue;
    const queue = new Queue(name, { connection });
    try {
      await queue.removeJobScheduler(name);
    } catch { /* scheduler may not exist */ }
    await queue.close();
  }
};

// ---------------------------------------------------------------------------
// Dead letter queue
// ---------------------------------------------------------------------------

export interface DLQOptions<T = unknown> {
  /** Max jobs to keep in the DLQ. Default: 1000. */
  maxSize?: number;
  /** Called when a job is moved to the DLQ. */
  onDeadLetter?: (job: Job<T>, error: Error) => Promise<void>;
  /** Auto-retry delay in ms. No auto-retry by default. */
  retryAfter?: number;
  /** Preserve original job options on retry. Default: true. */
  preserveJobOptions?: boolean;
}

export const createDLQHandler = <T = unknown>(
  sourceWorker: WorkerType<T>,
  sourceQueueName: string,
  options?: DLQOptions<T>
): { dlqQueue: QueueType<T>; retryJob: (jobId: string) => Promise<void> } => {
  const { Queue } = requireBullMQ();
  const connection = getRedisConnectionOptions();
  const dlqName = `${sourceQueueName}-dlq`;
  const dlqQueue = new Queue<T>(dlqName, { connection }) as QueueType<T>;
  const maxSize = options?.maxSize ?? 1000;
  const preserveJobOptions = options?.preserveJobOptions ?? true;

  sourceWorker.on("failed", async (job: Job<T> | undefined, error: Error) => {
    if (!job) return;
    // Only move to DLQ when all attempts are exhausted
    if (job.attemptsMade < (job.opts?.attempts ?? 1)) return;

    await (dlqQueue as any).add(`dlq:${job.name}`, job.data, {
      ...(preserveJobOptions ? {
        delay: job.opts?.delay,
        priority: job.opts?.priority,
        attempts: job.opts?.attempts,
        backoff: job.opts?.backoff,
      } : {}),
      jobId: `dlq:${job.id}`,
    });

    if (options?.onDeadLetter) {
      try { await options.onDeadLetter(job, error); } catch (e) {
        console.error(`[dlq:${sourceQueueName}] onDeadLetter callback error:`, e);
      }
    }

    // Trim DLQ to maxSize
    const waitingCount = await dlqQueue.getWaitingCount();
    if (waitingCount > maxSize) {
      const excess = waitingCount - maxSize;
      const jobs = await dlqQueue.getWaiting(0, excess - 1);
      for (const j of jobs) {
        await j.remove();
      }
    }
  });

  const sourceQueue = new Queue<T>(sourceQueueName, { connection });

  const retryJob = async (jobId: string): Promise<void> => {
    const job = await dlqQueue.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found in DLQ`);

    const opts = preserveJobOptions ? {
      delay: job.opts?.delay,
      priority: job.opts?.priority,
      attempts: job.opts?.attempts,
      backoff: job.opts?.backoff,
    } : {};

    await sourceQueue.add(job.name, job.data, opts);
    await job.remove();
  };

  return { dlqQueue, retryJob };
};

export type { Job };
