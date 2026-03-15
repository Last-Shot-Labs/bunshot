import type { MiddlewareHandler } from "hono";
import { getClientIp } from "@lib/clientIp";

// ---------------------------------------------------------------------------
// CIDR helpers (IPv4 only; IPv6 exact-match supported)
// ---------------------------------------------------------------------------

function ipv4ToUint32(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>>
    0
  );
}

function cidrMatchesIpv4(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf("/");
  const network = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefixLen = slash === -1 ? 32 : parseInt(cidr.slice(slash + 1), 10);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipv4ToUint32(network) & mask) === (ipv4ToUint32(ip) & mask);
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;

function normalizeIp(ip: string): string {
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4)
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isBlocked(ip: string, blockList: string[]): boolean {
  const normalized = normalizeIp(ip);
  const isV4 = IPV4_RE.test(normalized);

  for (const entry of blockList) {
    if (isV4) {
      if (cidrMatchesIpv4(entry, normalized)) return true;
    } else {
      // IPv6: exact match only (CIDR support is v2)
      if (entry === normalized) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface BotProtectionOptions {
  /**
   * List of IPv4 CIDRs (e.g. "198.51.100.0/24"), IPv4 exact addresses,
   * or IPv6 exact addresses to block with a 403.
   */
  blockList?: string[];
}

export const botProtection = ({
  blockList = [],
}: BotProtectionOptions): MiddlewareHandler => {
  if (blockList.length === 0) return (_c, next) => next();

  return async (c, next) => {
    const ip = getClientIp(c);

    if (ip !== "unknown" && isBlocked(ip, blockList)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await next();
  };
};
