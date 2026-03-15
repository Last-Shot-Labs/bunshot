## Running without Redis or MongoDB

Two lightweight options for local dev, tests, or small projects with no external services:

### SQLite — persisted to disk

Uses `bun:sqlite` (built into Bun, zero npm deps). A single `.db` file holds all users, sessions, OAuth state, and cache.

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  db: {
    auth: "sqlite",
    sqlite: import.meta.dir + "/../data.db",  // created automatically on first run
    mongo: false,
    redis: false,
    sessions: "sqlite",
    cache: "sqlite",
  },
});
```

#### Optional: periodic cleanup of expired rows

Expired rows are filtered out lazily on read. For long-running servers, sweep them periodically:

```ts
import { startSqliteCleanup } from "@lastshotlabs/bunshot";

startSqliteCleanup();           // default: every hour
startSqliteCleanup(5 * 60_000); // custom interval (ms)
```

### Memory — ephemeral, great for tests

Pure in-memory Maps. No files, no external services. All state is lost on process restart.

```ts
import { createServer, clearMemoryStore } from "@lastshotlabs/bunshot";

await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  db: {
    auth: "memory",
    mongo: false,
    redis: false,
    sessions: "memory",
    cache: "memory",
  },
});

// In tests — reset all state between test cases:
clearMemoryStore();
```

### Limitations (both sqlite and memory)

- BullMQ queues still require Redis
