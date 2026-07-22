# Egress Proxy + DoodStream Resolver

A combined Node.js service on Heroku:

1. **Egress Proxy** — Relay for CDN domains blocked from Cloudflare Workers IPs.
2. **DoodStream Resolver** — Resolves dood.li / playmogo.com video IDs to direct
   CDN URLs via Chrome TLS fingerprint (bypasses Cloudflare).

## File Structure

```text
egress-proxy-heroku/
├── .env.example              # Local env reference
├── .gitignore
├── Procfile                  # Heroku process type (web)
├── README.md                 # This file
├── egress-proxy.js           # HTTP server (zero deps)
├── package.json              # ESM, Node 22
├── test/
│   └── egress-proxy.test.js  # Integration tests
└── src/
    ├── doodstream/
    │   └── resolver.js       # DoodStream embed → CDN URL
    └── http/
        ├── client.js         # Chrome TLS + HTTP/2 client
        └── browser-headers.js# Chrome 131 header profiles
```

## Endpoints

### `/?url=<encoded-target>` — Egress Proxy

Forwards requests to allowed CDN domains through Heroku.

### `POST /api/resolve` — DoodStream Resolver

```bash
curl -X POST https://your-app.herokuapp.com/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"videoId": "02n3dhf9fvqu"}'
```

**Success response:**
```json
{
  "videoId": "02n3dhf9fvqu",
  "title": "string | null",
  "directLink": "https://cdn...mp4?token=...&expiry=...",
  "referer": "https://playmogo.com/",
  "contentLength": "341841060"
}
```

**Errors:**
| Status | Cause |
|--------|-------|
| 400 | Invalid video ID, resolve failure |
| 502 | CDN verification failed |

### `/health` — Health Check

Returns `{"ok": true}`.

## Environment variables

| Var                              | Default           | Purpose                                                                                  |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `EGRESS_PROXY_KEY`               | _(empty = open)_  | Shared secret for proxy endpoint.                                                        |
| `EGRESS_PROXY_HEADER_TIMEOUT_MS` | `15000`           | Max ms to wait for upstream response headers.                                            |
| `PROXY_ALLOWED_DOMAINS`          | _(see allowlist)_ | Comma-separated extra host suffixes for proxy.                                           |

## Testing

```bash
npm test
```

## Deploy

```bash
heroku create your-app
git push heroku main
heroku ps:scale web=1
```

## Security notes

- **Key comparison** uses `timingSafeEqual` to prevent timing attacks.
- **Cookie/credential headers** are stripped from forwarded requests.
- **Redirects** followed manually (max 5 hops) with validation on every hop.
- **Client disconnect** immediately aborts the upstream fetch via `AbortController`.
- Only HTTP/HTTPS targets on the allowlist are fetched. Anything else → `403`.

## How the DoodStream resolver works

1. `GET https://doodstream.com/e/{videoId}` — follows redirect to active mirror
   (playmogo.com), bypasses Cloudflare via Chrome TLS fingerprint.
2. Extracts `/pass_md5/{hash}/{token}` path from embed HTML.
3. `GET {mirror}/pass_md5/{hash}/{token}` — returns CDN prefix URL.
4. Builds final CDN URL with 10-char random suffix + token + expiry.
5. Verifies CDN link with `Range: bytes=0-15` HEAD request.

## Credits

DoodStream resolver core logic by [sharoon7171](https://github.com/sharoon7171)
— [doodstream-direct-resolver](https://github.com/sharoon7171/doodstream-direct-resolver).
pass_md5 handshake, TLS fingerprint, and `buildDirectLink` reverse-engineered
from that project.
