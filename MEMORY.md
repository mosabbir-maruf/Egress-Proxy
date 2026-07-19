# Egress Proxy — Memory

> Hard-won knowledge and decisions for the Heroku egress proxy. Read this
> before making changes.

---

## Why This Proxy Exists

`proxy.itsnitrox.tech` (Nitro CDN) blocks Cloudflare Workers IPs via WAF.
Heroku dynos use residential-range IPs that aren't blocked. The proxy sits
between the CF Worker and the CDN, forwarding requests from a permitted IP.

**Not all paths work through Heroku:** `/evir/` (Viper) is also blocked from
Heroku IPs. RelayAPI's `shouldUseEgress()` skips egress for `/evir/` and
fetches directly.

---

## Security Decisions

### Manual redirect validation (not `redirect: "follow"`)
The initial target is allowlisted, but automatic redirect following can
bypass the allowlist — an allowed host redirects to an arbitrary/internal
address. `fetchAllowedTarget` validates protocol + host on every hop (max 5).

### Timing-safe key comparison
`timingSafeEqual` prevents timing attacks on the auth key. The legacy `===`
string comparison was replaced during the production audit.

### Credential header stripping
`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` are
dropped from forwarded requests. Before the audit, these were passed through
unintentionally — a credential exposure risk at the proxy boundary.

### Safe logging
Signed CDN URLs carry tokens in query strings. `safeTargetForLog()` logs only
`origin + pathname`. Before the audit, the full URL (including query params)
was logged.

---

## Design Decisions

### Header timeout (15s) but no streaming timeout
The `UPSTREAM_HEADER_TIMEOUT_MS` aborts if upstream doesn't respond with
headers in 15s. Once headers arrive (indicating the CDN is actively streaming),
the timeout is cleared — active media streams have no artificial limit.
Before the audit, streaming requests had no timeout at all (stalled upstreams
held sockets indefinitely), and non-streaming requests had a 10s
`AbortSignal.timeout`.

### `Accept-Encoding: identity`
Forces the upstream to return uncompressed content. Avoids relay errors from
compressed streams. The header is set in the forwarded request; Node's `fetch`
may append the default `gzip, deflate` but `identity` takes precedence on the
upstream side.

### Client abort propagation
When the RelayAPI Worker disconnects (navigation, cancellation, page exit),
the client socket closes. `createUpstreamRequestContext` listens for
`req.aborted` and `res.close` and aborts the upstream fetch. Before the audit,
client disconnects left upstream fetches running indefinitely.

### Request body limit (10 MB)
Oversized bodies return a clean `413` with drain, not a destroyed socket.
Before the audit, oversized bodies destroyed the request and surfaced as a
generic proxy error.

---

## Heroku-Specific Constraints

- **No filesystem writes** beyond the ephemeral dyno filesystem (fine — the
  proxy is stateless).
- **Free dynos spin down** after 30 min of inactivity. First request after
  idle takes ~5s cold start. This is fine for RelayAPI's use pattern.
- **Dyno can run as `web` process only** (Procfile: `web: node egress-proxy.js`).
- **No native `fetch` timeout for streaming** — handled via `AbortController`.
- **Server timeouts are tuned for Heroku:** `keepAliveTimeout: 75s`,
  `headersTimeout: 80s`, `requestTimeout: 120s`, `timeout: 0` (no idle
  socket timeout — Heroku's load balancer handles that).

---

## Production Audit (2026-07-19)

All findings from `optimization-report.md` were implemented. Key changes:

| Finding | Fix |
|---------|-----|
| Blind redirect following | Manual redirects with per-hop validation |
| No client disconnect abort | `AbortController` tied to `req.aborted`/`res.close` |
| Full URL in logs | `safeTargetForLog()` strips query strings |
| Credential headers forwarded | `DROP_REQ` / `DROP_RES` with auth/cookie headers |
| Oversized body → generic error | Explicit 413 with body drain |
| No streaming timeout / indefinite wait | 15s header timeout, cleared after headers arrive |
| No test coverage | `test/egress-proxy.test.js` (190 lines, `node:test`, zero deps) |
| Plain `===` key comparison | `timingSafeEqual` |
| Missing `EGRESS_PROXY_HEADER_TIMEOUT_MS` env var | Configurable via env, default 15s |

---

## Common Pitfalls

- **Adding hosts to `ALLOWED_BASE`**: Also add to `EGRESS_DOMAINS` in RelayAPI
  and to `PROXY_ALLOWED_DOMAINS` here. Verify both sides.
- **Changing header dropping logic**: `DROP_REQ` affects what reaches the CDN;
  `DROP_RES` affects what reaches the Worker. `x-proxy-key` must always be
  dropped from both.
- **Node version**: Heroku uses Node 22 (set in `package.json` `engines`).
  Global `fetch` is required — don't add `node-fetch` or other deps.
