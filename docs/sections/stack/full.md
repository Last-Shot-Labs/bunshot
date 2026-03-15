## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev) + [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
- **Docs UI**: [Scalar](https://scalar.com)
- **Data / Auth**: MongoDB, SQLite, or in-memory — configurable via `db.auth` (default: MongoDB via [Mongoose](https://mongoosejs.com))
- **Cache / Sessions**: Redis, MongoDB, SQLite, or in-memory — configurable via `db.sessions` / `db.cache` (default: Redis via [ioredis](https://github.com/redis/ioredis))
- **Auth**: JWT via [jose](https://github.com/panva/jose), HttpOnly cookies + `x-user-token` header
- **Queues**: [BullMQ](https://docs.bullmq.io) (requires Redis with `noeviction` policy)
- **Validation**: [Zod v4](https://zod.dev)
