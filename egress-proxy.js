import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { resolveDirectLink, verifyDirectLink } from "./src/doodstream/resolver.js";

const PORT = Number(process.env.PORT) || 8700;
const REQUIRED_KEY = process.env.EGRESS_PROXY_KEY || "";
const UPSTREAM_HEADER_TIMEOUT_MS = positiveInteger(
  process.env.EGRESS_PROXY_HEADER_TIMEOUT_MS,
  15_000,
);

const PROXY_ALLOWED_EXTRA = process.env.PROXY_ALLOWED_DOMAINS;

const ALLOWED_BASE = [
  "itsnitrox.tech",
  "web.nxsha.app",
  "nxsha.app",
  "ydc1wes.me",
  "dpdns.org",
  "clarionwellbeing.cfd",
  "animanga.fun",
  "lizer123.site",
  "korso420dim.com",
  "tripplestream.online",
  "goodstream.cc",
  "doodstream.com",
  "playmogo.com",
];

if (PROXY_ALLOWED_EXTRA) {
  for (const d of PROXY_ALLOWED_EXTRA.split(",")) {
    const h = parseAllowedDomain(d);
    if (h) ALLOWED_BASE.push(h);
  }
}

const RE_HTTP = /^https?:$/;

const JSON_OK = JSON.stringify({ ok: true });
const JSON_MISSING = JSON.stringify({ error: "missing url" });
const JSON_INVALID = JSON.stringify({ error: "invalid url" });
const JSON_PROTO = JSON.stringify({ error: "only http/https supported" });
const JSON_HOST = JSON.stringify({ error: "host not allowed" });
const JSON_FORBIDDEN = JSON.stringify({ error: "forbidden" });
const JSON_BODY_TOO_LARGE = JSON.stringify({ error: "request body too large" });
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const CT_JSON = { "content-type": "application/json" };

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/\.$/, "");
}

function parseAllowedDomain(value) {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const normalized = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    return normalizeHost(new URL(normalized).hostname);
  } catch {
    return "";
  }
}

function isAllowedHost(host) {
  if (!host) return false;
  const h = normalizeHost(host);
  return ALLOWED_BASE.some((b) => h === b || h.endsWith("." + b));
}

const DROP_REQ = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "keep-alive", "proxy-connection", "proxy-authorization", "te",
  "trailers", "x-proxy-key", "forwarded", "upgrade", "authorization",
  "cookie", "set-cookie", "x-api-key", "x-auth-token",
]);

const DROP_RES = new Set([...DROP_REQ, "content-encoding"]);

const DROP_PREFIXES = ["cf-", "x-amz-cf-", "x-amzn-", "x-forwarded-"];

function isDropped(name, dropSet) {
  const lower = name.toLowerCase();
  if (dropSet.has(lower)) return true;
  for (let i = 0; i < DROP_PREFIXES.length; i++) {
    if (lower.startsWith(DROP_PREFIXES[i])) return true;
  }
  return false;
}

function forwardHeaders(headers, dropSet) {
  const out = {};
  const iter = headers[Symbol.iterator] ? headers : Object.entries(headers);
  for (const [k, v] of iter) {
    if (!isDropped(k, dropSet) && v !== undefined) {
      out[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, CT_JSON);
  res.end(body);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.code = "ERR_BODY_TOO_LARGE";
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        fail(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.once("aborted", () => fail(new Error("request aborted")));
    req.once("error", fail);
  });
}

function hasValidKey(provided) {
  if (typeof provided !== "string") return false;
  const expected = Buffer.from(REQUIRED_KEY);
  const received = Buffer.from(provided);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function parseTarget(value, base) {
  let parsed;
  try {
    parsed = new URL(value, base);
  } catch {
    return { error: "invalid" };
  }
  if (!RE_HTTP.test(parsed.protocol)) return { error: "protocol" };
  if (!isAllowedHost(parsed.hostname)) return { error: "host" };
  return { url: parsed };
}

function sendTargetError(res, error) {
  if (error === "host") return sendJson(res, 403, JSON_HOST);
  if (error === "protocol") return sendJson(res, 400, JSON_PROTO);
  return sendJson(res, 400, JSON_INVALID);
}

function safeTargetForLog(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid target>";
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {}
}

function proxyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function fetchAllowedTarget(target, { method, headers, body, signal }) {
  let currentUrl = target;
  let currentMethod = method;
  let currentBody = body;

  for (let redirects = 0; ; redirects += 1) {
    const upstream = await fetch(currentUrl, {
      method: currentMethod,
      headers,
      body: currentBody,
      signal,
      redirect: "manual",
    });

    if (!isRedirect(upstream.status)) return { upstream, target: currentUrl };

    const location = upstream.headers.get("location");
    await cancelBody(upstream);
    if (!location) throw proxyError("ERR_REDIRECT_MISSING_LOCATION");
    if (redirects >= MAX_REDIRECTS) throw proxyError("ERR_TOO_MANY_REDIRECTS");

    const next = parseTarget(location, currentUrl);
    if (next.error) throw proxyError(`ERR_REDIRECT_${next.error.toUpperCase()}`);

    if (
      upstream.status === 303 ||
      ((upstream.status === 301 || upstream.status === 302) && currentMethod === "POST")
    ) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    currentUrl = next.url.toString();
  }
}

function createUpstreamRequestContext(req, res) {
  const controller = new AbortController();
  const abortForClientClose = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("client connection closed", "AbortError"));
    }
  };
  const headerTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("upstream response timeout", "TimeoutError"));
    }
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  req.once("aborted", abortForClientClose);
  res.once("close", abortForClientClose);

  return {
    signal: controller.signal,
    clearHeaderTimeout: () => clearTimeout(headerTimer),
    dispose: () => {
      clearTimeout(headerTimer);
      req.removeListener("aborted", abortForClientClose);
      res.removeListener("close", abortForClientClose);
    },
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Egress Proxy</title>
<style>
:root{--bg:#f7f5f1;--surface:#eeebe6;--border:#d4d0c8;--fg:#1c1a16;--fg2:#5c5850;--fg3:#9a958c;--amber:#a06c0c;--green:#1f7a44;--green-d:rgba(31,122,68,0.1);--mono:'Geist Mono','JetBrains Mono',monospace}
.dark{--bg:#0c0b09;--surface:#131210;--border:#252320;--fg:#e8e4dc;--fg2:#b5afae;--fg3:#7a7670;--amber:#e8a020;--green:#3dba6e;--green-d:rgba(61,186,110,0.1)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist','Inter',system-ui,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.topbar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:48px}
.topbar-left{display:flex;align-items:center;gap:1.25rem}
.wordmark{font-family:var(--mono);font-size:.8rem;font-weight:500;color:var(--fg);display:flex;align-items:center;gap:.5rem}
.wordmark-sep{color:var(--fg3);font-weight:300}
.topbar-status{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--green);font-family:var(--mono)}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0}
.topbar-right{display:flex;align-items:center;gap:1rem}
.clock{font-family:var(--mono);font-size:.72rem;color:var(--fg2);letter-spacing:.02em}
.nav-link{font-size:.72rem;color:var(--fg2);text-decoration:none;cursor:pointer;background:none;border:none;display:inline-flex;align-items:center;gap:.25rem}
.nav-link:hover{color:var(--fg)}
.main{max-width:840px;margin:0 auto;padding:3rem 2rem 6rem;display:flex;flex-direction:column;gap:1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:2rem}
.card-hdr{padding-bottom:1.25rem;border-bottom:1px solid var(--border);margin-bottom:1.25rem}
.card-title{font-size:1.15rem;font-weight:500;letter-spacing:-.02em;color:var(--fg)}
.card-title span{color:var(--amber)}
.card-sub{font-size:.78rem;color:var(--fg2);margin-top:.2rem}
.info-grid{display:flex;flex-direction:column;gap:.75rem}
.info-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.5rem 0}
.info-row+.info-row{border-top:1px solid var(--border)}
.info-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);font-weight:500}
.info-value{font-family:var(--mono);font-size:.8rem;color:var(--fg);text-align:right;word-break:break-all}
.info-value.amber{color:var(--amber)}
.badge{font-family:var(--mono);font-size:.6rem;font-weight:500;padding:.15rem .45rem;border-radius:3px;background:var(--green-d);color:var(--green);border:1px solid rgba(61,186,110,.2)}
.summary{display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.summary-item{flex:1;padding:.875rem 1.25rem;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:.2rem}
.summary-item:last-child{border-right:none}
.s-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);font-weight:500}
.s-val{font-family:var(--mono);font-size:1.15rem;font-weight:500;color:var(--fg);line-height:1}
.s-val.amber{color:var(--amber)}
section{display:flex;flex-direction:column;gap:.625rem}
.section-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.1em;color:var(--fg3);font-weight:500;display:flex;align-items:center;gap:.75rem}
.section-label::after{content:'';flex:1;height:1px;background:var(--border)}
.foot{display:flex;align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;padding-top:1.5rem;border-top:1px solid var(--border)}
.foot-copy{font-size:.7rem;color:var(--fg2);font-family:var(--mono)}
.foot-copy a{text-decoration:none;color:inherit}
@media(max-width:640px){
  .topbar{padding:0 1rem}
  .main{padding:2rem 1rem 4rem}
  .summary{flex-direction:column}
  .summary-item{border-right:none;border-bottom:1px solid var(--border)}
  .info-row{flex-direction:column;align-items:flex-start;gap:.25rem}
  .info-value{text-align:left;width:100%}
}
@media(max-width:480px){
  .topbar-right .clock{display:none}
  .summary-item{padding:.75rem 1rem}
}
</style>
</head>
<body>
<div class="topbar">
<div class="topbar-left">
<div class="wordmark"><span>egress-proxy</span><span class="wordmark-sep">/</span><span>heroku</span></div>
<div class="topbar-status"><span class="dot"></span>operational</div>
</div>
<div class="topbar-right">
<span class="clock" id="clock"></span>
<button id="theme-btn" class="nav-link" aria-label="Toggle theme">
<svg class="theme-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
<svg class="theme-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
</button>
<a href="/resolve" target="_blank" rel="noopener" class="nav-link">resolver</a>
<a href="/health" target="_blank" rel="noopener" class="nav-link">health</a>
<a href="https://github.com/mosabbir-maruf/Egress-Proxy" target="_blank" rel="noopener" class="nav-link" aria-label="GitHub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></a>
</div>
</div>
<div class="main">
<div class="card">
<div class="card-hdr">
<h1 class="card-title">Egress <span>Proxy</span></h1>
<div class="card-sub">Nitro CDN relay · DoodStream resolver</div>
</div>
<div class="info-grid">
<div class="info-row"><span class="info-label">Endpoint</span><span class="info-value"><span class="badge">/?url=</span></span></div>
<div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="badge">Active</span></span></div>
<div class="info-row"><span class="info-label">Runtime</span><span class="info-value amber">Persistent process</span></div>
<div class="info-row"><span class="info-label">Usage</span><span class="info-value">Manifest + segments</span></div>
</div>
</div>
<section>
<div class="section-label">summary</div>
<div class="summary">
<div class="summary-item"><span class="s-label">Allowed Hosts</span><span class="s-val amber">${ALLOWED_BASE.length}</span></div>
<div class="summary-item"><span class="s-label">Key Required</span><span class="s-val">${REQUIRED_KEY ? "Yes" : "No"}</span></div>
<div class="summary-item"><span class="s-label">Header timeout</span><span class="s-val">${Math.round(UPSTREAM_HEADER_TIMEOUT_MS / 1000)}s</span></div>
</div>
</section>
<section>
<div class="section-label">environment</div>
<div class="card" style="padding:0">
<div class="info-grid" style="padding:1.25rem 1.5rem">
<div class="info-row"><span class="info-label"><code style="font-family:var(--mono);font-size:.72rem;color:var(--fg);background:var(--bg);padding:.1rem .35rem;border-radius:3px;border:1px solid var(--border)">EGRESS_PROXY_KEY</code></span><span class="info-value">${REQUIRED_KEY ? '<span class="badge" style="background:var(--green-d);color:var(--green);border-color:rgba(61,186,110,.2)">set</span>' : '<span style="color:var(--fg3)">not set</span>'}</span></div>
<div class="info-row"><span class="info-label"><code style="font-family:var(--mono);font-size:.72rem;color:var(--fg);background:var(--bg);padding:.1rem .35rem;border-radius:3px;border:1px solid var(--border)">PROXY_ALLOWED_DOMAINS</code></span><span class="info-value"><span style="font-family:var(--mono);font-size:.72rem;color:var(--fg3)">extra domains via csv</span></span></div>
</div>
    </div>
    </section>
    <section>
    <div class="section-label">resolver</div>
    <div class="card" style="padding:1.25rem 1.5rem">
      <div class="info-grid">
      <div class="info-row">
        <span class="info-label">Endpoint</span>
        <span class="info-value"><span class="badge">POST /api/resolve</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">Auth</span>
        <span class="info-value">${REQUIRED_KEY ? '<span class="badge" style="background:var(--green-d);color:var(--green);border-color:rgba(61,186,110,.2)">X-Proxy-Key</span>' : '<span class="badge" style="background:rgba(192,57,43,0.1);color:#c0392b;border-color:rgba(192,57,43,0.2)">missing key</span>'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Test page</span>
        <span class="info-value"><a href="/resolve" target="_blank" class="nav-link" style="font-size:.7rem;text-decoration:underline;color:var(--amber)">/resolve →</a></span>
      </div>
      </div>
    </div>
    </section>
    <footer class="foot">
    <span class="foot-copy">&copy; 2026 <a href="https://github.com/mosabbir-maruf/" target="_blank" rel="noopener">Mosabbir Maruf</a> &middot; <a href="https://github.com/mosabbir-maruf/Egress-Proxy" target="_blank" rel="noopener">Egress-Proxy</a></span>
    </footer>
    </div>
    <script>
    (function(){var p=String.prototype.padStart.bind;function t(){var n=new Date();document.getElementById("clock").textContent=(n.getUTCHours()<10?"0":"")+n.getUTCHours()+":"+(n.getUTCMinutes()<10?"0":"")+n.getUTCMinutes()+":"+(n.getUTCSeconds()<10?"0":"")+n.getUTCSeconds()+" UTC"}t();setInterval(t,1e3)})();
    (function(){var b=document.getElementById("theme-btn");if(!b)return;var k="egress-proxy-theme";function s(d){document.documentElement.classList.toggle("dark",d);var u=b.querySelector(".theme-sun"),m=b.querySelector(".theme-moon");if(u)u.style.display=d?"none":"";if(m)m.style.display=d?"":"none";try{localStorage.setItem(k,d?"dark":"light")}catch(e){}}var v;try{v=localStorage.getItem(k)}catch(e){};if(v==="dark"||v===null)s(true);else if(v==="light")s(false);b.addEventListener("click",function(){s(!document.documentElement.classList.contains("dark"))})    })();
    </script>
</body>
</html>`;

const RESOLVE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>DoodStream Resolver</title>
<style>
:root{--bg:#f7f5f1;--surface:#eeebe6;--border:#d4d0c8;--fg:#1c1a16;--fg2:#5c5850;--fg3:#9a958c;--amber:#a06c0c;--green:#1f7a44;--green-d:rgba(31,122,68,0.1);--mono:'Geist Mono','JetBrains Mono',monospace}
.dark{--bg:#0c0b09;--surface:#131210;--border:#252320;--fg:#e8e4dc;--fg2:#b5afae;--fg3:#7a7670;--amber:#e8a020;--green:#3dba6e;--green-d:rgba(61,186,110,0.1)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist','Inter',system-ui,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.topbar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:48px}
.topbar-left{display:flex;align-items:center;gap:1.25rem}
.wordmark{font-family:var(--mono);font-size:.8rem;font-weight:500;color:var(--fg);display:flex;align-items:center;gap:.5rem}
.wordmark-sep{color:var(--fg3);font-weight:300}
.topbar-status{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--green);font-family:var(--mono)}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0}
.topbar-right{display:flex;align-items:center;gap:1rem}
.nav-link{font-size:.72rem;color:var(--fg2);text-decoration:none;cursor:pointer;background:none;border:none;display:inline-flex;align-items:center;gap:.25rem;padding:.25rem .5rem;border-radius:4px}
.nav-link:hover{color:var(--fg);background:var(--green-d)}
.nav-link.active{color:var(--amber)}
.main{max-width:960px;margin:0 auto;padding:2rem 2rem 4rem;display:flex;flex-direction:column;gap:1.25rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.5rem}
.card-inline{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
.foot{display:flex;align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;padding-top:1.5rem;border-top:1px solid var(--border)}
.foot-copy{font-size:.7rem;color:var(--fg2);font-family:var(--mono)}
.foot-copy a{text-decoration:none;color:inherit}
.badge{font-family:var(--mono);font-size:.6rem;font-weight:500;padding:.15rem .45rem;border-radius:3px;background:var(--green-d);color:var(--green);border:1px solid rgba(61,186,110,.2)}
.info-grid{display:grid;grid-template-columns:auto 1fr;gap:.5rem .75rem;align-items:center}
.info-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);font-weight:500}
.info-value{font-family:var(--mono);font-size:.78rem;color:var(--fg);word-break:break-all}
.btn{padding:.35rem 1rem;font-family:var(--mono);font-size:.72rem;border:1px solid var(--amber);border-radius:4px;background:var(--amber);color:#fff;cursor:pointer;white-space:nowrap}
.btn:disabled{opacity:.5;cursor:default}
.btn-copy{padding:.25rem .6rem;font-size:.65rem;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--fg2);cursor:pointer}
.btn-copy:hover{background:var(--green-d);border-color:var(--green);color:var(--green)}
input{font-family:var(--mono);font-size:.78rem}
.player-wrap{aspect-ratio:16/9;background:#000;border-radius:4px;overflow:hidden}
.player-wrap video{width:100%;height:100%;display:block}
#error-msg{color:var(--amber)}
@media(max-width:640px){
  .topbar{padding:0 1rem}
  .main{padding:1.5rem 1rem 3rem}
  .info-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="topbar">
<div class="topbar-left">
<div class="wordmark"><span>egress-proxy</span><span class="wordmark-sep">/</span><span>doodstream</span></div>
<div class="topbar-status" id="status-dot"><span class="dot"></span>ready</div>
</div>
<div class="topbar-right">
<a href="/" class="nav-link" target="_blank" rel="noopener">Dashboard</a>
<a href="/resolve" class="nav-link active" target="_blank">Resolver</a>
<a href="/health" class="nav-link" target="_blank" rel="noopener">Health</a>
<a href="https://github.com/mosabbir-maruf/Egress-Proxy" target="_blank" rel="noopener" class="nav-link" aria-label="GitHub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></a>
</div>
</div>
<div class="main">
<div class="card">
<div class="card-inline">
<input id="vid-input" type="text" placeholder="Video ID (e.g. 02n3dhf9fvqu)" value="02n3dhf9fvqu"
  style="flex:1;min-width:200px;padding:.35rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);outline:none">
<input id="key-input" type="password" placeholder="X-Proxy-Key (optional)"
  style="flex:1;min-width:160px;padding:.35rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);outline:none;font-size:.7rem">
<button id="resolve-btn" class="btn">Resolve</button>
<span id="status-text" style="font-family:var(--mono);font-size:.72rem;color:var(--fg3)"></span>
</div>
</div>

<div id="result-area" style="display:none">
<div class="card" style="padding:0">
<div class="info-grid" style="padding:1.25rem 1.5rem">
<div class="info-label">Title</div><div class="info-value" id="r-title" style="font-size:.82rem">—</div>
<div class="info-label">Direct Link</div>
<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
  <span class="info-value" id="r-direct-link" style="font-size:.7rem">—</span>
  <button class="btn-copy" onclick="copy('r-direct-link')">Copy</button>
</div>
<div class="info-label">Proxy Link</div>
<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
  <span class="info-value" id="r-proxy-link" style="font-size:.7rem">—</span>
  <button class="btn-copy" onclick="copy('r-proxy-link')">Copy</button>
</div>
<div class="info-label">Referer</div><div class="info-value" id="r-referer" style="font-size:.7rem">—</div>
<div class="info-label">Size</div><div class="info-value" id="r-size">—</div>
</div>
</div>

<div class="card" style="padding:0">
<div class="player-wrap" id="player-wrap">
  <video id="video-player" controls playsinline preload="metadata"></video>
</div>
</div>
</div>

<div id="error-area" style="display:none">
<div class="card"><p id="error-msg"></p></div>
</div>
</div>
<footer class="foot">
<span class="foot-copy">&copy; 2026 <a href="https://github.com/mosabbir-maruf/" target="_blank" rel="noopener">Mosabbir Maruf</a></span>
</footer>
<script>
(function(){var b=document.querySelector(".topbar-right");if(!b)return;var k="egress-proxy-theme";function s(d){document.documentElement.classList.toggle("dark",d)}var v;try{v=localStorage.getItem(k)}catch(e){};if(v==="dark"||v===null)s(true);else if(v==="light")s(false);})();
(function(){
var btn=document.getElementById("resolve-btn"),inp=document.getElementById("vid-input"),keyInp=document.getElementById("key-input"),status=document.getElementById("status-text"),stDot=document.getElementById("status-dot");
function $(i){return document.getElementById(i)}
function show(id){$(id).style.display=""}
function hide(id){$(id).style.display="none"}
function txt(id,t){$(id).textContent=t}
function copy(id){
  var el=$(id);
  if(!el||!el.textContent)return;
  navigator.clipboard.writeText(el.textContent).then(function(){
    var b=el.parentElement.querySelector(".btn-copy");
    if(b){var o=b.textContent;b.textContent="Copied!";setTimeout(function(){b.textContent=o},1500)}
  }).catch(function(){});
}
function run(){
  var id=inp.value.trim();
  if(!id)return;
  hide("result-area");hide("error-area");
  status.textContent="Resolving...";stDot.innerHTML='<span class="dot" style="background:var(--amber)"></span>loading';
  btn.disabled=true;btn.textContent="...";
  var key=keyInp.value.trim();
  var headers={"Content-Type":"application/json"};
  if(key)headers["X-Proxy-Key"]=key;
  fetch("/api/resolve",{method:"POST",headers:headers,body:JSON.stringify({videoId:id})})
  .then(function(r){return r.json()})
  .then(function(d){
    if(d.directLink){
      txt("r-title",d.title||id);
      txt("r-direct-link",d.directLink);
      var proxy=(window.location.origin||"")+"/?url="+encodeURIComponent(d.directLink)+"&referer="+encodeURIComponent(d.referer||"");
      if(key)proxy+="&key="+encodeURIComponent(key);
      txt("r-proxy-link",proxy);
      txt("r-referer",d.referer||"—");
      txt("r-size",d.contentLength?(parseInt(d.contentLength)/1048576).toFixed(1)+" MB":"—");
      show("result-area");
      var video=document.getElementById("video-player");
      video.src=d.directLink;
      video.load();
      status.textContent="Ready";stDot.innerHTML='<span class="dot"></span>ready';
    }else{
      txt("error-msg",d.error||"Unknown error");
      show("error-area");
      status.textContent="Failed";stDot.innerHTML='<span class="dot" style="background:#c00"></span>error';
    }
  })
  .catch(function(e){txt("error-msg",e.message);show("error-area");status.textContent="Error";stDot.innerHTML='<span class="dot" style="background:#c00"></span>error'})
  .finally(function(){btn.disabled=false;btn.textContent="Resolve"});
}
btn.addEventListener("click",run);
inp.addEventListener("keydown",function(e){if(e.key==="Enter")run()});
})();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let target = "";
  const method = req.method || "GET";
  let upstreamContext = null;

  try {
    const reqUrl = new URL(req.url, "http://localhost:" + PORT);
    const pathname = reqUrl.pathname;

    if (pathname === "/health" || pathname === "/healthz") {
      res.writeHead(200, CT_JSON);
      res.end(JSON_OK);
      return;
    }

    if (pathname === "/resolve" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=600",
      });
      res.end(RESOLVE_PAGE);
      return;
    }

    if (pathname === "/api/resolve" && method === "POST") {
      try {
        const headerKey = req.headers["x-proxy-key"];
        const provided = typeof headerKey === "string" ? headerKey : "";
        if (REQUIRED_KEY && !hasValidKey(provided)) {
          sendJson(res, 403, JSON_FORBIDDEN);
          return;
        }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const videoId = (body.videoId || "").trim();
        if (!videoId || !/^[a-z0-9]+$/i.test(videoId)) {
          sendJson(res, 400, JSON.stringify({ error: "Invalid video ID" }));
          return;
        }
        const result = await resolveDirectLink(videoId);
        const verification = await verifyDirectLink(result.directLink, result.referer);
        if (!verification.ok) {
          sendJson(res, 502, JSON.stringify({ error: "Direct link check failed" }));
          return;
        }
        sendJson(res, 200, JSON.stringify({
          videoId: result.videoId,
          title: result.title,
          directLink: result.directLink,
          referer: result.referer,
          contentLength: verification.contentLength,
        }));
      } catch (error) {
        sendJson(res, 400, JSON.stringify({ error: error.message || "Could not resolve direct link" }));
      }
      return;
    }

    if ((pathname === "/" || pathname === "") && !reqUrl.searchParams.has("url")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=600",
      });
      res.end(HTML_PAGE);
      return;
    }

    if (REQUIRED_KEY) {
      const headerKey = req.headers["x-proxy-key"];
      const provided = typeof headerKey === "string" ? headerKey : reqUrl.searchParams.get("key") || "";
      if (!hasValidKey(provided)) {
        sendJson(res, 403, JSON_FORBIDDEN);
        return;
      }
    }

    target = reqUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, JSON_MISSING);
      return;
    }

    const parsedTarget = parseTarget(target);
    if (parsedTarget.error) {
      sendTargetError(res, parsedTarget.error);
      return;
    }
    target = parsedTarget.url.toString();

    let body;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = await readBody(req);
    }

    const upHeaders = forwardHeaders(req.headers, DROP_REQ);
    upHeaders["Accept-Encoding"] = "identity";

    upstreamContext = createUpstreamRequestContext(req, res);
    const { upstream, target: finalTarget } = await fetchAllowedTarget(target, {
      method,
      headers: upHeaders,
      body: body || undefined,
      signal: upstreamContext.signal,
    });
    upstreamContext.clearHeaderTimeout();
    target = finalTarget;

    const status = upstream.status;
    const outHeaders = forwardHeaders(upstream.headers, DROP_RES);

    if (status >= 400) {
      await cancelBody(upstream);
      sendJson(res, 502, JSON.stringify({ error: "upstream " + status }));
      upstreamContext.dispose();
      return;
    }

    res.writeHead(status, outHeaders);
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      const dispose = () => upstreamContext?.dispose();
      nodeStream.once("error", () => {
        dispose();
        if (!res.destroyed) res.destroy();
      });
      res.once("finish", dispose);
      res.once("close", dispose);
      nodeStream.pipe(res);
    } else {
      res.end();
      upstreamContext.dispose();
    }

    console.log(`[${status}] ${method} ${safeTargetForLog(target)} ${Date.now() - t0}ms`);

  } catch (err) {
    upstreamContext?.dispose();
    if (err?.code === "ERR_BODY_TOO_LARGE") {
      if (!res.headersSent && !res.destroyed) sendJson(res, 413, JSON_BODY_TOO_LARGE);
      return;
    }
    if (req.aborted || res.destroyed) return;
    const elapsed = Date.now() - t0;
    const code =
      err?.name === "TimeoutError"
        ? "timeout"
        : typeof err?.code === "string"
          ? err.code
          : "error";
    console.log(`[ERR] ${method} ${safeTargetForLog(target)} ${elapsed}ms ${code}`);
    if (!res.headersSent) {
      sendJson(res, 502, JSON.stringify({ error: "proxy " + code }));
    } else {
      try { res.destroy(); } catch {}
    }
  }
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 120_000;
server.timeout = 0;

function gracefulShutdown() {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(PORT, () => {
  console.log("Egress proxy listening on port " + PORT + (REQUIRED_KEY ? " (key)" : " (open)"));
});
