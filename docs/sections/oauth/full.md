## Social Login (OAuth)

Pass `auth.oauth.providers` to `createServer` to enable Google and/or Apple sign-in. Routes are mounted automatically for each configured provider.

```ts
await createServer({
  routesDir: import.meta.dir + "/routes",
  app: { name: "My App", version: "1.0.0" },
  auth: {
    oauth: {
      postRedirect: "/lobby",  // where to redirect after login (default: "/")
      providers: {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          redirectUri: "https://myapp.com/auth/google/callback",
        },
        apple: {
          clientId: process.env.APPLE_CLIENT_ID!,       // Services ID, e.g. "com.myapp.auth"
          teamId: process.env.APPLE_TEAM_ID!,
          keyId: process.env.APPLE_KEY_ID!,
          privateKey: process.env.APPLE_PRIVATE_KEY!,   // PEM string
          redirectUri: "https://myapp.com/auth/apple/callback",
        },
      },
    },
  },
});
```

### Routes mounted automatically

| Provider | Initiate login | Callback | Link to existing account | Unlink |
|---|---|---|---|---|
| Google | `GET /auth/google` | `GET /auth/google/callback` | `GET /auth/google/link` | `DELETE /auth/google/link` |
| Apple | `GET /auth/apple` | `POST /auth/apple/callback` | `GET /auth/apple/link` | — |

> Apple sends its callback as a **POST** with form data. Your server must be publicly reachable and the redirect URI must be registered in the Apple developer console.

Additionally, a shared code exchange endpoint is always mounted:

| Endpoint | Purpose |
|---|---|
| `POST /auth/oauth/exchange` | Exchange one-time authorization code for session token |

### Flow

1. Client navigates to `GET /auth/google` (or `/auth/apple`)
2. Package redirects to the provider's OAuth page
3. Provider redirects (or POSTs) back to the callback URL
4. Package exchanges the code, fetches the user profile, and calls `authAdapter.findOrCreateByProvider`
5. A session is created and a **one-time authorization code** is generated
6. User is redirected to `auth.oauth.postRedirect?code=<one-time-code>`
7. Client exchanges the code for a session token via `POST /auth/oauth/exchange`

> **Security:** The JWT is never exposed in the redirect URL. The one-time code expires after 60 seconds and can only be used once, preventing token leakage via browser history, server logs, or referrer headers.

#### Code exchange

After the OAuth redirect, the client must exchange the one-time code for a session token:

```ts
// Client-side
const res = await fetch("/auth/oauth/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: new URLSearchParams(location.search).get("code") }),
});
const { token, userId, email, refreshToken } = await res.json();
```

The exchange endpoint sets session cookies automatically for browser clients. Mobile/SPA clients can use the JSON response directly. Rate limited to 20 requests per minute per IP.

| Field | Description |
|---|---|
| `token` | Session JWT |
| `userId` | Authenticated user ID |
| `email` | User email (if available) |
| `refreshToken` | Refresh token (only when `auth.refreshTokens` is configured) |

### Redirect URL validation

Pass `auth.oauth.allowedRedirectUrls` to restrict where OAuth callbacks can redirect:

```ts
auth: {
  oauth: {
    postRedirect: "/dashboard",
    allowedRedirectUrls: ["https://myapp.com", "https://staging.myapp.com"],
    providers: { ... },
  },
}
```

When configured, the `postRedirect` value is validated against the allowlist at startup. If omitted, any redirect URL is accepted (not recommended for production).

### User storage

The default `mongoAuthAdapter` stores social users in `AuthUser` with a `providerIds` field (e.g. `["google:1234567890"]`). If no existing provider key is found, a new account is created — emails are never auto-linked. To connect a social identity to an existing credential account the user must explicitly use the link flow below.

**Email conflict handling:** If a user attempts to sign in via Google (or Apple) and the email returned by the provider already belongs to a credential-based account, `findOrCreateByProvider` throws `HttpError(409, ...)`. The OAuth callback catches this and redirects to `auth.oauth.postRedirect?error=<message>` so the client can display a helpful prompt (e.g. "An account with this email already exists — sign in with your password, then link Google from your account settings.").

To support social login with a custom adapter, implement `findOrCreateByProvider`:

```ts
const myAdapter: AuthAdapter = {
  findByEmail: ...,
  create: ...,
  async findOrCreateByProvider(provider, providerId, profile) {
    // find or upsert user by provider + providerId
    // return { id: string }
  },
};
```

### Linking a provider to an existing account

A logged-in user can link their account to a Google or Apple identity by navigating to the link route. This is the only way to associate a social login with an existing credential account — email matching is intentionally not done automatically.

```
GET /auth/google/link   (requires active session via cookie)
GET /auth/apple/link    (requires active session via cookie)
```

The link flow:
1. User is already logged in (session cookie set)
2. Client navigates to `/auth/google/link`
3. User completes Google OAuth as normal
4. On callback, instead of creating a new session, the Google identity is added to their existing account
5. User is redirected to `auth.oauth.postRedirect?linked=google`

To support linking with a custom adapter, implement `linkProvider`:

```ts
const myAdapter: AuthAdapter = {
  // ...
  async linkProvider(userId, provider, providerId) {
    const key = `${provider}:${providerId}`;
    await db.update(users)
      .set({ providerIds: sql`array_append(provider_ids, ${key})` })
      .where(eq(users.id, userId));
  },
};
```

### Unlinking a provider

A logged-in user can remove a linked Google identity via:

```
DELETE /auth/google/link   (requires active session via cookie)
```

Returns `204 No Content` on success. All `google:*` entries are removed from the user's `providerIds`.

To support unlinking with a custom adapter, implement `unlinkProvider`:

```ts
const myAdapter: AuthAdapter = {
  // ...
  async unlinkProvider(userId, provider) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(404, "User not found");
    const filtered = user.providerIds.filter((id: string) => !id.startsWith(`${provider}:`));
    await db.update(users).set({ providerIds: filtered }).where(eq(users.id, userId));
  },
};
```
