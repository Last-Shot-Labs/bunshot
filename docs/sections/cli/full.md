## CLI — Scaffold a New Project

```bash
bunx @lastshotlabs/bunshot "My App"
```

You can also pass a custom directory name:

```bash
bunx @lastshotlabs/bunshot "My App" my-app-dir
```

This creates a ready-to-run project with:

```
my-app/
  src/
    index.ts            # entry point
    config/index.ts     # centralized app configuration
    lib/constants.ts    # app name, version, roles
    routes/             # add your route files here
    workers/            # BullMQ workers (auto-discovered)
    middleware/          # custom middleware
    models/             # data models
    services/           # business logic
  tsconfig.json         # pre-configured with path aliases
  .env                  # environment variables template
```

Path aliases like `@config/*`, `@lib/*`, `@middleware/*`, `@models/*`, `@routes/*`, `@services/*`, and `@workers/*` are set up automatically in `tsconfig.json`.
