## Multi-Tenancy

Opt-in via `tenancy` config. Resolves tenant ID from header, subdomain, or path segment on each request.

```ts
await createServer({
  tenancy: {
    resolution: "header",
    headerName: "x-tenant-id",
    onResolve: async (tenantId) => { /* validate, return config or null */ },
  },
});
```

Auth routes are exempt (global user pool). Rate limits and cache keys are auto-namespaced per-tenant. CRUD helpers: `createTenant`, `getTenant`, `listTenants`, `deleteTenant`.
