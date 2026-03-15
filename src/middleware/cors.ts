import type { Middleware } from ".";

let _allowedOrigins: string | string[] = "*";

/** Configure the allowed CORS origins. Call once at startup. */
export const setCorsOrigins = (origins: string | string[]) => { _allowedOrigins = origins; };

export const cors: Middleware = async (req, next) => {
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  const res = await next(req);
  const resHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
  return new Response(res.body, { status: res.status, headers: resHeaders });
};

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  let allowOrigin: string;
  if (_allowedOrigins === "*") {
    allowOrigin = "*";
  } else {
    const origins = Array.isArray(_allowedOrigins) ? _allowedOrigins : [_allowedOrigins];
    allowOrigin = requestOrigin && origins.includes(requestOrigin) ? requestOrigin : origins[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...(allowOrigin !== "*" ? { Vary: "Origin" } : {}),
  };
}
