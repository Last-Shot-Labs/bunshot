## Jobs (BullMQ)

> **Redis requirement**: BullMQ requires `maxmemory-policy noeviction`. Set it in `redis.conf` or via Docker:
> ```yaml
> command: redis-server --maxmemory-policy noeviction
> ```

Queues and workers share the existing Redis connection automatically.

### Define a queue

```ts
// src/queues/email.ts
import { createQueue } from "@lastshotlabs/bunshot";

export type EmailJob = { to: string; subject: string; body: string };

export const emailQueue = createQueue<EmailJob>("email");
```

### Add jobs

```ts
import { emailQueue } from "../queues/email";

await emailQueue.add("send-welcome", { to: "user@example.com", subject: "Welcome", body: "..." });

// with options
await emailQueue.add("send-reset", payload, { delay: 5000, attempts: 3 });
```

### Define a worker

```ts
// src/workers/email.ts
import { createWorker } from "@lastshotlabs/bunshot";
import type { EmailJob } from "../queues/email";

export const emailWorker = createWorker<EmailJob>("email", async (job) => {
  const { to, subject, body } = job.data;
  // send email...
});
```

Workers in `workersDir` are auto-discovered and registered after the server starts — no manual imports needed. Subdirectories are supported.

### Broadcasting WebSocket messages from a worker

Use `publish` to broadcast to all connected clients from inside a worker (or anywhere):

```ts
// src/workers/notify.ts
import { createWorker, publish } from "@lastshotlabs/bunshot";
import type { NotifyJob } from "../queues/notify";

export const notifyWorker = createWorker<NotifyJob>("notify", async (job) => {
  const { text, from } = job.data;
  publish("broadcast", { text, from, timestamp: new Date().toISOString() });
});
```

`publish` is available after `createServer` resolves. Workers are loaded after that point, so it's always safe to use inside a worker.

### Cron / scheduled workers

Use `createCronWorker` for recurring jobs. It creates both a queue and worker, and uses BullMQ's `upsertJobScheduler` for idempotent scheduling across restarts.

```ts
// src/workers/cleanup.ts
import { createCronWorker } from "@lastshotlabs/bunshot/queue";

export const { worker, queue } = createCronWorker(
  "cleanup",
  async (job) => {
    // runs every hour
    await deleteExpiredRecords();
  },
  { cron: "0 * * * *" }         // or { every: 3_600_000 } for interval-based
);
```

**Ghost job cleanup**: When a cron worker is renamed or removed, the old scheduler persists in Redis. Bunshot handles this automatically — after all workers in `workersDir` are loaded, stale schedulers are pruned. For workers managed outside `workersDir`, call `cleanupStaleSchedulers(activeNames)` manually.

### Job status endpoint

Expose job state via REST for client-side polling (e.g., long-running uploads or exports):

```ts
import { userAuth, requireRole } from "@lastshotlabs/bunshot";

await createServer({
  jobs: {
    statusEndpoint: true,                           // default: false
    auth: "userAuth",                                // "userAuth" | "none" | MiddlewareHandler[]
    roles: ["admin"],                                // require these roles (works with userAuth)
    allowedQueues: ["export", "upload"],              // whitelist — empty = nothing exposed (secure by default)
    scopeToUser: false,                              // when true with userAuth, users only see their own jobs
  },
});
```

**Auth options:**
- `"userAuth"` — requires an authenticated user session. Combine with `roles` for RBAC.
- `"none"` — no auth protection (not recommended for production).
- `MiddlewareHandler[]` — pass a custom middleware stack for full control, e.g. `[userAuth, requireRole("admin")]`.

#### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /jobs` | List available queues |
| `GET /jobs/:queue` | List jobs in a queue (paginated, filterable by state) |
| `GET /jobs/:queue/:id` | Job state, progress, result, or failure reason |
| `GET /jobs/:queue/:id/logs` | Job logs |
| `GET /jobs/:queue/dead-letters` | Paginated list of DLQ jobs |

The list endpoint (`GET /jobs/:queue`) accepts `?state=waiting|active|completed|failed|delayed|paused` and `?start=0&end=19` for pagination.

### Dead Letter Queue (DLQ)

Automatically move permanently failed jobs to a DLQ for inspection and retry:

```ts
import { createWorker, createDLQHandler } from "@lastshotlabs/bunshot/queue";

const emailWorker = createWorker("email", async (job) => { ... });

const { dlqQueue, retryJob } = createDLQHandler(emailWorker, "email", {
  maxSize: 1000,                                    // default: 1000 — oldest trimmed when exceeded
  onDeadLetter: async (job, error) => {              // optional alerting callback
    await alertSlack(`Job ${job.id} failed: ${error.message}`);
  },
  preserveJobOptions: true,                          // default: true — retry with original delay/priority/attempts
});

// Retry a specific failed job
await retryJob("job-id-123");
```

The DLQ queue is named `${sourceQueueName}-dlq` (e.g., `email-dlq`). It's automatically available via the job status endpoint if listed in `allowedQueues`.
