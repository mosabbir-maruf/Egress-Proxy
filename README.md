# Heroku / Koyeb Proxy Service

A single Node.js process hosting two independent services:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| **Egress Proxy** | `/?url=<target>` | Relay CDN requests from Cloudflare Workers |
| **DoodStream Resolver** | `POST /api/resolve` | Resolve video IDs to direct CDN URLs |

Both share the same HTTP server (zero npm dependencies). Deployable on Heroku or Koyeb.

---

## Table of Contents

- [1. Architecture](#1-architecture)
- [2. File Structure](#2-file-structure)
- [3. Services](#3-services)
  - [3.1 Egress Proxy](#31-egress-proxy)
  - [3.2 DoodStream Resolver](#32-doodstream-resolver)
- [4. Web Interface](#4-web-interface)
- [5. Environment Variables](#5-environment-variables)
- [6. Local Development](#6-local-development)
- [7. Deployment](#7-deployment)
- [8. Testing](#8-testing)
- [9. Security](#9-security)
- [10. Credits](#10-credits)

---

## 1. Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐     ┌──────────────┐
│  Caller      │────▶│  Heroku / Koyeb (this service)     │────▶│  Upstream    │
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
├── Procfile                          # Heroku process definition
├── package.json                      # ESM, Node 22, zero dependencies
├── .node-version                     # Node.js version pin
├── egress-proxy.js                   # HTTP server + route handlers + HTML templates
├── .env.example                      # Local environment reference
├── README.md                         # This file
├── test/
│   └── egress-proxy.test.js          # Integration tests (node:test)
└── src/
    ├── doodstream/
    │   └── resolver.js               # DoodStream pass_md5 handshake (94 lines)
    └── http/
        ├── client.js                 # Chrome TLS + HTTP/2 transport (244 lines)
        └── browser-headers.js        # Chrome 131 header profiles (36 lines)
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
GET /?url=<url-encoded-target>&key=<auth-key>
```

The key may also be sent as the `X-Proxy-Key` header.

**Response:** The upstream response is streamed back as-is (headers + body).
Status codes, `Content-Type`, `Content-Length`, `Content-Range`, and
`Accept-Ranges` are preserved.

**Allowed domains** (built-in):

```
itsnitrox.tech, web.nxsha.app, nxsha.app, ydc1wes.me, dpdns.org,
clarionwellbeing.cfd, animanga.fun, lizer123.site, korso420dim.com,
tripplestream.online, goodstream.cc, doodstream.com, playmogo.com
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
  -H "X-Proxy-Key: your-key" \
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
| `403` | Missing or invalid `X-Proxy-Key` (if `EGRESS_PROXY_KEY` is set) |
| `502` | CDN verification failed (upstream did not return `200`/`206`) |

**Resolve pipeline:**

```
client                     Heroku/Koyeb                     doodstream.com / playmogo.com
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

## 4. Web Interface

Two web pages are served at the root path:

| Path | Description |
|------|-------------|
| `/` | Dashboard — shows service status, allowed hosts, environment config |
| `/resolve` | Resolver test page — input video ID + key, resolve, copy links, play video |

The `/resolve` page includes an HTML5 video player and copy buttons for both
the direct CDN link and the egress proxy URL. Both pages share the same
dark/light theme (persisted in localStorage).

---

## 5. Environment Variables

| Variable | Default | Applies to | Description |
|----------|---------|------------|-------------|
| `PORT` | `8700` | — | HTTP listen port (Heroku/Koyeb sets this automatically) |
| `EGRESS_PROXY_KEY` | _(empty = open)_ | Both services | Shared secret. Passed as `X-Proxy-Key` header or `?key=` query param. Required on both endpoints when set. |
| `EGRESS_PROXY_HEADER_TIMEOUT_MS` | `15000` | Egress Proxy only | Max ms to wait for upstream response headers. Cleared once headers arrive. |
| `PROXY_ALLOWED_DOMAINS` | _(see built-in list)_ | Egress Proxy only | Comma-separated extra host suffixes to permit. |

---

## 6. Local Development

```bash
# Start server (default port 8700)
node egress-proxy.js

# Test health
curl -sS "http://localhost:8700/health"

# Test doodstream resolver (open mode — no key)
curl -X POST http://localhost:8700/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"videoId":"02n3dhf9fvqu"}'

# Open web dashboard
open http://localhost:8700
```

---

## 7. Deployment

### Heroku

```bash
heroku create your-app-name
git push heroku main
heroku ps:scale web=1

# Set auth key
heroku config:set EGRESS_PROXY_KEY=$(openssl rand -hex 32)
```

### Koyeb

1. Push the repository to GitHub
2. Create a Koyeb app → Deploy from GitHub
3. Build command: leave blank (zero dependencies)
4. Start command: `node src/server/index.js` → **use** `node egress-proxy.js`
5. Port: `8700`
6. Set `EGRESS_PROXY_KEY` in Koyeb dashboard env vars

> **Note:** The doodstream resolver requires the hosting provider's IP range
> to not be blocked by Cloudflare. Koyeb works; Heroku does not for this
> specific endpoint.

---

## 8. Testing

```bash
npm test
```

Runs integration tests via Node's built-in test runner (no dependencies). Covers
auth validation, host blocking, redirect handling, header sanitization, timeout
propagation, and client-abort cleanup for the egress proxy.

> The DoodStream resolver is not included in automated tests — it requires live
> network access to external hosts (doodstream.com, playmogo.com). Test it
> manually via the `/resolve` web page or `curl` as shown in [§3.2](#32-doodstream-resolver).

---

## 9. Security

| Measure | Implementation |
|---------|---------------|
| Timing-safe auth | `timingSafeEqual` for key comparison on both endpoints |
| Credential stripping | `authorization`, `cookie`, `x-api-key`, etc. dropped from forwarded requests |
| Redirect validation | Manual redirect following (max 5 hops) with protocol + host check on every hop |
| Client disconnect | `AbortController` aborts upstream fetch immediately on client close |
| Header timeout | Upstream must respond within `EGRESS_PROXY_HEADER_TIMEOUT_MS` |
| Body limit | 10 MB max request body (enforced during streaming read) |
| Closed proxy mode | Set `EGRESS_PROXY_KEY` to secure both endpoints |

---

## 10. Credits

DoodStream resolver core logic by [sharoon7171](https://github.com/sharoon7171)
— [doodstream-direct-resolver](https://github.com/sharoon7171/doodstream-direct-resolver).
pass_md5 handshake, TLS fingerprint, and `buildDirectLink` reverse-engineered
from that project.

Integration, egress proxy, web interface, and deployment by
[Mosabbir Maruf](https://github.com/mosabbir-maruf/).
