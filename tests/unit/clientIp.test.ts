import { describe, test, expect, beforeEach } from "bun:test";
import { getClientIp, setTrustProxy } from "../../src/lib/clientIp";

/** Minimal mock of a Hono Context for getClientIp testing. */
function mockContext(headers: Record<string, string> = {}, socketIp?: string) {
  return {
    req: {
      raw: {} as Request,
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
    env: socketIp
      ? { requestIP: () => ({ address: socketIp }) }
      : {},
  } as any;
}

beforeEach(() => {
  setTrustProxy(false);
});

describe("getClientIp — trustProxy: false", () => {
  test("returns socket IP, ignoring x-forwarded-for", () => {
    const c = mockContext({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, "10.0.0.1");
    expect(getClientIp(c)).toBe("10.0.0.1");
  });

  test("returns 'unknown' when no socket IP available", () => {
    const c = mockContext({ "x-forwarded-for": "1.2.3.4" });
    expect(getClientIp(c)).toBe("unknown");
  });

  test("returns socket IP when no headers present", () => {
    const c = mockContext({}, "192.168.1.1");
    expect(getClientIp(c)).toBe("192.168.1.1");
  });
});

describe("getClientIp — trustProxy: 1 (one proxy hop)", () => {
  test("takes the second-from-right IP in XFF chain", () => {
    setTrustProxy(1);
    const c = mockContext({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "127.0.0.1");
    // 1 proxy hop → skip last entry (proxy), take 1.2.3.4
    expect(getClientIp(c)).toBe("1.2.3.4");
  });

  test("falls back to leftmost when fewer entries than expected", () => {
    setTrustProxy(1);
    const c = mockContext({ "x-forwarded-for": "1.2.3.4" }, "127.0.0.1");
    expect(getClientIp(c)).toBe("1.2.3.4");
  });

  test("falls back to x-real-ip when no xff", () => {
    setTrustProxy(1);
    const c = mockContext({ "x-real-ip": "9.8.7.6" }, "127.0.0.1");
    expect(getClientIp(c)).toBe("9.8.7.6");
  });

  test("falls back to socket IP when no headers", () => {
    setTrustProxy(1);
    const c = mockContext({}, "10.0.0.5");
    expect(getClientIp(c)).toBe("10.0.0.5");
  });
});

describe("getClientIp — trustProxy: 2 (two proxy hops)", () => {
  test("takes third-from-right IP", () => {
    setTrustProxy(2);
    const c = mockContext({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(getClientIp(c)).toBe("1.1.1.1");
  });

  test("handles chain shorter than expected hops", () => {
    setTrustProxy(2);
    const c = mockContext({ "x-forwarded-for": "1.1.1.1" });
    // Only 1 entry but need 3rd from right → falls back to leftmost
    expect(getClientIp(c)).toBe("1.1.1.1");
  });
});

describe("getClientIp — spoofing prevention", () => {
  test("spoofed XFF is ignored when trustProxy is false", () => {
    setTrustProxy(false);
    // Attacker sets x-forwarded-for to a fake IP
    const c = mockContext({ "x-forwarded-for": "spoofed-ip" }, "real-socket-ip");
    expect(getClientIp(c)).toBe("real-socket-ip");
  });

  test("spoofed XFF entries are skipped with correct trustProxy count", () => {
    setTrustProxy(1);
    // Attacker prepends fake IP: "spoofed, real-client, proxy"
    const c = mockContext({ "x-forwarded-for": "spoofed, 1.2.3.4, 10.0.0.1" });
    // trustProxy=1 → skip 1 from right (proxy=10.0.0.1), take 1.2.3.4
    expect(getClientIp(c)).toBe("1.2.3.4");
  });
});
