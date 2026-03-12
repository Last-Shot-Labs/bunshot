#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync, readSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

function ask(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  const n = readSync(0, buf, 0, buf.length, null);
  return buf.subarray(0, n).toString().trim().replace(/\r/g, "");
}

// --- prompts (or argv) ---
// Usage: bunshot "App Name" [dir-name]
const argTitle = process.argv[2];
const argDir   = process.argv[3];

const appTitle = argTitle || ask("App name: ");
if (!appTitle) {
  console.error("App name is required.");
  process.exit(1);
}

const dirDefault = appTitle.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
const dirName    = argDir || (argTitle ? dirDefault : ask(`Directory (${dirDefault}): `)) || dirDefault;

// --- paths ---
const projectDir = join(process.cwd(), dirName);
const srcDir     = join(projectDir, "src");
const routesDir  = join(srcDir, "routes");
const workersDir = join(srcDir, "workers");

if (existsSync(projectDir)) {
  console.error(`Directory "${dirName}" already exists.`);
  process.exit(1);
}

// --- templates ---
const indexContent = `import { createServer, type CreateServerConfig } from "@last-shot-labs/bunshot";

const appTitle = "${appTitle}";
const appVersion = "1.0.0";

const roles = {
  admin: "admin",
  user: "user",
};

const config: CreateServerConfig = {
  routesDir: import.meta.dir + "/routes",
  workersDir: import.meta.dir + "/workers",
  openapi: {
    title: appTitle,
    version: appVersion,
  },
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  roles: Object.values(roles),
  defaultRole: roles.user,
  corsOrigins: ["*"],
  mongo: "single",
};

await createServer(config);
`;

const readmeContent = `# ${appTitle}

Built with [@last-shot-labs/bunshot](https://github.com/Last-Shot-Labs/bunshot).

## Getting started

\`\`\`bash
cp .env.example .env  # fill in your values
bun dev
\`\`\`

| Endpoint | Description |
|---|---|
| \`POST /auth/register\` | Create account |
| \`POST /auth/login\` | Sign in, returns JWT |
| \`GET  /docs\` | OpenAPI docs (Scalar) |
| \`GET  /health\` | Health check |

## Project structure

\`\`\`
src/
  index.ts        # server entry point
  routes/         # file-based routing (each file = a router)
  workers/        # BullMQ workers (auto-imported on start)
\`\`\`

## Adding routes

Create a file in \`src/routes/\`:

\`\`\`ts
// src/routes/products.ts
import { createRouter } from "@last-shot-labs/bunshot";
import { z } from "zod";

const router = createRouter();

router.get("/products", (c) => c.json({ products: [] }));

export default router;
\`\`\`

## Adding models

\`\`\`ts
// src/models/Product.ts
import { appConnection, mongoose } from "@last-shot-labs/bunshot";

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { timestamps: true });

export const Product = appConnection.model("Product", ProductSchema);
\`\`\`

## Environment variables

See \`.env\` — fill in MongoDB, Redis, JWT, Bearer token, and OAuth provider values before running.
`;

const envContent = `NODE_ENV=development
PORT=3000

# MongoDB (single connection)
MONGO_USER_DEV=
MONGO_PW_DEV=
MONGO_HOST_DEV=
MONGO_DB_DEV=
MONGO_USER_PROD=
MONGO_PW_PROD=
MONGO_HOST_PROD=
MONGO_DB_PROD=

# MongoDB auth connection (only needed if mongo: "separate")
MONGO_AUTH_USER_DEV=
MONGO_AUTH_PW_DEV=
MONGO_AUTH_HOST_DEV=
MONGO_AUTH_DB_DEV=
MONGO_AUTH_USER_PROD=
MONGO_AUTH_PW_PROD=
MONGO_AUTH_HOST_PROD=
MONGO_AUTH_DB_PROD=

# Redis
REDIS_HOST_DEV=
REDIS_USER_DEV=
REDIS_PW_DEV=
REDIS_HOST_PROD=
REDIS_USER_PROD=
REDIS_PW_PROD=

# JWT
JWT_SECRET_DEV=
JWT_SECRET_PROD=

# Bearer API key
BEARER_TOKEN_DEV=
BEARER_TOKEN_PROD=

# OAuth — Google (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# OAuth — Apple (optional)
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=
APPLE_REDIRECT_URI=
`;

// --- scaffold ---
console.log(`\n@last-shot-labs/bunshot — creating ${dirName}\n`);

mkdirSync(projectDir, { recursive: true });

// bun init -y (handles package.json, tsconfig.json, .gitignore)
console.log("  Running bun init...");
spawnSync("bun", ["init", "-y"], { cwd: projectDir, stdio: "inherit" });

// Remove the root index.ts bun init creates — we use src/index.ts
const rootIndex = join(projectDir, "index.ts");
if (existsSync(rootIndex)) rmSync(rootIndex);

// Patch package.json: add dependency + fix scripts + module entry
const pkgPath = join(projectDir, "package.json");
const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
pkg.module = "src/index.ts";
pkg.scripts = { dev: "bun --watch src/index.ts", start: "bun src/index.ts" };
pkg.dependencies = { ...pkg.dependencies, "@last-shot-labs/bunshot": "*" };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// Patch tsconfig.json: add path aliases
const tsconfigPath = join(projectDir, "tsconfig.json");
const tsconfig = JSON.parse(require("fs").readFileSync(tsconfigPath, "utf-8"));
tsconfig.compilerOptions = {
  ...tsconfig.compilerOptions,
  "paths": {
    "@lib/*":        ["./src/lib/*"],
    "@middleware/*": ["./src/middleware/*"],
    "@models/*":     ["./src/models/*"],
    "@queues/*":     ["./src/queues/*"],
    "@routes/*":     ["./src/routes/*"],
    "@scripts/*":    ["./src/scripts/*"],
    "@services/*":   ["./src/services/*"],
    "@workers/*":    ["./src/workers/*"],
  },
};
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n", "utf-8");

// Create src structure
mkdirSync(routesDir, { recursive: true });
mkdirSync(workersDir, { recursive: true });
writeFileSync(join(srcDir, "index.ts"), indexContent, "utf-8");
writeFileSync(join(projectDir, ".env"), envContent, "utf-8");
writeFileSync(join(projectDir, "README.md"), readmeContent, "utf-8");

console.log("  Created:");
console.log(`    + ${dirName}/src/index.ts`);
console.log(`    + ${dirName}/src/routes/`);
console.log(`    + ${dirName}/src/workers/`);
console.log(`    + ${dirName}/.env`);
console.log(`    + ${dirName}/README.md`);

// --- git init ---
console.log("\n  Initializing git...");
const git = spawnSync("git", ["init"], { cwd: projectDir, stdio: "inherit" });
if (git.status !== 0) {
  console.error("  git init failed — skipping.");
}

// --- bun install ---
console.log("\n  Installing dependencies...");
const install = spawnSync("bun", ["install"], { cwd: projectDir, stdio: "inherit" });
if (install.status !== 0) {
  console.error("\n  bun install failed. Run it manually inside the directory.");
  process.exit(1);
}

console.log(`\nDone! Next steps:\n`);
console.log(`  cd ${dirName}`);
console.log(`  # fill in .env`);
console.log(`  bun dev\n`);
