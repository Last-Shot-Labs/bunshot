## Peer Dependencies

Bunshot declares the following as peer dependencies so you control their versions and avoid duplicate installs in your app.

### Required

These must be installed in every consuming app:

```bash
bun add hono zod
```

| Package | Required version |
|---|---|
| `hono` | `>=4.12 <5` |
| `zod` | `>=4.0 <5` |

### Optional

Install only what your app actually uses:

```bash
# MongoDB auth / sessions / cache
bun add mongoose

# Redis sessions, cache, rate limiting, or BullMQ
bun add ioredis

# Background job queues
bun add bullmq

# MFA / TOTP
bun add otpauth
```

| Package | Required version | When you need it |
|---|---|---|
| `mongoose` | `>=9.0 <10` | `db.auth: "mongo"`, `db.sessions: "mongo"`, or `db.cache: "mongo"` |
| `ioredis` | `>=5.0 <6` | `db.redis: true` (the default), or any store set to `"redis"` |
| `bullmq` | `>=5.0 <6` | Workers / queues |
| `otpauth` | `>=9.0 <10` | `auth.mfa` configuration |

If you're running fully on SQLite or memory (no Redis, no MongoDB), none of the optional peers are needed.
