import { createRoute, withSecurity } from "@lib/createRoute";
import { z } from "zod";
import { createRouter } from "@lib/context";
import { userAuth } from "@middleware/userAuth";
import { requireRole } from "@middleware/requireRole";
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
  const authConfig = config.auth ?? "none";
  const scopeToUser = config.scopeToUser ?? false;

  // Determine if userAuth is involved (for scopeToUser and OpenAPI security schemes)
  const hasUserAuth = authConfig === "userAuth" || Array.isArray(authConfig);

  // Apply middleware based on config
  if (authConfig === "userAuth") {
    router.use("/jobs/*", userAuth);
    if (config.roles?.length) {
      router.use("/jobs/*", requireRole(...config.roles));
    }
  } else if (Array.isArray(authConfig)) {
    for (const mw of authConfig) {
      router.use("/jobs/*", mw);
    }
  }
  // "none" requires no middleware

  function isQueueAllowed(queueName: string): boolean {
    return allowedQueues.has(queueName);
  }

  /** Determine OpenAPI security for a route */
  function applyRouteSecurity<T extends ReturnType<typeof createRoute>>(route: T) {
    if (authConfig === "userAuth") {
      return withSecurity(route, { cookieAuth: [] }, { userToken: [] });
    }
    if (Array.isArray(authConfig)) {
      // Custom middleware — mark as cookieAuth/userToken if it likely includes userAuth
      return withSecurity(route, { cookieAuth: [] }, { userToken: [] });
    }
    return route;
  }

  /** Map a BullMQ job to the response shape */
  async function jobToResponse(job: { id?: string | null; progress: unknown; returnvalue: unknown; failedReason?: string | null; attemptsMade: number; timestamp: number; finishedOn?: number | null; getState: () => Promise<string> }) {
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
  }

  // ─── List available queues ──────────────────────────────────────────────

  const listQueuesRoute = createRoute({
    method: "get",
    path: "/jobs",
    summary: "List available queues",
    description: "Returns the list of queue names exposed via the API.",
    tags,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              queues: z.array(z.string()).describe("Available queue names."),
            }),
          },
        },
        description: "Available queues.",
      },
    },
  });

  router.openapi(applyRouteSecurity(listQueuesRoute), async (c) => {
    return c.json({ queues: [...allowedQueues] }, 200);
  });

  // ─── List jobs in a queue ─────────────────────────────────────────────

  const listJobsRoute = createRoute({
    method: "get",
    path: "/jobs/{queue}",
    summary: "List jobs in a queue",
    description: "Returns a paginated list of jobs in a queue, optionally filtered by state.",
    tags,
    request: {
      params: z.object({
        queue: z.string().describe("Queue name."),
      }),
      query: z.object({
        state: z.enum(["waiting", "active", "completed", "failed", "delayed", "paused"]).optional().describe("Filter by job state."),
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
              total: z.number().describe("Total jobs matching the filter."),
            }),
          },
        },
        description: "Jobs list.",
      },
      403: { content: { "application/json": { schema: ErrorResponse } }, description: "Queue not allowed." },
    },
  });

  router.openapi(applyRouteSecurity(listJobsRoute), async (c) => {
    const { queue: queueName } = c.req.valid("param");
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: "Queue not allowed" }, 403);
    }

    const { state, start: startStr, end: endStr } = c.req.valid("query");
    const start = startStr ? parseInt(startStr) : 0;
    const end = endStr ? parseInt(endStr) : 19;

    const queue = createQueue(queueName);

    // Get jobs by state or all jobs
    const stateFilter = state ?? "waiting";
    const jobs = await queue.getJobs([stateFilter], start, end);

    // Get total count for the filtered state
    const counts = await queue.getJobCounts(stateFilter);
    const total = counts[stateFilter] ?? 0;

    // Optionally filter by userId
    let filteredJobs = jobs;
    if (scopeToUser && hasUserAuth) {
      const userId = c.get("authUserId");
      filteredJobs = jobs.filter((job) => (job.data as any)?.userId === userId);
    }

    const result = await Promise.all(filteredJobs.map(jobToResponse));
    return c.json({ jobs: result, total }, 200);
  });

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

  router.openapi(applyRouteSecurity(getJobRoute), async (c) => {
    const { queue: queueName, id } = c.req.valid("param");
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: "Queue not allowed" }, 403);
    }

    const queue = createQueue(queueName);
    const job = await queue.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);

    // Scope to user if configured
    if (scopeToUser && hasUserAuth) {
      const userId = c.get("authUserId");
      if ((job.data as any)?.userId !== userId) {
        return c.json({ error: "Job not found" }, 404);
      }
    }

    return c.json(await jobToResponse(job), 200);
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

  router.openapi(applyRouteSecurity(getJobLogsRoute), async (c) => {
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

  router.openapi(applyRouteSecurity(getDlqRoute), async (c) => {
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

    const result = await Promise.all(jobs.map(jobToResponse));
    return c.json({ jobs: result, total }, 200);
  });

  return router;
};
