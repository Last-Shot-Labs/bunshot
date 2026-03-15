// Temporary script to split README.md into section files
// Run once, then delete

const readme = await Bun.file(import.meta.dir + "/../README.md").text();
const lines = readme.split("\n");

// Define sections by [startLine, endLine] (1-indexed, inclusive)
const sections: [string, string, number, number][] = [
  // [dir, filename, startLine, endLine]
  ["", "header.md", 1, 3],
  ["quick-start", "full.md", 5, 47],
  ["stack", "full.md", 51, 61],
  ["cli", "full.md", 64, 93],
  ["installation", "full.md", 97, 103],
  ["configuration-example", "full.md", 106, 205],
  ["adding-routes", "full.md", 208, 390],
  ["mongodb-connections", "full.md", 393, 438],
  ["adding-models", "full.md", 441, 566],
  ["jobs", "full.md", 569, 709],
  ["websocket", "full.md", 712, 812],
  ["websocket-rooms", "full.md", 815, 912],
  ["adding-middleware", "full.md", 915, 950],
  ["response-caching", "full.md", 953, 1068],
  ["extending-context", "full.md", 1071, 1130],
  ["configuration", "full.md", 1133, 1264],
  ["running-without-redis", "full.md", 1267, 1283],
  ["running-without-redis-or-mongodb", "full.md", 1286, 1346],
  ["auth-flow", "full.md", 1349, 1754],
  ["roles", "full.md", 1757, 1893],
  ["multi-tenancy", "full.md", 1896, 1958],
  ["oauth", "full.md", 1961, 2080],
  ["peer-dependencies", "full.md", 2083, 2126],
  ["environment-variables", "full.md", 2129, 2184],
  ["package-development", "full.md", 2187, 2194],
  ["exports", "full.md", 2197, 2279],
];

for (const [dir, filename, start, end] of sections) {
  const content = lines.slice(start - 1, end).join("\n").trimEnd() + "\n";
  const path = dir
    ? `${import.meta.dir}/sections/${dir}/${filename}`
    : `${import.meta.dir}/sections/${filename}`;
  await Bun.write(path, content);
  console.log(`Wrote ${dir || "header"}/${filename} (lines ${start}-${end})`);
}

console.log(`\nDone — ${sections.length} files written`);
