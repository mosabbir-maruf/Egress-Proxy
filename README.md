# Egress Proxy

A Node.js relay for the RelayAPI egress proxy. `proxy.itsnitrox.tech` blocks
requests from **Cloudflare Workers IPs**. Since the RelayAPI Worker runs on
Cloudflare, blocked hosts are routed through this proxy — a persistent Node.js
process on Heroku that bypasses the block.

## Traffic

- **Manifest**: HLS playlist → Heroku proxy → Nitro CDN
- **Segments**: Video bytes → Heroku proxy → Nitro CDN

Both manifest and segments route through Heroku — no Cloudflare Workers
bandwidth limits.

## File Structure

```text
egress-proxy-heroku/
├── .env.example           # Local env reference (key, extra domains)
├── .gitignore
├── Procfile               # Heroku process type (web)
├── README.md              # This file — setup & run guide
├── egress-proxy.js        # Node.js HTTP proxy (zero deps, 502 lines)
├── optimization-report.md # Production audit findings & implementation
├── package.json           # Project metadata (ESM, Node 22)
└── test/
    └── egress-proxy.test.js  # Integration tests (node:test, zero deps)
```

## Environment variables

| Var                              | Default           | Purpose                                                                                  |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `EGRESS_PROXY_KEY`               | _(empty = open)_  | Shared secret. Sent by the Worker as `X-Proxy-Key` (or `?key=`). Required on both sides. |
| `EGRESS_PROXY_HEADER_TIMEOUT_MS` | `15000`           | Max ms to wait for upstream response headers before aborting. Cleared once headers arrive; active streaming has no timeout. |
| `PROXY_ALLOWED_DOMAINS`          | _(see allowlist)_ | Comma-separated extra host suffixes to permit.                                           |

The built-in allowlist (cannot be removed) covers `itsnitrox.tech`,
`web.nxsha.app`, `nxsha.app`, `ydc1wes.me`, `dpdns.org`.

## Testing

```bash
npm test
```

Runs the integration test suite via Node's built-in test runner (no
dependencies). Covers auth, host blocking, redirect validation, header
sanitization, header timeout, and client-abort propagation.

## Deploy

```bash
# Create Heroku app
heroku create your-egress-proxy

# Set auth key
heroku config:set EGRESS_PROXY_KEY=$(openssl rand -hex 32)

# Deploy
git init
git add .
git commit -m "init"
git push heroku main

# Scale to a free dyno
heroku ps:scale web=1
```

## Configure RelayAPI Worker

Set the Worker secrets:

```bash
wrangler secret put EGRESS_PROXY_URL
# Value: https://your-egress-proxy.herokuapp.com/?url=

wrangler secret put EGRESS_PROXY_KEY
# Value: the same key you set on Heroku

wrangler secret put EGRESS_DOMAINS
# Value: itsnitrox.tech,web.nxsha.app
```

## Verify

```bash
# with key (expect 200):
curl -sS "https://your-egress-proxy.herokuapp.com/?url=https://proxy.itsnitrox.tech/nitro/test.m3u8&key=YOUR_KEY"

# without key (expect 403 when key is set):
curl -sS -o /dev/null -w "%{http_code}" "https://your-egress-proxy.herokuapp.com/?url=https://proxy.itsnitrox.tech"

# health check:
curl -sS "https://your-egress-proxy.herokuapp.com/health"
```

## Security notes

- **Key comparison** uses `timingSafeEqual` to prevent timing attacks.
- **Cookie/credential headers** are stripped from forwarded requests
  (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`).
- **Redirects** are followed manually (max 5 hops) with protocol and host
  validation on every hop — no blind `redirect: "follow"`.
- **Client disconnect** immediately aborts the upstream fetch via an
  `AbortController`.
- If `EGRESS_PROXY_KEY` is unset on **both** sides the proxy runs "open". Fine
  for local testing; set it before production to stop open-proxy abuse.
- The proxy drops `cf-`, `x-amz-cf-`, `x-amzn-`, `x-forwarded-` (and hop-by-hop
  headers / `x-proxy-key`) and forces `Accept-Encoding: identity` to avoid
  relay errors.
- Only HTTP/HTTPS targets on the allowlist are fetched. Anything else → `403`.
- No CORS headers are emitted — the Worker calls the proxy server-to-server, so
  cross-origin browser responses are not needed.

## Request format

The Worker calls the proxy as:

```
https://your-egress-proxy.herokuapp.com/?url=<encoded-target>
```

The key may be passed as `?key=<secret>` or the `X-Proxy-Key` header.
