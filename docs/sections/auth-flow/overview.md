## Auth Flow

Sessions are backed by Redis (default), MongoDB, SQLite, or memory. Each login creates an independent session keyed by UUID, so multiple devices stay logged in simultaneously.

- **Browser clients**: `POST /auth/login` sets an HttpOnly cookie automatically
- **API clients**: Read `token` from the response body, send `x-user-token: <token>` header

Features include session management (list/revoke), refresh tokens (short-lived access + long-lived refresh with rotation), MFA (TOTP via Google Authenticator, email OTP, recovery codes), account deletion (immediate or queued with grace period), custom auth adapters, rate limiting on all auth endpoints, bot protection (fingerprint rate limiting + CIDR blocklist), and password set/reset flows.

Protect routes with `userAuth`, `requireRole("admin")`, and `requireVerifiedEmail` middleware.
