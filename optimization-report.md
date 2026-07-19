# Egress Proxy production audit

**Date:** 2026-07-19  
**Scope:** `egress-proxy-heroku` and its RelayAPI Worker integration.

## Baseline

- The service has no third-party runtime dependencies and targets Node 22.
- `node --check egress-proxy.js` passes.
- There is no automated test suite or dependency lockfile; there are no packages
  to audit.
- RelayAPI calls this service server-to-server with `?url=<target>` and an
  `X-Proxy-Key`; it is used for the allowed Nitro egress path and streams HLS
  manifests and segments back to RelayAPI.

## Findings and recommendations

| Area | Finding | Impact | Recommended action | Risk |
| --- | --- | --- | --- | --- |
| Redirect validation | The initial target is allowlisted, but `fetch(..., { redirect: "follow" })` follows later redirects without validating their destination. | An allowed host can redirect the proxy to an arbitrary or internal address, bypassing the intended egress allowlist. | Follow a small bounded number of redirects manually and validate protocol/host on every hop. | Low |
| Cancellation and timeouts | A client disconnect does not abort the upstream fetch. Streaming requests intentionally receive no timeout, so a stalled upstream can hold a socket indefinitely. | Wasted dyno connections, work, and bandwidth after navigation or stalled media. | Tie client closure to an `AbortController`; apply a configurable timeout only while waiting for upstream response headers, then clear it for active media streaming. | Low |
| Sensitive logging | Request logs include the complete upstream URL. Signed CDN URLs commonly carry tokens in their query strings. | Tokens may leak into Heroku log retention and observability exports. | Log origin and pathname only. | Low |
| Header forwarding | The proxy forwards caller cookies and authorization headers upstream, and can relay upstream `Set-Cookie` headers. | Unnecessary credential/cookie exposure across the proxy boundary. | Drop credential and cookie headers while preserving RelayAPI's referer, origin, range, and user-agent behavior. | Low |
| Request body handling | Oversized forwarded request bodies destroy the request and surface as a generic proxy error. | A client cannot distinguish a rejected payload from an upstream failure. | Return a bounded, explicit 413 response while draining the request safely. | Low |
| Authentication | `EGRESS_PROXY_KEY` is optional by design. | An unset production key makes the allowlisted egress endpoint publicly usable. | Retain local-development compatibility, but warn at startup and document a production key as mandatory operational configuration. | Low |
| Regression coverage | No automated tests cover access control, redirects, or stream lifecycle. | Security and relay behavior can regress silently. | Add dependency-free Node integration tests for authentication, host checks, redirect checks, headers, client cancellation, and stream pass-through. | Low |

## Contract to preserve

- `GET /health` and `/healthz` remain public JSON health checks.
- `/?url=<encoded HTTP(S) target>` remains the RelayAPI-compatible entry point.
- `X-Proxy-Key` remains the preferred authentication mechanism; query-key
  compatibility stays intact.
- Successful upstream responses continue to stream without buffering media in
  the proxy.
- The existing host allowlist and configurable extra domains remain supported.

## Selected implementation

Implement validated manual redirects, request-abort propagation, a
response-header timeout, safe header and log handling, explicit body-limit
errors, dependency-free integration tests, and accurate deployment
documentation. The proxy will not become an unrestricted general-purpose
forward proxy, and active media streams will not receive an arbitrary total
duration timeout.
