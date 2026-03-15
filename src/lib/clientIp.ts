import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Trust-proxy configuration (set once at startup via setTrustProxy)
// ---------------------------------------------------------------------------

let _trustProxy: false | number = false;

export const setTrustProxy = (value: false | number): void => {
  _trustProxy = value;
};

// ---------------------------------------------------------------------------
// Centralized client IP extraction
// ---------------------------------------------------------------------------

/**
 * Returns the client IP address, respecting the `trustProxy` setting.
 *
 * - When `trustProxy` is `false`: returns the socket-level IP (via Bun's
 *   `server.requestIP()`), ignoring `X-Forwarded-For` entirely.
 * - When `trustProxy` is a number N: takes the Nth-from-right entry in the
 *   `X-Forwarded-For` chain (skipping N trusted proxy hops), falling back to
 *   the socket-level IP.
 *
 * Returns `"unknown"` if no IP can be determined.
 */
export const getClientIp = (c: Context<any>): string => {
  // Socket-level IP via Bun's server (passed as c.env by Bun.serve)
  let socketIp: string | undefined;
  try {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null };
    if (server?.requestIP) {
      const info = server.requestIP(c.req.raw);
      if (info) socketIp = info.address;
    }
  } catch { /* not running under Bun.serve — e.g. test environment */ }

  if (_trustProxy === false) {
    return socketIp ?? "unknown";
  }

  // Trust N proxy hops: take the Nth-from-right in XFF
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map(s => s.trim()).filter(Boolean);
    // Index from the right: trustProxy=1 means 1 proxy, so take ips[length - 2]
    const idx = ips.length - _trustProxy - 1;
    if (idx >= 0 && ips[idx]) {
      return ips[idx];
    }
    // If fewer entries than expected, fall back to leftmost (or socket IP)
    if (ips.length > 0) return ips[0];
  }

  // Fallback: X-Real-IP header, then socket IP
  return c.req.header("x-real-ip") ?? socketIp ?? "unknown";
};
