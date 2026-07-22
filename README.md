# Heroku Proxy Service

A single Node.js process hosting two independent services:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| **Egress Proxy** | `/?url=<target>` | Relay CDN requests from Cloudflare Workers |
| **DoodStream Resolver** | `POST /api/resolve` | Resolve video IDs to direct CDN URLs |

Both share the same HTTP server (zero npm dependencies).

---

## Table of Contents

- [1. Architecture](#1-architecture)
- [2. File Structure](#2-file-structure)
- [3. Services](#3-services)
  - [3.1 Egress Proxy](#31-egress-proxy)
  - [3.2 DoodStream Resolver](#32-doodstream-resolver)
- [4. Environment Variables](#4-environment-variables)
- [5. Local Development](#5-local-development)
- [6. Deployment](#6-deployment)
- [7. Testing](#7-testing)
- [8. Security](#8-security)
- [9. Credits](#9-credits)

---

## 1. Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐     ┌──────────────┐
│  Caller      │────▶│  Heroku (this service)              │────▶│  Upstream    │
│  (external)  │     │                                     │     │  CDN / API   │
│              │     │  /?url=       → Egress Proxy        │     │              │
│              │     │  POST /api/resolve → DoodStream     │     │              │
└─────────────┘     └─────────────────────────────────────┘     └──────────────┘
```

Requests arrive at the same port. The router (`egress-proxy.js`) dispatches to
the correct handler based on the HTTP method and path.

---

## 2. File Structure

```
egress-proxy-heroku/
├── Procfile                        # Heroku process definition
├── package.json                    # ESM, Node 22, zero dependencies
├── egress-proxy.js                 # HTTP server + route handlers
├── .env.example                    # Local environment reference
├── test/
│   └── egress-proxy.test.js        # Integration tests (node:test)
└── src/
    ├── doodstream/
    │   └── resolver.js             # DoodStream pass_md5 handshake
    └── http/
        ├── client.js               # Chrome TLS + HTTP/2 client
        └── browser-headers.js      # Chrome 131 header profiles
```

All source files are zero-dependency — only native Node.js modules are used
(`node:http`, `node:http2`, `node:https`, `node:tls`, `node:zlib`, ...).

---

## 3. Services

### 3.1 Egress Proxy

Relays HTTP requests to allowed CDN domains. Designed to be called from
Cloudflare Workers that are blocked by upstream CDN IP filters.

**Request format:**

```
GET /?url=<url-encoded-target>&key=<optional-auth-key>
```

**Response:** The upstream response is streamed back as-is (headers + body).
Status codes, `Content-Type`, `Content-Length`, `Content-Range`, and
`Accept-Ranges` are preserved.

**Allowed domains** (built-in):

```
itsnitrox.tech, web.nxsha.app, nxsha.app, ydc1wes.me, dpdns.org,
clarionwellbeing.cfd, animanga.fun, lizer123.site, korso420dim.com,
tripplestream.online, goodstream.cc
```

Additional domains can be added via the `PROXY_ALLOWED_DOMAINS` environment
variable (comma-separated).

**Error responses:**

| Status | Meaning |
|--------|---------|
| `400` | Missing or invalid `url` parameter |
| `403` | Invalid or missing auth key (if `EGRESS_PROXY_KEY` is set) |
| `403` | Target host not in allowed domains list |
| `413` | Request body exceeds 10 MB limit |
| `502` | Upstream fetch failed (timeout, DNS, connection refused, ...) |

---

### 3.2 DoodStream Resolver

Resolves a DoodStream video ID to a direct CDN URL. Bypasses Cloudflare on
playmogo.com by impersonating Chrome's TLS fingerprint — no headless browser,
no JavaScript execution.

**Request:**

```bash
curl -X POST https://your-app.herokuapp.com/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"videoId": "02n3dhf9fvqu"}'
```

**Success response (`200`):**

```json
{
  "videoId": "02n3dhf9fvqu",
  "title": "string | null",
  "directLink": "https://cdn...mp4?token=...&expiry=...",
  "referer": "https://playmogo.com/",
  "contentLength": "341841060"
}
```

**Error responses:**

| Status | Cause |
|--------|-------|
| `400` | Invalid video ID format |
| `400` | Embed page could not be loaded or parsed |
| `400` | Video not found or removed from host |
| `400` | Token expired or rate limited (retry with fresh request) |
| `502` | CDN verification failed (upstream did not return `200`/`206`) |

**Resolve pipeline:**

```
client                     Heroku                           doodstream.com / playmogo.com
  │                          │                                      │
  │── POST /api/resolve ────▶│                                      │
  │                          │── GET /e/{videoId} ─────────────────▶│
  │                          │◀─ embed HTML (pass_md5 path) ───────│
  │                          │── GET /pass_md5/{hash}/{token} ─────▶│
  │                          │◀─ CDN prefix URL ───────────────────│
  │                          │── HEAD directLink (verify) ─────────▶│
  │                          │◀─ 206 Partial Content ──────────────│
  │◀── JSON with directLink ─│                                      │
  │                          │                                      │
```

---

## 4. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8700` | HTTP listen port (Heroku sets this automatically) |
| `EGRESS_PROXY_KEY` | _(empty = open proxy)_ | Shared secret for egress proxy auth. Passed as `X-Proxy-Key` header or `?key=` query param. |
| `EGRESS_PROXY_HEADER_TIMEOUT_MS` | `15000` | Max milliseconds to wait for upstream response headers before aborting. Cleared once headers arrive; streaming has no timeout. |
| `PROXY_ALLOWED_DOMAINS` | _(see built-in list)_ | Comma-separated extra host suffixes to permit in egress proxy. |

---

## 5. Local Development

```bash
# Start server (default port 8700)
node egress-proxy.js

# Test egress proxy
curl -sS "http://localhost:8700/health"

# Test doodstream resolver
curl -X POST http://localhost:8700/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"videoId":"02n3dhf9fvqu"}'
```

---

## 6. Deployment

```bash
heroku create your-app-name
git push heroku main
heroku ps:scale web=1

# (Optional) Set auth key for egress proxy
heroku config:set EGRESS_PROXY_KEY=$(openssl rand -hex 32)
```

The `Procfile` defines the process type. Heroku sets `PORT` automatically.

---

## 7. Testing

```bash
npm test
```

Runs integration tests via Node's built-in test runner (no dependencies). Covers
auth validation, host blocking, redirect handling, header sanitization, timeout
propagation, and client-abort cleanup for the egress proxy.

---

## 8. Security

| Measure | Implementation |
|---------|---------------|
| Timing-safe auth | `timingSafeEqual` for key comparison |
| Credential stripping | `authorization`, `cookie`, `x-api-key`, etc. dropped from forwarded requests |
| Redirect validation | Manual redirect following (max 5 hops) with protocol + host check on every hop |
| Client disconnect | `AbortController` aborts upstream fetch immediately on client close |
| Header timeout | Upstream must respond within `EGRESS_PROXY_HEADER_TIMEOUT_MS` |
| Body limit | 10 MB max request body (enforced during streaming read) |
| Closed proxy mode | Set `EGRESS_PROXY_KEY` to prevent open-proxy abuse |

---

## 9. Credits

DoodStream resolver core logic by [sharoon7171](https://github.com/sharoon7171)
— [doodstream-direct-resolver](https://github.com/sharoon7171/doodstream-direct-resolver).
pass_md5 handshake, TLS fingerprint, and `buildDirectLink` reverse-engineered
from that project.
