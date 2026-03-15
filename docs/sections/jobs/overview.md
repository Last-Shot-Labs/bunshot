## Jobs (BullMQ)

Queue-based background jobs powered by BullMQ (requires Redis with `noeviction` policy).

```ts
// Define a queue
import { createQueue } from "@lastshotlabs/bunshot";
export const emailQueue = createQueue<{ to: string; subject: string }>("email");

// Define a worker (auto-discovered from workersDir)
import { createWorker } from "@lastshotlabs/bunshot";
export const emailWorker = createWorker("email", async (job) => { /* send email */ });
```

Features include cron/scheduled workers via `createCronWorker`, dead letter queues via `createDLQHandler`, job status REST endpoints, and WebSocket broadcasting from workers via `publish`.
