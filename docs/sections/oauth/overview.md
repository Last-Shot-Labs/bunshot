## Social Login (OAuth)

Pass `auth.oauth.providers` to enable Google and/or Apple sign-in. Routes are mounted automatically for each configured provider.

```ts
auth: {
  oauth: {
    postRedirect: "/dashboard",
    providers: {
      google: { clientId: "...", clientSecret: "...", redirectUri: "..." },
    },
  },
}
```

Auto-mounted routes per provider: initiate (`GET /auth/{provider}`), callback, link to existing account (`GET /auth/{provider}/link`), and unlink (`DELETE /auth/{provider}/link`). After OAuth redirect, the client exchanges a one-time authorization code via `POST /auth/oauth/exchange` to receive the session token (the JWT is never exposed in the redirect URL). Supports custom adapters via `findOrCreateByProvider`, `linkProvider`, and `unlinkProvider`. Optionally restrict redirect URLs with `allowedRedirectUrls`.
