const BROWSER_HEADERS = [
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "origin",
  "referer",
  "x-requested-with",
] as const;

const encoder = new TextEncoder();

/**
 * Builds a 12-hex-char fingerprint from stable HTTP headers.
 * IP-independent: bots that rotate IPs but use the same HTTP client
 * will produce the same fingerprint and share a rate-limit bucket.
 */
export async function buildFingerprint(req: Request): Promise<string> {
  const h = (name: string) => req.headers.get(name) ?? "";

  // Encode which browser-only headers are present as a bitmask string.
  // Real browsers send most of these; raw HTTP clients send none.
  const bitmap = BROWSER_HEADERS.map((name) =>
    req.headers.has(name) ? "1" : "0"
  ).join("");

  const raw = [
    h("user-agent"),
    h("accept"),
    h("accept-language"),
    h("accept-encoding"),
    h("connection"),
    bitmap,
  ].join("|");

  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  const bytes = new Uint8Array(buf).slice(0, 6);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
