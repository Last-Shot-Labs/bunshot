## Documentation Generation

Bunshot ships its documentation as modular markdown sections that you can pull into your own project's README.

### Setup

Create a `docs/` directory in your project with a config and build script:

```
my-app/
  docs/
    readme.config.json
    build-readme.ts
    sections/
      intro/
        full.md
      my-api/
        full.md
        overview.md
```

### Config — `docs/readme.config.json`

```json
{
  "output": "../README.md",
  "separator": "---",
  "sections": [
    { "topic": "intro", "default": "full", "separator": false },
    { "topic": "my-api", "default": "full" },
    { "topic": "bunshot-auth", "file": "@lastshotlabs/bunshot/docs/auth-flow/overview.md" },
    { "topic": "bunshot-config", "file": "@lastshotlabs/bunshot/docs/configuration/full.md" }
  ],
  "profiles": {
    "short": {
      "my-api": "overview"
    }
  }
}
```

**Section entries:**

| Field | Description |
|-------|-------------|
| `topic` | Section identifier. Maps to `sections/{topic}/` directory when no `file` is specified. |
| `default` | Variant to use: `"full"` or `"overview"`. Falls back to `"full"` if the requested variant doesn't exist. |
| `file` | Explicit file path. Supports relative paths (`sections/header.md`) and package paths (`@lastshotlabs/bunshot/docs/auth-flow/overview.md`). |
| `separator` | `true`/`false` — whether to insert `---` before this section. Defaults to `true` (except the first section). |

**Profiles** override specific sections' variants. Only list sections you want to change:

```json
"profiles": {
  "short": { "my-api": "overview", "bunshot-auth": "overview" }
}
```

### Build script — `docs/build-readme.ts`

Copy this into your project:

```ts
const configPath = import.meta.dir + "/readme.config.json";
const config = await Bun.file(configPath).json();
const profile = Bun.argv[2];
const overrides: Record<string, string> = profile
  ? config.profiles?.[profile] ?? {}
  : {};
const separator: string = config.separator ?? "---";

if (profile && !config.profiles?.[profile]) {
  console.error(`Unknown profile: "${profile}". Available: ${Object.keys(config.profiles ?? {}).join(", ")}`);
  process.exit(1);
}

function resolveFilePath(file: string): string {
  if (file.startsWith("./") || file.startsWith("/") || file.startsWith("../")) {
    return import.meta.dir + "/" + file;
  }
  if (file.includes("/") && !file.startsWith("sections")) {
    const resolved = import.meta.resolve(file);
    return resolved.replace(/^file:\/\/\//, "");
  }
  return import.meta.dir + "/" + file;
}

const parts: string[] = [
  "<!-- AUTO-GENERATED — edit docs/sections/, not this file. Run: bun run readme -->",
];

for (let i = 0; i < config.sections.length; i++) {
  const section = config.sections[i];

  let filePath: string;
  if (section.file) {
    filePath = resolveFilePath(section.file);
  } else {
    const variant = overrides[section.topic] ?? section.default ?? "full";
    const candidate = `${import.meta.dir}/sections/${section.topic}/${variant}.md`;
    filePath = (await Bun.file(candidate).exists())
      ? candidate
      : `${import.meta.dir}/sections/${section.topic}/full.md`;
  }

  const content = (await Bun.file(filePath).text()).replace(/\r\n/g, "\n");

  const useSeparator = section.separator !== undefined ? section.separator : i > 0;
  if (useSeparator) parts.push(separator);

  parts.push(content.trimEnd());
}

const outputPath = import.meta.dir + "/" + (config.output ?? "../README.md");
await Bun.write(outputPath, parts.join("\n\n") + "\n");
console.log(
  `README.md compiled (${config.sections.length} sections${profile ? `, profile: ${profile}` : ""})`
);
```

### Add to package.json

```json
"scripts": {
  "readme": "bun docs/build-readme.ts",
  "readme:short": "bun docs/build-readme.ts short"
}
```

### Available bunshot sections

Pull any of these into your project's README via `"file": "@lastshotlabs/bunshot/docs/{section}/{variant}.md"`:

| Section | Variants |
|---------|----------|
| `quick-start` | `full` |
| `stack` | `full` |
| `cli` | `full` |
| `installation` | `full` |
| `configuration-example` | `full`, `overview` |
| `adding-routes` | `full`, `overview` |
| `mongodb-connections` | `full`, `overview` |
| `adding-models` | `full`, `overview` |
| `jobs` | `full`, `overview` |
| `websocket` | `full`, `overview` |
| `websocket-rooms` | `full`, `overview` |
| `adding-middleware` | `full` |
| `response-caching` | `full`, `overview` |
| `extending-context` | `full` |
| `configuration` | `full`, `overview` |
| `running-without-redis` | `full` |
| `running-without-redis-or-mongodb` | `full` |
| `auth-flow` | `full`, `overview` |
| `roles` | `full`, `overview` |
| `multi-tenancy` | `full`, `overview` |
| `oauth` | `full`, `overview` |
| `peer-dependencies` | `full` |
| `environment-variables` | `full` |
| `exports` | `full` |

### Writing your own sections

Each section file is self-contained markdown starting with a `## Heading`. Create `docs/sections/{topic}/full.md` and optionally `overview.md`:

```markdown
## My Feature

Description and code examples here...
```

The `---` separators between sections are inserted by the build script — don't include them in section files.