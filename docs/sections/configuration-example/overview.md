## Full Configuration Example

For production apps, break config into its own file with MongoDB, Redis, OAuth, and email verification. See the [Configuration](#configuration) section for the full reference.

```ts
// src/config/index.ts
import { type CreateServerConfig } from "@lastshotlabs/bunshot";

export const appConfig: CreateServerConfig = {
  app: { name: "My App", version: "1.0.0" },
  routesDir: import.meta.dir + "/routes",
  workersDir: import.meta.dir + "/workers",
  db: { mongo: "single", redis: true, sessions: "redis", cache: "memory", auth: "mongo" },
  auth: { roles: ["admin", "user"], defaultRole: "user", primaryField: "email" },
  security: { bearerAuth: true, cors: ["*"] },
};
```

### Built-in endpoints

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create account, returns JWT |
| `POST /auth/login` | Login, returns JWT |
| `POST /auth/logout` | Invalidates the current session |
| `GET /auth/me` | Current user profile |
| `GET /health` | Health check |
| `GET /docs` | Scalar API docs UI |
| `GET /openapi.json` | OpenAPI spec |
| `WS /ws` | WebSocket endpoint |
