## Configuration

```ts
await createServer({
  // Required
  routesDir: import.meta.dir + "/routes",

  // Shared schemas (imported before routes; see "Shared schemas across routes" above)
  modelSchemas: import.meta.dir + "/schemas",   // string shorthand — registration: "auto"
  // modelSchemas: [dir + "/schemas", dir + "/models"],              // multiple dirs
  // modelSchemas: { paths: dir + "/schemas", registration: "explicit" }, // full object

  // App metadata (shown in root endpoint + OpenAPI docs)
  app: {
    name: "My App",      // default: "Bun Core API"
    version: "1.0.0",   // default: "1.0.0"
  },

  // Auth, roles, and OAuth
  auth: {
    enabled: true,                          // default: true — set false to disable /auth/* routes
    adapter: pgAuthAdapter,                 // custom adapter — overrides db.auth (use for Postgres etc.)
    roles: ["admin", "editor", "user"],     // valid roles — required to use requireRole
    defaultRole: "user",                    // assigned to every new user on /auth/register
    primaryField: "email",                  // default: "email" — use "username" or "phone" to change the login identifier
    emailVerification: {                    // optional — only active when primaryField is "email"
      required: true,                       // default: false (soft gate) — set true to block login until verified
      tokenExpiry: 60 * 60,                 // default: 86400 (24 hours) — token TTL in seconds
      onSend: async (email, token) => {     // called after registration and resend — use any email provider
        await resend.emails.send({ to: email, subject: "Verify your email", text: `Token: ${token}` });
      },
    },
    passwordReset: {                        // optional — only active when primaryField is "email"
      tokenExpiry: 60 * 60,                 // default: 3600 (1 hour) — token TTL in seconds
      onSend: async (email, token) => {     // called by POST /auth/forgot-password — use any email provider
        await resend.emails.send({ to: email, subject: "Reset your password", text: `Token: ${token}` });
      },
    },
    rateLimit: {                            // optional — built-in auth endpoint rate limiting
      login:              { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 failures / 15 min
      register:           { windowMs: 60 * 60 * 1000, max: 5  }, // default: 5 attempts / hour (per IP)
      verifyEmail:        { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 attempts / 15 min (per IP)
      resendVerification: { windowMs: 60 * 60 * 1000, max: 3  }, // default: 3 attempts / hour (per user)
      forgotPassword:     { windowMs: 15 * 60 * 1000, max: 5  }, // default: 5 attempts / 15 min (per IP)
      resetPassword:      { windowMs: 15 * 60 * 1000, max: 10 }, // default: 10 attempts / 15 min (per IP)
      store: "redis",                       // default: "redis" when Redis is enabled, else "memory"
    },
    sessionPolicy: {                        // optional — session concurrency and metadata
      maxSessions: 6,                       // default: 6 — max simultaneous sessions per user; oldest evicted when exceeded
      persistSessionMetadata: true,         // default: true — keep IP/UA/timestamp row after session expires (for device detection)
      includeInactiveSessions: false,       // default: false — include expired/deleted sessions in GET /auth/sessions
      trackLastActive: false,               // default: false — update lastActiveAt on every auth'd request (adds one DB write)
    },
    oauth: {
      providers: { google: { ... }, apple: { ... } }, // omit a provider to disable it
      postRedirect: "/dashboard",           // default: "/"
    },
    refreshTokens: {                        // optional — short-lived access + long-lived refresh tokens
      accessTokenExpiry: 900,               // default: 900 (15 min)
      refreshTokenExpiry: 2_592_000,        // default: 2_592_000 (30 days)
      rotationGraceSeconds: 30,             // default: 30 — old token still works briefly after rotation
    },
    mfa: {                                  // optional — TOTP/MFA support (requires otpauth peer dep)
      issuer: "My App",                     // shown in authenticator apps (default: app name)
      recoveryCodes: 10,                    // default: 10
      challengeTtlSeconds: 300,             // default: 300 (5 min)
      emailOtp: {                           // optional — email OTP as alternative MFA method
        onSend: async (email, code) => {},  // called to deliver the OTP code — use any email provider
        codeLength: 6,                      // default: 6
      },
    },
    accountDeletion: {                      // optional — enables DELETE /auth/me
      onBeforeDelete: async (userId) => {}, // throw to abort
      onAfterDelete: async (userId) => {},  // cleanup callback
    },
  },

  // Multi-tenancy
  tenancy: {
    resolution: "header",                   // "header" | "subdomain" | "path"
    headerName: "x-tenant-id",             // header name (when resolution is "header")
    onResolve: async (tenantId) => ({}),    // validate/load tenant — return null to reject
    cacheTtlMs: 60_000,                    // LRU cache TTL (default: 60s, 0 to disable)
    cacheMaxSize: 500,                     // max cached entries (default: 500)
    exemptPaths: [],                       // extra paths that skip tenant resolution
    rejectionStatus: 403,                  // 403 (default) or 404
  },

  // Job status endpoint
  jobs: {
    statusEndpoint: true,                  // default: false
    auth: "userAuth",                      // "userAuth" | "none" | MiddlewareHandler[]
    roles: ["admin"],                      // require roles (works with userAuth)
    allowedQueues: ["export"],             // whitelist — empty = nothing exposed
    scopeToUser: false,                    // when true with userAuth, users see only their own jobs
  },

  // Security
  security: {
    cors: ["https://myapp.com"],            // default: "*"
    rateLimit: { windowMs: 60_000, max: 100 }, // default: 100 req/min
    bearerAuth: true,                       // default: true — set false to disable, or { bypass: ["/my-public-route"] }
    botProtection: {
      fingerprintRateLimit: true,           // rate-limit by HTTP fingerprint (IP-rotation resistant). default: false
      blockList: ["198.51.100.0/24"],       // IPv4 CIDRs or exact IPs to block with 403. default: []
    },
  },

  // Extra middleware injected after identify, before route matching
  middleware: [],

  // Connections & store routing (all optional — shown with defaults)
  db: {
    mongo: "single",        // "single" | "separate" | false
    redis: true,            // false to skip auto-connect
    sqlite: undefined,      // absolute path to .db file — required when any store is "sqlite"
    auth: "mongo",          // "mongo" | "sqlite" | "memory" — which built-in auth adapter to use
    sessions: "redis",      // "redis" | "mongo" | "sqlite" | "memory"
    oauthState: "redis",    // default: follows sessions
    cache: "redis",         // global default for cacheResponse (overridable per-route)
  },

  // Server
  port: 3000,                                    // default: process.env.PORT ?? 3000
  workersDir: import.meta.dir + "/workers",      // auto-imports all .ts files after server starts
  enableWorkers: true,                           // default: true — set false to disable auto-loading

  // WebSocket (see WebSocket section for full examples)
  ws: {
    handler: { ... },                                  // override open/message/close/drain handlers
    upgradeHandler: async (req, server) => { ... },    // replace default cookie-JWT upgrade logic
    onRoomSubscribe(ws, room) { return true; },        // gate room subscriptions; can be async
  },
});
```
