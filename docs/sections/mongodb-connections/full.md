## MongoDB Connections

MongoDB and Redis connect automatically inside `createServer` / `createApp`. Control the behavior via the `db` config object:

### Single database (default)

Both auth and app data share one server. Uses `MONGO_*` env vars.

```ts
await createServer({
  // ...
  db: { mongo: "single", redis: true }, // these are the defaults — can omit db entirely
  // app, auth, security are all optional with sensible defaults
});
```

### Separate auth database

Auth users live on a dedicated server (`MONGO_AUTH_*` env vars), app data on its own server (`MONGO_*` env vars). Useful when multiple tenant apps share one auth cluster.

```ts
await createServer({
  // ...
  db: { mongo: "separate" },
});
```

### Manual connections

Set `mongo: false` and/or `redis: false` to skip auto-connect and manage connections yourself:

```ts
import { connectAuthMongo, connectAppMongo, connectRedis, createServer } from "@lastshotlabs/bunshot";

await connectAuthMongo();
await connectAppMongo();
await connectRedis();

await createServer({
  // ...
  db: { mongo: false, redis: false },
});
```

`AuthUser` and all built-in auth routes always use `authConnection`. Your app models use `appConnection` (see Adding Models below).
