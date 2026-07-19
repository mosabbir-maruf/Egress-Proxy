# Egress Proxy — Agent Rules & Architecture

## Project Overview
A **zero-dependency Node.js HTTP relay** that forwards requests from Cloudflare
Workers to CDNs blocked on Worker IPs. Deployed as a persistent Heroku dyno.
Called server-to-server by RelayAPI — no browser/client access.

## Deployment Architecture

```
RelayAPI Worker          Egress Proxy (Heroku)
(CF Workers)             (Node 22, persistent)
     │                          │
     │  GET /?url=<target>      │
     │  X-Proxy-Key: <secret>   │
     │─────────────────────────>│
     │                          │── fetch → proxy.itsnitrox.tech/nitro/
     │  <streams media bytes    │── fetch → allowed CDN hosts
```

### Why Heroku?
`proxy.itsnitrox.tech` blocks Cloudflare Workers IPs via WAF. Heroku dynos have
residential-range IPs that pass the WAF. The `/evir/` path (Viper) is also
blocked from Heroku IPs and is fetched directly by the CF Worker instead.

## File Structure

```
egress-proxy-heroku/
├── .agents/
│   └── AGENTS.md           # This file
├── .env.example            # Local env reference
├── .gitignore
├── Procfile                # Heroku process: web: node egress-proxy.js
├── README.md
├── egress-proxy.js         # Single-file HTTP proxy (no deps)
├── MEMORY.md               # Hard-won knowledge & decisions
├── optimization-report.md  # Production audit findings
├── package.json            # ESM, Node 22
└── test/
    └── egress-proxy.test.js  # Integration tests (node:test)
```

## Routes / Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/health`, `/healthz` | GET | Health check → `{ "ok": true }` |
| `/` (no `?url=`) | GET | Status dashboard (HTML page) |
| `/?url=<target>` | GET/POST | Proxy: fetches `<target>` with auth + allowlist checks |

## Key Functions

- `parseTarget(value, base)` — Validates URL, protocol (HTTP/S only), and host
  against `ALLOWED_BASE`. Returns `{ url }` or `{ error }`.
- `fetchAllowedTarget(target, options)` — Follows up to 5 redirects manually,
  re-validating protocol + host on each hop. Uses `redirect: "manual"`.
- `createUpstreamRequestContext(req, res)` — Creates an `AbortController` tied
  to client disconnect (`req.aborted`, `res.close`). A configurable header
  timeout (`EGRESS_PROXY_HEADER_TIMEOUT_MS`, default 15s) aborts if upstream
  headers don't arrive in time. Cleared once headers arrive.
- `forwardHeaders(headers, dropSet)` — Strips hop-by-hop, credential, and
  `cf-`/`x-amz-*`/`x-forwarded-*` headers. Forces `Accept-Encoding: identity`.
- `readBody(req)` — Reads request body up to `MAX_BODY_BYTES` (10 MB). Exceeds
  → 413 without destroying the socket.
- `hasValidKey(provided)` — `timingSafeEqual` comparison to prevent timing
  attacks.
- `safeTargetForLog(value)` — Logs `origin + pathname` only (strips query
  strings with tokens).

### Request flow
1. Validate path → `/health` returns JSON, `/` without `?url=` returns dashboard
2. If `REQUIRED_KEY` is set, compare via `timingSafeEqual` (header or `?key=`)
3. Parse + validate target URL (protocol, host allowlist)
4. Read body if POST/PUT/PATCH (bounded, 413 on overflow)
5. Strip dangerous headers, set `Accept-Encoding: identity`
6. Fetch with manual redirect following (max 5, validated each hop)
7. Stream response body to client; dispose abort hooks on finish/close/error
8. On error: return JSON `{ error: "proxy <code>" }` (502) or 413

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8700` | HTTP listen port |
| `EGRESS_PROXY_KEY` | `""` (open) | Shared auth secret; `timingSafeEqual` comparison |
| `EGRESS_PROXY_HEADER_TIMEOUT_MS` | `15000` | Max ms waiting for upstream response headers |
| `PROXY_ALLOWED_DOMAINS` | — | Comma-separated extra host suffixes for allowlist |

### Built-in allowlist (always on)
`itsnitrox.tech`, `web.nxsha.app`, `nxsha.app`, `ydc1wes.me`, `dpdns.org`

## Integration with RelayAPI

RelayAPI calls the proxy server-to-server:
```
EGRESS_PROXY_URL = https://your-app.herokuapp.com/?url=
EGRESS_DOMAINS   = itsnitrox.tech,web.nxsha.app
```

The proxy is used exclusively for `/nitro/` paths (Phoenix, Jett). `/evir/`
(Viper) bypasses egress because Heroku IP is WAF-blocked for that path.

## Coding Rules

- Zero external dependencies. Only `node:http`, `node:crypto`, `node:stream`,
  `node:url`, and global `fetch`.
- ESM (`"type": "module"` in package.json).
- Always use `timingSafeEqual` for key comparison — never `===` on strings.
- Manual redirects only — never `redirect: "follow"`.
- Always drop `authorization`, `cookie`, `set-cookie` from forwarded headers.
- Log `origin + pathname` only; never log query strings (signed tokens).
- Run `node --check egress-proxy.js` and `npm test` after changes.
- The sister project **RelayAPI** (`/Volumes/Mosabbir/Developement/RelayAPI`)
  is the sole consumer. Keep `ALLOWED_BASE` and `EGRESS_DOMAINS` in sync.
