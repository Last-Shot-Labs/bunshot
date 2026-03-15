## Running without Redis

Set `db.redis: false` and `db.sessions: "mongo"` to run the entire auth flow on MongoDB only. Sessions, OAuth state, and response caching (when `store: "mongo"`) all work without Redis. The only feature that still requires Redis is BullMQ queues.

```ts
await createServer({
  db: {
    mongo: "single",
    redis: false,
    sessions: "mongo",   // sessions + OAuth state → MongoDB
    cache: "mongo",      // or omit cacheResponse entirely if not using it
  },
});
```

Redis key namespacing: when Redis is used, all keys are prefixed with `appName` (`session:{appName}:{sessionId}`, `usersessions:{appName}:{userId}`, `oauth:{appName}:state:{state}`, `cache:{appName}:{key}`) so multiple apps sharing one Redis instance never collide.
