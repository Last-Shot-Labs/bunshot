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

Auto-mounted routes per provider: initiate (`GET /auth/{provider}`), callback, link to existing account (`GET /auth/{provider}/link`), and unlink (`DELETE /auth/{provider}/link`). Supports custom adapters via `findOrCreateByProvider`, `linkProvider`, and `unlinkProvider`.
