import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";

const PORT = Number(process.env.PORT) || 8700;
const REQUIRED_KEY = process.env.EGRESS_PROXY_KEY || "";

const PROXY_ALLOWED_EXTRA = process.env.PROXY_ALLOWED_DOMAINS;

const ALLOWED_BASE = [
  "itsnitrox.tech",
  "web.nxsha.app",
  "nxsha.app",
  "ydc1wes.me",
  "dpdns.org",
];

if (PROXY_ALLOWED_EXTRA) {
  for (const d of PROXY_ALLOWED_EXTRA.split(",")) {
    const h = d.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (h) ALLOWED_BASE.push(h);
  }
}

const RE_HTTP = /^https?:$/;
const RE_STREAMING = /\.(mp4|ts|m3u8|webm|m4v|mkv)$/i;

const JSON_OK = JSON.stringify({ ok: true });
const JSON_MISSING = JSON.stringify({ error: "missing url" });
const JSON_INVALID = JSON.stringify({ error: "invalid url" });
const JSON_PROTO = JSON.stringify({ error: "only http/https supported" });
const JSON_HOST = JSON.stringify({ error: "host not allowed" });
const JSON_FORBIDDEN = JSON.stringify({ error: "forbidden" });
const MAX_BODY = 10 * 1024 * 1024;

const CT_JSON = { "content-type": "application/json" };

function isAllowedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_BASE.some((b) => h === b || h.endsWith("." + b));
}

const DROP_REQ = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "keep-alive", "proxy-connection", "proxy-authorization", "te",
  "trailers", "x-proxy-key", "forwarded", "upgrade",
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
    if (!isDropped(k, dropSet)) out[k] = v;
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, CT_JSON);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy(new Error("body too large"));
        reject(new Error("body too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
<a href="/health" target="_blank" rel="noopener" class="nav-link">health</a>
<a href="https://github.com/mosabbir-maruf/Egress-Proxy" target="_blank" rel="noopener" class="nav-link" aria-label="GitHub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></a>
</div>
</div>
<div class="main">
<div class="card">
<div class="card-hdr">
<h1 class="card-title">Egress <span>Proxy</span></h1>
<div class="card-sub">Nitro CDN relay · Heroku</div>
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
<div class="summary-item"><span class="s-label">Timeout</span><span class="s-val">None</span></div>
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
<footer class="foot">
<span class="foot-copy">&copy; 2026 <a href="https://github.com/mosabbir-maruf/" target="_blank" rel="noopener">Mosabbir Maruf</a> &middot; <a href="https://github.com/mosabbir-maruf/Egress-Proxy" target="_blank" rel="noopener">Egress-Proxy</a></span>
</footer>
</div>
<script>
(function(){var p=String.prototype.padStart.bind;function t(){var n=new Date();document.getElementById("clock").textContent=(n.getUTCHours()<10?"0":"")+n.getUTCHours()+":"+(n.getUTCMinutes()<10?"0":"")+n.getUTCMinutes()+":"+(n.getUTCSeconds()<10?"0":"")+n.getUTCSeconds()+" UTC"}t();setInterval(t,1e3)})();
(function(){var b=document.getElementById("theme-btn");if(!b)return;var k="egress-proxy-theme";function s(d){document.documentElement.classList.toggle("dark",d);var u=b.querySelector(".theme-sun"),m=b.querySelector(".theme-moon");if(u)u.style.display=d?"none":"";if(m)m.style.display=d?"":"none";try{localStorage.setItem(k,d?"dark":"light")}catch(e){}}var v;try{v=localStorage.getItem(k)}catch(e){};if(v==="dark"||v===null)s(true);else if(v==="light")s(false);b.addEventListener("click",function(){s(!document.documentElement.classList.contains("dark"))})})();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let target = "";

  try {
    const reqUrl = new URL(req.url, "http://localhost:" + PORT);
    const pathname = reqUrl.pathname;
    const method = req.method;

    if (pathname === "/health" || pathname === "/healthz") {
      res.writeHead(200, CT_JSON);
      res.end(JSON_OK);
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
      const provided = req.headers["x-proxy-key"] || reqUrl.searchParams.get("key") || "";
      if (provided !== REQUIRED_KEY) {
        sendJson(res, 403, JSON_FORBIDDEN);
        return;
      }
    }

    target = reqUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, JSON_MISSING);
      return;
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      sendJson(res, 400, JSON_INVALID);
      return;
    }

    if (!RE_HTTP.test(parsed.protocol)) {
      sendJson(res, 400, JSON_PROTO);
      return;
    }

    if (!isAllowedHost(parsed.hostname)) {
      sendJson(res, 403, JSON_HOST);
      return;
    }

    let body;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = await readBody(req);
    }

    const isStreaming = "range" in req.headers || RE_STREAMING.test(parsed.pathname);
    const signal = isStreaming ? undefined : AbortSignal.timeout(10_000);

    const upHeaders = forwardHeaders(req.headers, DROP_REQ);
    upHeaders["Accept-Encoding"] = "identity";

    const upstream = await fetch(target, {
      method,
      headers: upHeaders,
      body: body || undefined,
      signal,
      redirect: "follow",
    });

    const status = upstream.status;
    const outHeaders = forwardHeaders(upstream.headers, DROP_RES);

    if (status >= 400) {
      sendJson(res, 502, JSON.stringify({ error: "upstream " + status }));
      return;
    }

    res.writeHead(status, outHeaders);
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", () => res.destroy());
      nodeStream.pipe(res);
    } else {
      res.end();
    }

    console.log(`[${status}] ${method} ${target} ${Date.now() - t0}ms`);

  } catch (err) {
    const elapsed = Date.now() - t0;
    const code = err?.name === "TimeoutError" ? "timeout" : err?.code || "error";
    console.log(`[ERR] ${method} ${target} ${elapsed}ms ${code}`);
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
