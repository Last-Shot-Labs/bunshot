## Auth Flow

Sessions are backed by Redis by default. Each login creates an independent session keyed by a UUID (`session:{appName}:{sessionId}`), so multiple devices / tabs can be logged in simultaneously. Set `db.sessions: "mongo"` to store them in MongoDB instead — useful when running without Redis. See [Running without Redis](#running-without-redis).

### Browser clients
1. `POST /auth/login` → JWT set as HttpOnly cookie automatically
2. All subsequent requests send the cookie — no extra code needed

### API / non-browser clients
1. `POST /auth/login` → read `token` from response body
2. Send `x-user-token: <token>` header on every request

### Session management

Each login creates an independent session so multiple devices stay logged in simultaneously. The framework enforces a configurable cap (default: 6) — the oldest session is evicted when the limit is exceeded.

```
GET    /auth/sessions             → [{ sessionId, createdAt, lastActiveAt, expiresAt, ipAddress, userAgent, isActive }]
DELETE /auth/sessions/:sessionId  → revoke a specific session (other sessions unaffected)
POST   /auth/logout               → revoke only the current session
```

Session metadata (IP address, user-agent, timestamps) is persisted even after a session expires when `sessionPolicy.persistSessionMetadata: true` (default). This enables tenant apps to detect logins from novel devices or locations and prompt for MFA or send a security alert.

Set `sessionPolicy.includeInactiveSessions: true` to surface expired/deleted sessions in `GET /auth/sessions` with `isActive: false` — useful for a full device-history UI similar to Google or Meta's account security page.

#### Sliding sessions

Set `sessionPolicy.trackLastActive: true` to update `lastActiveAt` on every authenticated request. This adds one DB write per request but enables a sliding-session experience — sessions that are actively used stay fresh. Pair with refresh tokens (below) for true sliding behavior: short-lived access tokens (15 min) keep authorization tight, while a long-lived refresh token (30 days) lets the client silently renew without re-entering credentials.

### Refresh Tokens

When configured, login and register return short-lived access tokens (default 15 min) alongside long-lived refresh tokens (default 30 days). The client uses `POST /auth/refresh` to obtain a new access token when the current one expires.

```ts
await createServer({
  auth: {
    refreshTokens: {
      accessTokenExpiry: 900,        // seconds, default: 900 (15 min)
      refreshTokenExpiry: 2_592_000, // seconds, default: 2_592_000 (30 days)
      rotationGraceSeconds: 30,      // default: 30 — old token still works briefly after rotation
    },
  },
});
```

**When not configured**, the existing 7-day JWT behavior is unchanged — fully backward compatible.

#### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /auth/login` | Returns `token` + `refreshToken` |
| `POST /auth/register` | Returns `token` + `refreshToken` |
| `POST /auth/refresh` | Rotates refresh token, returns new `token` + `refreshToken` |

#### Rotation with grace window

On each refresh, the server generates a new refresh token but keeps the old one valid for `rotationGraceSeconds` (default 30s). If the client's network drops mid-refresh, it can safely retry with the old token. If the old token is reused *after* the grace window, the entire session is invalidated — this is token-family theft detection.

#### Cookie behavior

The refresh token is set as an `HttpOnly` cookie (`refresh_token`) alongside the existing session cookie. For non-browser clients, it's also returned in the JSON body and accepted via the `x-refresh-token` header.

### MFA / TOTP

Enable multi-factor authentication with TOTP (Google Authenticator, Authy, etc.):

```ts
await createServer({
  auth: {
    mfa: {
      issuer: "My App",          // shown in authenticator apps (default: app name)
      algorithm: "SHA1",         // default, most compatible
      digits: 6,                 // default
      period: 30,                // seconds, default
      recoveryCodes: 10,         // number of recovery codes, default: 10
      challengeTtlSeconds: 300,  // MFA challenge window, default: 5 min
    },
  },
});
```

Requires `otpauth` peer dependency:

```bash
bun add otpauth
```

#### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/mfa/setup` | userAuth | Generate TOTP secret + otpauth URI (for QR code) |
| `POST /auth/mfa/verify-setup` | userAuth | Confirm with TOTP code, returns recovery codes |
| `POST /auth/mfa/verify` | none (uses mfaToken) | Complete login after password verified |
| `DELETE /auth/mfa` | userAuth | Disable all MFA (requires TOTP code) |
| `POST /auth/mfa/recovery-codes` | userAuth | Regenerate codes (requires TOTP code) |
| `GET /auth/mfa/methods` | userAuth | Get enabled MFA methods |

#### Login flow with MFA enabled

1. `POST /auth/login` with credentials → password OK + MFA enabled → `{ mfaRequired: true, mfaToken: "...", mfaMethods: ["totp"] }` (no session created)
2. `POST /auth/mfa/verify` with `{ mfaToken, code }` → verifies TOTP or recovery code → creates session → returns normal token response

The verify endpoint accepts an optional `method` field (`"totp"` or `"emailOtp"`) to target a specific verification method. When omitted, methods are tried automatically.

**OAuth logins skip MFA** — the OAuth provider is treated as the second factor.

**Recovery codes**: 10 random 8-character alphanumeric codes, stored as SHA-256 hashes. Each code can only be used once. Enabling a second MFA method regenerates recovery codes — save the new set.

### Email OTP

An alternative to TOTP that sends a one-time code to the user's email. Users can enable TOTP, email OTP, or both.

```ts
await createServer({
  auth: {
    mfa: {
      challengeTtlSeconds: 300,
      emailOtp: {
        onSend: async (email, code) => {
          await sendEmail(email, `Your login code: ${code}`);
        },
        codeLength: 6,  // default
      },
    },
  },
});
```

#### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/mfa/email-otp/enable` | userAuth | Send verification code to email |
| `POST /auth/mfa/email-otp/verify-setup` | userAuth | Confirm code, enable email OTP |
| `DELETE /auth/mfa/email-otp` | userAuth | Disable email OTP |
| `POST /auth/mfa/resend` | none (uses mfaToken) | Resend email OTP code (max 3 per challenge) |

#### Setup flow

1. `POST /auth/mfa/email-otp/enable` → sends code to email → returns `{ setupToken }`
2. `POST /auth/mfa/email-otp/verify-setup` with `{ setupToken, code }` → enables email OTP → returns recovery codes

This two-step flow ensures the `onSend` callback actually delivers emails before MFA is activated, preventing lockout from misconfigured email providers.

#### Login flow with email OTP

1. `POST /auth/login` → `{ mfaRequired: true, mfaToken, mfaMethods: ["emailOtp"] }` — code is auto-sent to user's email
2. `POST /auth/mfa/verify` with `{ mfaToken, code }` → creates session
3. If the code didn't arrive: `POST /auth/mfa/resend` with `{ mfaToken }` (max 3 resends, capped at 3x challenge TTL)

#### Disabling email OTP

- If TOTP is also enabled: requires a TOTP code in the `code` field
- If email OTP is the only method: requires the account password in the `password` field
- Disabling the last MFA method turns off MFA entirely

### Account Deletion

Enable `DELETE /auth/me` for user-initiated account deletion:

```ts
await createServer({
  auth: {
    accountDeletion: {
      onBeforeDelete: async (userId) => {
        // Throw to abort (e.g., check for active subscription)
      },
      onAfterDelete: async (userId) => {
        // Cleanup: delete S3 files, cancel Stripe, etc.
        // Runs at execution time — query current state, not a snapshot
      },
      queued: false,           // set true for async deletion via BullMQ
      gracePeriod: 0,          // seconds before queued deletion executes
      onDeletionScheduled: async (userId, email, cancelToken) => {
        // Send cancellation email with cancelToken link
      },
    },
  },
});
```

#### Behavior

- Requires `userAuth` middleware (user must be logged in)
- Body: `{ password?: string }` — required for credential accounts, skipped for OAuth-only
- Revokes all sessions, deletes tokens, calls `adapter.deleteUser(userId)`
- Rate limited (3/hour by userId)

#### Queued deletion

When `queued: true`, deletion is enqueued as a BullMQ job instead of running synchronously. The endpoint returns `202 Accepted` immediately. With `gracePeriod > 0`, the user can cancel via `POST /auth/cancel-deletion`.

### Protecting routes

```ts
import { userAuth, requireRole, requireVerifiedEmail } from "@lastshotlabs/bunshot";

router.use("/my-route", userAuth);                              // returns 401 if not logged in
router.use("/admin", userAuth, requireRole("admin"));           // returns 403 if user lacks role
router.use("/content", userAuth, requireRole("admin", "editor")); // allow either role
router.use("/dashboard", userAuth, requireVerifiedEmail);       // returns 403 if email not verified
```

### Custom auth adapter

By default, `/auth/*` routes store users in MongoDB via `mongoAuthAdapter`. Pass `auth: { adapter: myAdapter }` to `createServer` to use any other store — Postgres, SQLite, an external service, etc. Alternatively, use `db.auth` to select a built-in adapter (`"mongo"` | `"sqlite"` | `"memory"`).

The schema should include a `roles` column if you plan to use role-based access:

```sql
-- roles stored as a text array in Postgres
ALTER TABLE users ADD COLUMN roles text[] NOT NULL DEFAULT '{}';
```

```ts
import type { AuthAdapter } from "@lastshotlabs/bunshot";
import { HttpError } from "@lastshotlabs/bunshot";
import { db } from "./db";
import { users } from "./schema";
import { eq, sql } from "drizzle-orm";

const pgAuthAdapter: AuthAdapter = {
  async findByEmail(email) {
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    return user ? { id: user.id, passwordHash: user.passwordHash } : null;
  },
  async create(email, passwordHash) {
    try {
      const [user] = await db.insert(users).values({ email, passwordHash }).returning({ id: users.id });
      return { id: user.id };
    } catch (err: any) {
      if (/* unique constraint */ err.code === "23505") throw new HttpError(409, "Email already registered");
      throw err;
    }
  },
  // --- Role methods (optional — only needed if using roles / requireRole) ---
  async getRoles(userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    return user?.roles ?? [];
  },
  async setRoles(userId, roles) { // required if using defaultRole
    await db.update(users).set({ roles }).where(eq(users.id, userId));
  },
  async addRole(userId, role) {
    await db.update(users)
      .set({ roles: sql`array_append(roles, ${role})` })
      .where(eq(users.id, userId));
  },
  async removeRole(userId, role) {
    await db.update(users)
      .set({ roles: sql`array_remove(roles, ${role})` })
      .where(eq(users.id, userId));
  },
};

await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  auth: {
    roles: ["admin", "editor", "user"],
    defaultRole: "user",
    adapter: pgAuthAdapter,
  },
});
```

The adapter is responsible for:
- `findByEmail` — return `{ id, passwordHash }` or `null` if not found
- `create` — insert the user and return `{ id }`, throw `HttpError(409, ...)` on duplicate email
- `setPassword` _(optional)_ — update the stored password hash for `userId`; implement to enable `POST /auth/set-password`
- `findOrCreateByProvider` _(optional)_ — required for OAuth social login
- `linkProvider` _(optional)_ — add a provider identity to an existing user; implement to enable `GET /auth/{provider}/link`
- `unlinkProvider` _(optional)_ — remove all identities for a provider from a user; implement to enable `DELETE /auth/{provider}/link`
- `getRoles` _(optional)_ — return the roles assigned to `userId`; implement to enable `requireRole` middleware
- `setRoles` _(optional)_ — replace all roles; required if using `defaultRole`
- `addRole` _(optional)_ — add a single role; implement to use `addUserRole`
- `removeRole` _(optional)_ — remove a single role; implement to use `removeUserRole`
- `getUser` _(optional)_ — return `{ email?, providerIds?, emailVerified? }` for `userId`; implement to populate `GET /auth/me` (including `googleLinked` and `emailVerified`)
- `findByIdentifier` _(optional)_ — look up a user by the configured `primaryField` value; implement for non-email primary fields. Falls back to `findByEmail` if absent.
- `setEmailVerified` _(optional)_ — mark a user as email-verified; implement to support `POST /auth/verify-email`
- `getEmailVerified` _(optional)_ — return whether a user is email-verified; implement to support the `emailVerification.required` gate and `POST /auth/resend-verification`

Everything else (password hashing, JWT signing, Redis sessions) is handled by the package.

### Auth Rate Limiting

All built-in auth endpoints are rate-limited out of the box with sensible defaults. No configuration needed — just be aware of the behavior:

| Endpoint | Key | Counts | Default limit |
|---|---|---|---|
| `POST /auth/login` | identifier (email/username/phone) | **Failures only** — reset on success | 10 failures / 15 min |
| `POST /auth/register` | IP address | Every attempt | 5 / hour |
| `POST /auth/verify-email` | IP address | Every attempt | 10 / 15 min |
| `POST /auth/resend-verification` | Identifier (email/username/phone) | Every attempt | 3 / hour |
| `POST /auth/forgot-password` | IP address | Every attempt | 5 / 15 min |
| `POST /auth/reset-password` | IP address | Every attempt | 10 / 15 min |

Login is keyed by the **identifier being targeted** — an attacker rotating IPs to brute-force `alice@example.com` is blocked regardless of source IP. A successful login resets the counter so legitimate users aren't locked out.

#### Tuning limits

```ts
await createServer({
  auth: {
    rateLimit: {
      login:              { windowMs: 10 * 60 * 1000, max: 5 }, // stricter: 5 failures / 10 min
      register:           { windowMs: 60 * 60 * 1000, max: 3 },
      verifyEmail:        { windowMs: 15 * 60 * 1000, max: 10 }, // leave at default
      resendVerification: { windowMs: 60 * 60 * 1000, max: 2 },
      store: "redis",   // default when Redis is enabled — shared across all server instances
    },
  },
});
```

#### Manually clearing a limit (admin unlock)

If a legitimate user gets locked out, call `bustAuthLimit` with the same key format the limiter uses:

```ts
import { bustAuthLimit } from "@lastshotlabs/bunshot";

// Admin route: POST /admin/unblock-login
router.post("/admin/unblock-login", userAuth, requireRole("admin"), async (c) => {
  const { identifier } = await c.req.json();
  await bustAuthLimit(`login:${identifier}`);
  return c.json({ message: "Login limit cleared" });
});
```

Key formats: `login:{identifier}`, `register:{ip}`, `verify:{ip}`, `resend:{userId}`.

#### Using the rate limiter in your own routes

`trackAttempt` and `isLimited` are exported so you can apply the same Redis-backed rate limiting to any route in your app. They use the same store configured via `auth.rateLimit.store`.

```ts
import { trackAttempt, isLimited, bustAuthLimit } from "@lastshotlabs/bunshot";

// trackAttempt — increments the counter and returns true if now over the limit
// isLimited    — checks without incrementing (read-only)
// bustAuthLimit — resets a key (e.g. on success or admin unlock)

router.post("/api/submit", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  const key = `submit:${ip}`;

  if (await trackAttempt(key, { windowMs: 60 * 1000, max: 5 })) {
    return c.json({ error: "Too many requests" }, 429);
  }

  // ... handle request
  return c.json({ ok: true });
});
```

Use `isLimited` when you want to check the current state without counting the request itself — for example, to gate an expensive pre-check before the attempt is registered:

```ts
if (await isLimited(key, opts)) {
  return c.json({ error: "Too many requests" }, 429);
}
```

Keys are automatically namespaced to the app (e.g. `rl:MyApp:submit:1.2.3.4`) when the Redis store is active, so they won't collide on a shared Redis instance.

#### Store

The rate limit store defaults to `"redis"` when Redis is enabled (recommended for multi-instance deployments — limits are shared across all servers). Falls back to `"memory"` automatically when Redis is disabled. In-memory limits don't persist across restarts.

---

### Bot Protection

The built-in IP rate limiter is ineffective against bots that rotate IPs. The `botProtection` config adds two IP-rotation-resistant layers that run before the IP rate limit check.

#### Fingerprint rate limiting

When `fingerprintRateLimit: true`, every request is also rate-limited by an HTTP fingerprint — a 12-char hash derived from `User-Agent`, `Accept-*`, `Connection`, and the presence/absence of browser-only headers (`sec-fetch-*`, `sec-ch-ua-*`, `origin`, `referer`, etc.).

Bots that rotate IPs but use the same HTTP client (e.g. Python `requests`, `curl`, a headless browser) produce the same fingerprint and share a rate-limit bucket regardless of their source IP. Real browser sessions produce a different fingerprint from CLI tools, so they don't interfere with each other.

```ts
await createServer({
  security: {
    rateLimit: { windowMs: 60_000, max: 100 }, // applies to both IP and fingerprint buckets
    botProtection: {
      fingerprintRateLimit: true,
    },
  },
});
```

The fingerprint bucket uses the same window and max as `security.rateLimit`, and is stored in the same backend as `auth.rateLimit.store` (Redis by default, shared across all instances).

#### IP / CIDR blocklist

Block known datacenter ranges, proxy providers, or individual IPs outright. Matched requests receive a 403 before any other processing — no session lookup, no rate-limit increment.

```ts
await createServer({
  security: {
    botProtection: {
      blockList: [
        "198.51.100.0/24",   // IPv4 CIDR
        "203.0.113.42",      // exact IPv4
        "2001:db8::1",       // exact IPv6
      ],
    },
  },
});
```

Both options can be combined. The middleware order is: blocklist → IP rate limit → fingerprint rate limit.

#### Apply `botProtection` to individual routes

`botProtection` is also exported for per-route use:

```ts
import { botProtection } from "@lastshotlabs/bunshot";

router.use("/api/submit", botProtection({ blockList: ["198.51.100.0/24"] }));
```

---

### Setting a password after social login

If a user signed up via Google or Apple and later wants to add a password, send an authenticated request to `POST /auth/set-password`:

```ts
// Client (logged-in user)
await fetch("/auth/set-password", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-user-token": token },
  body: JSON.stringify({ password: "mynewpassword" }),
});
```

The built-in route hashes the password and calls `adapter.setPassword(userId, hash)`. If your adapter does not implement `setPassword`, the route returns `501 Not Implemented`.

To support it with a custom adapter:

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async setPassword(userId, passwordHash) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  },
};
```
