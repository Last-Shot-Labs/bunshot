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

const parts: string[] = [
  "<!-- AUTO-GENERATED — edit docs/sections/, not this file. Run: bun run readme -->",
];

for (let i = 0; i < config.sections.length; i++) {
  const section = config.sections[i];

  let filePath: string;
  if (section.file) {
    filePath = import.meta.dir + "/" + section.file;
  } else {
    const variant = overrides[section.topic] ?? section.default ?? "full";
    const candidate = `${import.meta.dir}/sections/${section.topic}/${variant}.md`;
    filePath = (await Bun.file(candidate).exists())
      ? candidate
      : `${import.meta.dir}/sections/${section.topic}/full.md`;
  }

  // Normalize to LF — output will be consistent regardless of section file line endings
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
