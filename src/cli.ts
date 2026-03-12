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

function choose(question: string, options: string[], defaultIndex = 0): number {
  let selected = defaultIndex;

  function render(initial = false) {
    if (!initial) {
      process.stdout.write(`\x1B[${options.length}A`);
    }
    for (let i = 0; i < options.length; i++) {
      const active = i === selected;
      const marker = active ? "\x1B[36m>\x1B[0m" : " ";
      const label = active ? `\x1B[1m${options[i]}\x1B[0m` : `\x1B[2m${options[i]}\x1B[0m`;
      process.stdout.write(`\x1B[2K  ${marker} ${label}\n`);
    }
  }

  // Non-TTY fallback (piped input, CI, etc.)
  if (!process.stdin.isTTY) {
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
    const raw = ask(`  Choose [${defaultIndex + 1}]: `);
    if (!raw) return defaultIndex;
    const num = parseInt(raw);
    if (num >= 1 && num <= options.length) return num - 1;
    return defaultIndex;
  }

  console.log(question);
  process.stdout.write("\x1B[?25l"); // hide cursor
  render(true);
  process.stdin.setRawMode(true);

  const buf = Buffer.alloc(16);

  try {
    while (true) {
      const n = readSync(0, buf, 0, buf.length, null);
      const key = buf.subarray(0, n).toString();

      if (key === "\r" || key === "\n") {
        break;
      } else if (key === "\x1B[A" || key === "\x1BOA") {
        // Up arrow
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === "\x1B[B" || key === "\x1BOB") {
        // Down arrow
        selected = (selected + 1) % options.length;
        render();
      } else if (key === "\x03") {
        // Ctrl+C
        process.stdout.write("\x1B[?25h\n");
        process.stdin.setRawMode(false);
        process.exit(0);
      } else {
        // Number key quick-select
        const num = parseInt(key);
        if (num >= 1 && num <= options.length) {
          selected = num - 1;
          render();
          break;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1B[?25h"); // show cursor
  }

  return selected;
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

// --- database config ---
type DbStore = "redis" | "mongo" | "sqlite" | "memory";

let mongoMode: "single" | "separate" | false = false;
let useRedis = false;
let authStore: "mongo" | "sqlite" | "memory" = "mongo";
let sessionStore: DbStore = "redis";
let cacheStore: DbStore = "redis";
let oauthStateStore: DbStore = "redis";

console.log("");

const presetChoice = choose("Database setup:", [
  "Full stack        (MongoDB + Redis — production ready)",
  "SQLite            (single file, no external services)",
  "Memory            (ephemeral, great for prototyping/tests)",
  "Custom            (choose each store individually)",
]);

if (presetChoice === 0) {
  // Full stack
  const mongoChoice = choose("MongoDB connection mode:", [
    "Single   (auth + app data share one connection)",
    "Separate (auth on its own cluster)",
  ]);
  mongoMode = mongoChoice === 0 ? "single" : "separate";
  useRedis = true;
  authStore = "mongo";
  sessionStore = "redis";
  cacheStore = "redis";
  oauthStateStore = "redis";
} else if (presetChoice === 1) {
  // SQLite
  mongoMode = false;
  useRedis = false;
  authStore = "sqlite";
  sessionStore = "sqlite";
  cacheStore = "sqlite";
  oauthStateStore = "sqlite";
} else if (presetChoice === 2) {
  // Memory
  mongoMode = false;
  useRedis = false;
  authStore = "memory";
  sessionStore = "memory";
  cacheStore = "memory";
  oauthStateStore = "memory";
} else {
  // Custom — prompt each store individually
  console.log("\n  Configure each store:\n");

  // MongoDB
  const mongoChoice = choose("MongoDB:", [
    "Single   (one connection for auth + app data)",
    "Separate (auth on its own cluster)",
    "None     (no MongoDB)",
  ]);
  if (mongoChoice === 0) mongoMode = "single";
  else if (mongoChoice === 1) mongoMode = "separate";
  else mongoMode = false;

  // Redis
  const redisChoice = choose("Redis:", [
    "Yes",
    "No",
  ]);
  useRedis = redisChoice === 0;

  // Build available store options based on what's enabled
  const storeOptions: DbStore[] = [];
  const storeLabels: string[] = [];
  if (useRedis) { storeOptions.push("redis"); storeLabels.push("Redis"); }
  if (mongoMode) { storeOptions.push("mongo"); storeLabels.push("MongoDB"); }
  storeOptions.push("sqlite", "memory");
  storeLabels.push("SQLite", "Memory");

  // Auth store (no redis option)
  const authOptions: ("mongo" | "sqlite" | "memory")[] = [];
  const authLabels: string[] = [];
  if (mongoMode) { authOptions.push("mongo"); authLabels.push("MongoDB"); }
  authOptions.push("sqlite", "memory");
  authLabels.push("SQLite", "Memory");

  const authChoice = choose("Auth store:", authLabels);
  authStore = authOptions[authChoice]!;

  const sessChoice = choose("Sessions store:", storeLabels);
  sessionStore = storeOptions[sessChoice]!;

  const cacheChoice = choose("Cache store:", storeLabels);
  cacheStore = storeOptions[cacheChoice]!;

  const oauthChoice = choose("OAuth state store:", storeLabels);
  oauthStateStore = storeOptions[oauthChoice]!;
}

// If any store uses sqlite, we need the sqlite path
const usesSqlite = authStore === "sqlite" || sessionStore === "sqlite" || cacheStore === "sqlite" || oauthStateStore === "sqlite";

// --- paths ---
const projectDir  = join(process.cwd(), dirName);
const srcDir      = join(projectDir, "src");
const configDir   = join(srcDir, "config");
const libDir      = join(srcDir, "lib");
const routesDir   = join(srcDir, "routes");
const workersDir  = join(srcDir, "workers");
const queuesDir   = join(srcDir, "queues");
const wsDir       = join(srcDir, "ws");
const servicesDir = join(srcDir, "services");
const middlewareDir = join(srcDir, "middleware");
const modelsDir   = join(srcDir, "models");


if (existsSync(projectDir)) {
  console.error(`Directory "${dirName}" already exists.`);
  process.exit(1);
}

// --- build db config string ---
function buildDbConfig(): string {
  const lines: string[] = [];

  if (mongoMode) {
    lines.push(`  mongo: "${mongoMode}",`);
  } else {
    lines.push(`  mongo: false,`);
  }

  lines.push(`  redis: ${useRedis},`);
  lines.push(`  auth: "${authStore}",`);
  lines.push(`  sessions: "${sessionStore}",`);
  lines.push(`  oauthState: "${oauthStateStore}",`);
  lines.push(`  cache: "${cacheStore}",`);

  if (usesSqlite) {
    lines.push(`  sqlite: path.join(import.meta.dir, "../../data.db"),`);
  }

  return `{\n${lines.join("\n")}\n}`;
}

// --- templates ---
const constantsContent = `export const APP_NAME = "${appTitle}";
export const APP_VERSION = "1.0.0";

export const USER_ROLES = {
  ADMIN: "admin",
  USER: "user",
};
`;

const configContent = `import path from "path";
import {
  type AppMeta,
  type AuthConfig,
  type CreateServerConfig,
  type DbConfig,
  type SecurityConfig,
} from "@lastshotlabs/bunshot";
import { APP_NAME, APP_VERSION, USER_ROLES } from "@lib/constants";

export const app: AppMeta = {
  name: APP_NAME,
  version: APP_VERSION,
};

export const routesDir = path.join(import.meta.dir, "../routes");

export const workersDir = path.join(import.meta.dir, "../workers");

export const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export const db: DbConfig = ${buildDbConfig()};

export const auth: AuthConfig = {
  roles: Object.values(USER_ROLES),
  defaultRole: USER_ROLES.USER,
};

export const security: SecurityConfig = {
  cors: ["*"],
};

export const appConfig: CreateServerConfig = {
  app,
  routesDir,
  workersDir,
  port,
  db,
  auth,
  security,
};
`;

const indexContent = `import { createServer } from "@lastshotlabs/bunshot";
import { appConfig } from "@config/index";

await createServer(appConfig);
`;

const readmeContent = `# ${appTitle}

Built with [@lastshotlabs/bunshot](https://github.com/Last-Shot-Labs/bunshot).

## Getting started

\`\`\`bash
# fill in .env with your values
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
  index.ts          # server entry point
  config/index.ts   # centralized app configuration
  lib/constants.ts  # app name, version, roles
  routes/           # file-based routing (each file = a router)
  workers/          # BullMQ workers (auto-imported on start)
  middleware/       # custom middleware
  models/           # data models
  services/         # business logic
\`\`\`

## Adding routes

Create a file in \`src/routes/\`:

\`\`\`ts
// src/routes/products.ts
import { createRouter } from "@lastshotlabs/bunshot";
import { z } from "zod";

export const router = createRouter();

router.get("/products", (c) => c.json({ products: [] }));
\`\`\`
${mongoMode ? `
## Adding models

\`\`\`ts
// src/models/Product.ts
import { appConnection, mongoose } from "@lastshotlabs/bunshot";

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { timestamps: true });

export const Product = appConnection.model("Product", ProductSchema);
\`\`\`
` : ""}
## Environment variables

See \`.env\` — fill in the values before running.
`;

// --- build .env based on choices ---
function buildEnv(): string {
  const sections: string[] = [
    `NODE_ENV=development`,
    `PORT=3000`,
  ];

  if (mongoMode === "single") {
    sections.push(`
# MongoDB
MONGO_USER_DEV=
MONGO_PW_DEV=
MONGO_HOST_DEV=
MONGO_DB_DEV=
MONGO_USER_PROD=
MONGO_PW_PROD=
MONGO_HOST_PROD=
MONGO_DB_PROD=`);
  } else if (mongoMode === "separate") {
    sections.push(`
# MongoDB (app data)
MONGO_USER_DEV=
MONGO_PW_DEV=
MONGO_HOST_DEV=
MONGO_DB_DEV=
MONGO_USER_PROD=
MONGO_PW_PROD=
MONGO_HOST_PROD=
MONGO_DB_PROD=

# MongoDB (auth — separate cluster)
MONGO_AUTH_USER_DEV=
MONGO_AUTH_PW_DEV=
MONGO_AUTH_HOST_DEV=
MONGO_AUTH_DB_DEV=
MONGO_AUTH_USER_PROD=
MONGO_AUTH_PW_PROD=
MONGO_AUTH_HOST_PROD=
MONGO_AUTH_DB_PROD=`);
  }

  if (useRedis) {
    sections.push(`
# Redis
REDIS_HOST_DEV=
REDIS_USER_DEV=
REDIS_PW_DEV=
REDIS_HOST_PROD=
REDIS_USER_PROD=
REDIS_PW_PROD=`);
  }

  sections.push(`
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
APPLE_REDIRECT_URI=`);

  return sections.join("\n") + "\n";
}

// --- scaffold ---
console.log(`\n@lastshotlabs/bunshot — creating ${dirName}\n`);

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
pkg.dependencies = { ...pkg.dependencies, "@lastshotlabs/bunshot": "*" };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// Write tsconfig.json with full compiler options and path aliases
const tsconfigPath = join(projectDir, "tsconfig.json");
const tsconfigContent = {
  compilerOptions: {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleDetection: "force",
    jsx: "react-jsx",
    allowJs: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    noPropertyAccessFromIndexSignature: false,
    paths: {
      "@lib/*":            ["./src/lib/*"],
      "@middleware/*":      ["./src/middleware/*"],
      "@models/*":         ["./src/models/*"],
      "@queues/*":         ["./src/queues/*"],
      "@routes/*":         ["./src/routes/*"],
      "@scripts/*":        ["./src/scripts/*"],
      "@services/*":       ["./src/services/*"],
      "@workers/*":        ["./src/workers/*"],
      "@service-facades/*": ["./src/service-facades/*"],
      "@config/*":         ["./src/config/*"],
      "@constants/*":      ["./src/lib/constants/*"],
    },
  },
};
writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2) + "\n", "utf-8");

// Create src structure
mkdirSync(configDir, { recursive: true });
mkdirSync(libDir, { recursive: true });
mkdirSync(routesDir, { recursive: true });
mkdirSync(workersDir, { recursive: true });
mkdirSync(queuesDir, { recursive: true });
mkdirSync(wsDir, { recursive: true });
mkdirSync(servicesDir, { recursive: true });
mkdirSync(middlewareDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });
writeFileSync(join(libDir, "constants.ts"), constantsContent, "utf-8");
writeFileSync(join(configDir, "index.ts"), configContent, "utf-8");
writeFileSync(join(srcDir, "index.ts"), indexContent, "utf-8");
writeFileSync(join(projectDir, ".env"), buildEnv(), "utf-8");
writeFileSync(join(projectDir, "README.md"), readmeContent, "utf-8");

// --- summary ---
console.log("  Created:");
console.log(`    + ${dirName}/src/index.ts`);
console.log(`    + ${dirName}/src/config/index.ts`);
console.log(`    + ${dirName}/src/lib/constants.ts`);
console.log(`    + ${dirName}/src/routes/`);
console.log(`    + ${dirName}/src/workers/`);
console.log(`    + ${dirName}/src/queues/`);
console.log(`    + ${dirName}/src/ws/`);
console.log(`    + ${dirName}/src/services/`);
console.log(`    + ${dirName}/src/middleware/`);
console.log(`    + ${dirName}/src/models/`);
console.log(`    + ${dirName}/.env`);
console.log(`    + ${dirName}/README.md`);

console.log(`\n  DB config:`);
console.log(`    mongo: ${mongoMode || "none"} | redis: ${useRedis}`);
console.log(`    auth: ${authStore} | sessions: ${sessionStore} | cache: ${cacheStore} | oauthState: ${oauthStateStore}`);

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
