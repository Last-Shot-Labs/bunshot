## MongoDB Connections

MongoDB and Redis connect automatically inside `createServer` / `createApp`. Control via the `db` config:

- **`mongo: "single"`** (default) — auth and app data share one server (`MONGO_*` env vars)
- **`mongo: "separate"`** — auth on its own server (`MONGO_AUTH_*` env vars), app data on another
- **`mongo: false`** — skip auto-connect, manage connections yourself via `connectAuthMongo()`, `connectAppMongo()`, `connectRedis()`
