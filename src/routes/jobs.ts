import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import { createQueue } from "@lib/queue";
import type { JobsConfig } from "../app";

const tags = ["Jobs"];
const ErrorResponse = z.object({ error: z.string() });

const JobStatusResponse = z.object({
  id: z.string().describe("Job ID."),
  state: z.string().describe("Job state: waiting, active, completed, failed, delayed, paused."),
  progress: z.union([z.number(), z.record(z.string(), z.unknown())]).describe("Job progress."),
  result: z.unknown().optional().describe("Job result (when completed)."),
  failedReason: z.string().optional().describe("Failure reason (when failed)."),
  attemptsMade: z.number().describe("Number of attempts made."),
  timestamp: z.number().describe("Unix timestamp (ms) when the job was created."),
  finishedOn: z.number().optional().describe("Unix timestamp (ms) when the job finished."),
}).openapi("JobStatus");

export const createJobsRouter = (config: JobsConfig) => {
  const router = createRouter();
  const allowedQueues = new Set(config.allowedQueues ?? []);
  const authMode = config.auth ?? "bearerAuth";
  const scopeToUser = config.scopeToUser ?? false;

  // Apply auth middleware based on config
  if (authMode === "userAuth") {
    router.use("/jobs/*", userAuth);
  }
  // "bearerAuth" is handled by the global bearer auth middleware
  // "none" requires no additional middleware

  function isQueueAllowed(queueName: string): boolean {
    return allowedQueues.has(queueName);
  }

  // ─── Get job status ─────────────────────────────────────────────────────

  const getJobRoute = createRoute({
    method: "get",
    path: "/jobs/{queue}/{id}",
    summary: "Get job status",
    description: "Returns the current state, progress, result, or failure reason for a job.",
    tags,
    request: {
      params: z.object({
        queue: z.string().describe("Queue name."),
        id: z.string().describe("Job ID."),
      }),
    },
    responses: {
      200: { content: { "application/json": { schema: JobStatusResponse } }, description: "Job status." },
      403: { content: { "application/json": { schema: ErrorResponse } }, description: "Queue not in allowedQueues." },
      404: { content: { "application/json": { schema: ErrorResponse } }, description: "Job not found." },
    },
  });

  const routeDef = authMode === "userAuth"
    ? withSecurity(getJobRoute, { cookieAuth: [] }, { userToken: [] })
    : authMode === "bearerAuth"
    ? withSecurity(getJobRoute, { bearerAuth: [] })
    : getJobRoute;

  router.openapi(routeDef, async (c) => {
    const { queue: queueName, id } = c.req.valid("param");
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: "Queue not allowed" }, 403);
    }

    const queue = createQueue(queueName);
    const job = await queue.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);

    // Scope to user if configured
    if (scopeToUser && authMode === "userAuth") {
      const userId = c.get("authUserId");
      if ((job.data as any)?.userId !== userId) {
        return c.json({ error: "Job not found" }, 404);
      }
    }

    const state = await job.getState();
    return c.json({
      id: job.id!,
      state,
      progress: job.progress as number | Record<string, unknown>,
      result: job.returnvalue,
      failedReason: job.failedReason ?? undefined,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn ?? undefined,
    }, 200);
  });

  // ─── Get job logs ───────────────────────────────────────────────────────

  const getJobLogsRoute = createRoute({
    method: "get",
    path: "/jobs/{queue}/{id}/logs",
    summary: "Get job logs",
    description: "Returns logs for a specific job.",
    tags,
    request: {
      params: z.object({
        queue: z.string().describe("Queue name."),
        id: z.string().describe("Job ID."),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              logs: z.array(z.string()).describe("Log entries."),
              count: z.number().describe("Total log count."),
            }),
          },
        },
        description: "Job logs.",
      },
      403: { content: { "application/json": { schema: ErrorResponse } }, description: "Queue not allowed." },
      404: { content: { "application/json": { schema: ErrorResponse } }, description: "Job not found." },
    },
  });

  const logsRouteDef = authMode === "userAuth"
    ? withSecurity(getJobLogsRoute, { cookieAuth: [] }, { userToken: [] })
    : authMode === "bearerAuth"
    ? withSecurity(getJobLogsRoute, { bearerAuth: [] })
    : getJobLogsRoute;

  router.openapi(logsRouteDef, async (c) => {
    const { queue: queueName, id } = c.req.valid("param");
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: "Queue not allowed" }, 403);
    }

    const queue = createQueue(queueName);
    const job = await queue.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const { logs, count } = await queue.getJobLogs(id);
    return c.json({ logs, count }, 200);
  });

  // ─── Dead letter queue ────────────────────────────────────────────────

  const getDlqRoute = createRoute({
    method: "get",
    path: "/jobs/{queue}/dead-letters",
    summary: "List dead letter queue jobs",
    description: "Returns paginated list of jobs in the dead letter queue for a given source queue.",
    tags,
    request: {
      params: z.object({ queue: z.string().describe("Source queue name (DLQ name is {queue}-dlq).") }),
      query: z.object({
        start: z.string().optional().describe("Start index. Default: 0."),
        end: z.string().optional().describe("End index. Default: 19."),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              jobs: z.array(JobStatusResponse),
              total: z.number().describe("Total jobs in DLQ."),
            }),
          },
        },
        description: "DLQ jobs.",
      },
      403: { content: { "application/json": { schema: ErrorResponse } }, description: "Queue not allowed." },
    },
  });

  const dlqRouteDef = authMode === "userAuth"
    ? withSecurity(getDlqRoute, { cookieAuth: [] }, { userToken: [] })
    : authMode === "bearerAuth"
    ? withSecurity(getDlqRoute, { bearerAuth: [] })
    : getDlqRoute;

  router.openapi(dlqRouteDef, async (c) => {
    const { queue: queueName } = c.req.valid("param");
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: "Queue not allowed" }, 403);
    }

    const { start: startStr, end: endStr } = c.req.valid("query");
    const start = startStr ? parseInt(startStr) : 0;
    const end = endStr ? parseInt(endStr) : 19;

    const dlqQueue = createQueue(`${queueName}-dlq`);
    const [jobs, total] = await Promise.all([
      dlqQueue.getWaiting(start, end),
      dlqQueue.getWaitingCount(),
    ]);

    const result = await Promise.all(jobs.map(async (job) => {
      const state = await job.getState();
      return {
        id: job.id!,
        state,
        progress: job.progress as number | Record<string, unknown>,
        result: job.returnvalue,
        failedReason: job.failedReason ?? undefined,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        finishedOn: job.finishedOn ?? undefined,
      };
    }));

    return c.json({ jobs: result, total }, 200);
  });

  return router;
};
