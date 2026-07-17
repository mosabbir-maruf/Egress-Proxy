# Heroku Egress Proxy

A Node.js relay for the RelayAPI egress proxy. `proxy.itsnitrox.tech` blocks
requests from **Cloudflare Workers IPs**. Since the RelayAPI Worker runs on
Cloudflare, blocked hosts are routed through this proxy — a persistent Node.js
process on Heroku that bypasses the block.

## Traffic

- **Manifest**: HLS playlist → Heroku proxy → Nitro CDN
- **Segments**: Video bytes → Heroku proxy → Nitro CDN

Both manifest and segments route through Heroku — no Cloudflare Workers
bandwidth limits.

Proxied hosts: `proxy.itsnitrox.tech`, `web.nxsha.app`.

## File Structure

```text
egress-proxy-heroku/
├── README.md              # This file — setup & run guide
├── package.json           # Project metadata (ESM)
├── Procfile               # Heroku process type (web)
├── .gitignore
└── egress-proxy.js        # Node.js HTTP proxy (no deps)
```

## Environment variables

| Var                     | Default           | Purpose                                                                                  |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `EGRESS_PROXY_KEY`      | _(empty = open)_  | Shared secret. Sent by the Worker as `X-Proxy-Key` (or `?key=`). Required on both sides. |
| `PROXY_ALLOWED_DOMAINS` | _(see allowlist)_ | Comma-separated extra host suffixes to permit.                                           |

The built-in allowlist (cannot be removed) covers `itsnitrox.tech`,
`web.nxsha.app`, `nxsha.app`.

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
