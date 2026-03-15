## Full Configuration Example

For production apps, break config into its own file. Here's a real-world setup with MongoDB, Redis, OAuth, and email verification:

```ts
// src/config/index.ts
import path from "path";
import {
  type CreateServerConfig,
  type AppMeta,
  type AuthConfig,
  type DbConfig,
  type SecurityConfig,
  type ModelSchemasConfig,
} from "@lastshotlabs/bunshot";

const app: AppMeta = {
  name: "My App",
  version: "1.0.0",
};

const db: DbConfig = {
  mongo: "single",       // "single" | "separate" | false
  redis: true,           // false to skip Redis
  sessions: "redis",     // "redis" | "mongo" | "sqlite" | "memory"
  cache: "memory",       // default store for cacheResponse
  auth: "mongo",         // "mongo" | "sqlite" | "memory"
  oauthState: "memory",  // where to store OAuth state tokens
};

const auth: AuthConfig = {
  roles: ["admin", "user"],
  defaultRole: "user",
  primaryField: "email",
  rateLimit: { store: "redis" },
  emailVerification: {
    required: true,
    tokenExpiry: 60 * 60, // 1 hour
    onSend: async (email, token) => {
      // send verification email using any provider (Resend, SES, etc.)
    },
  },
  oauth: {
    postRedirect: "http://localhost:5175/oauth/callback",
    providers: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: `http://localhost:${process.env.PORT ?? 3000}/auth/google/callback`,
      },
    },
  },
};

const security: SecurityConfig = {
  bearerAuth: true,
  cors: ["*", "http://localhost:5173"],
  botProtection: { fingerprintRateLimit: true },
};

const modelSchemas: ModelSchemasConfig = {
  registration: "auto",
  paths: [path.join(import.meta.dir, "../schemas/*.ts")],
};

export const appConfig: CreateServerConfig = {
  app,
  routesDir: path.join(import.meta.dir, "../routes"),
  workersDir: path.join(import.meta.dir, "../workers"),
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  db,
  auth,
  security,
  modelSchemas,
  middleware: [/* your global middleware here */],
};
```

Every field above is optional except `routesDir`. See the [Configuration](#configuration) section for the full reference.

### Built-in endpoints

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create account, returns JWT |
| `POST /auth/login` | Login, returns JWT (includes `emailVerified` when verification is configured) |
| `POST /auth/logout` | Invalidates the current session only |
| `GET /auth/me` | Returns current user's `userId`, `email`, `emailVerified`, and `googleLinked` (requires login) |
| `POST /auth/set-password` | Set or update password (requires login) |
| `GET /auth/sessions` | List active sessions with metadata — IP, user-agent, timestamps (requires login) |
| `DELETE /auth/sessions/:sessionId` | Revoke a specific session by ID (requires login) |
| `POST /auth/verify-email` | Verify email with token (when `emailVerification` is configured) |
| `POST /auth/resend-verification` | Resend verification email (requires credentials, when `emailVerification` is configured) |
| `POST /auth/forgot-password` | Request a password reset email (when `passwordReset` is configured) |
| `POST /auth/reset-password` | Reset password using a token from the reset email (when `passwordReset` is configured) |
| `GET /health` | Health check |
| `GET /docs` | Scalar API docs UI |
| `GET /openapi.json` | OpenAPI spec |
| `WS /ws` | WebSocket endpoint (cookie-JWT auth) |
