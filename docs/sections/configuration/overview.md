## Configuration

`createServer` / `createApp` accept a config object with these top-level keys:

| Key | Purpose |
|-----|---------|
| `routesDir` | **(required)** Path to auto-discovered route files |
| `app` | App name and version (shown in docs) |
| `auth` | Roles, OAuth, email verification, MFA, refresh tokens, rate limiting, account deletion |
| `db` | Connection and store routing — mongo, redis, sqlite, sessions, cache, auth adapter |
| `security` | CORS, bearer auth, rate limiting, bot protection |
| `tenancy` | Multi-tenant resolution (header/subdomain/path) |
| `jobs` | Job status REST endpoint config |
| `ws` | WebSocket handler and upgrade overrides |
| `middleware` | Extra global middleware array |
| `modelSchemas` | Schema auto-discovery paths |
| `port`, `workersDir`, `enableWorkers` | Server options |
