import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";

const PORT = Number(process.env.PORT) || 8700;
const REQUIRED_KEY = process.env.EGRESS_PROXY_KEY || "";

const ALLOWED_BASE = [
  "itsnitrox.tech",
  "web.nxsha.app",
  "nxsha.app",
];

try {
  const extra = process.env.PROXY_ALLOWED_DOMAINS;
  if (extra) {
    for (const d of String(extra).split(",")) {
      const h = String(d).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      if (h) ALLOWED_BASE.push(h);
    }
  }
} catch {}

function isAllowedHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return ALLOWED_BASE.some((b) => h === b || h.endsWith(`.${b}`));
}

const DROP_REQ_PREFIXES = ["cf-", "x-amz-cf-", "x-amzn-", "x-forwarded-"];

const DROP_REQ = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "keep-alive", "proxy-connection", "proxy-authorization", "te",
  "trailers", "x-proxy-key", "forwarded", "upgrade",
]);

const DROP_RES = new Set([...DROP_REQ, "content-encoding"]);

function isDroppedReqHeader(name) {
  const lower = name.toLowerCase();
  if (DROP_REQ.has(lower)) return true;
  return DROP_REQ_PREFIXES.some((p) => lower.startsWith(p));
}

function isDroppedResHeader(name) {
  const lower = name.toLowerCase();
  if (DROP_RES.has(lower)) return true;
  return DROP_REQ_PREFIXES.some((p) => lower.startsWith(p));
}

function filterHeaders(headers, dropFn) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (dropFn(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Egress Proxy · Heroku</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0c0b09; --surface: #131210; --border: #252320; --border2: #302e2b;
      --fg: #e8e4dc; --fg2: #b5afae; --fg3: #7a7670;
      --amber: #e8a020; --amber-d: rgba(232,160,32,0.08); --amber-b: rgba(232,160,32,0.18);
      --green: #3dba6e; --green-d: rgba(61,186,110,0.1); --blue: #4a8fe0; --blue-d: rgba(74,143,224,0.1);
      --mono: 'Geist Mono', 'JetBrains Mono', monospace;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;transition:background .2s,color .2s,border-color .2s}
    body{font-family:'Geist','Inter',system-ui,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
    .topbar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:48px}
    .topbar-left{display:flex;align-items:center;gap:1.25rem}
    .wordmark{font-family:var(--mono);font-size:.8rem;font-weight:500;color:var(--fg);display:flex;align-items:center;gap:.5rem}
    .wordmark-sep{color:var(--fg3);font-weight:300}
    .wordmark-sub{color:var(--fg2);font-weight:400}
    .topbar-status{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--green);font-family:var(--mono)}
    .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0;animation:blink 3s ease-in-out infinite}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
    .topbar-right{display:flex;align-items:center;gap:1.25rem}
    .clock{font-family:var(--mono);font-size:.72rem;color:var(--fg2);letter-spacing:.02em}
    .nav-link{font-size:.72rem;color:var(--fg2);text-decoration:none;transition:color .12s;display:inline-flex;align-items:center;gap:.25rem}
    .nav-link:hover{color:var(--fg)}
    .main{max-width:840px;margin:0 auto;padding:3rem 2rem 6rem;display:flex;flex-direction:column;gap:1.5rem}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:2rem}
    .card-hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding-bottom:1.25rem;border-bottom:1px solid var(--border);margin-bottom:1.25rem}
    .card-title{font-size:1.15rem;font-weight:500;letter-spacing:-.02em;color:var(--fg)}
    .card-title span{color:var(--amber)}
    .card-sub{font-size:.78rem;color:var(--fg2);margin-top:.2rem;font-weight:400}
    .card-meta{text-align:right;flex-shrink:0}.card-meta:empty{display:none}
    .meta-line{font-family:var(--mono);font-size:.68rem;color:var(--fg3);line-height:1.8}
    .meta-line b{color:var(--fg2);font-weight:500}
    .info-grid{display:flex;flex-direction:column;gap:.75rem}
    .info-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.5rem 0}
    .info-row+.info-row{border-top:1px solid var(--border)}
    .info-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);font-weight:500;flex-shrink:0}
    .info-value{font-family:var(--mono);font-size:.8rem;color:var(--fg);text-align:right;word-break:break-all}
    .info-value.amber{color:var(--amber)}
    .badge{font-family:var(--mono);font-size:.6rem;font-weight:500;padding:.15rem .45rem;border-radius:3px;letter-spacing:.04em;background:var(--green-d);color:var(--green);border:1px solid rgba(61,186,110,.2)}
    .summary{display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden}
    .summary-item{flex:1;padding:.875rem 1.25rem;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:.2rem}
    .summary-item:last-child{border-right:none}
    .plane-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
    .s-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg3);font-weight:500}
    .s-val{font-family:var(--mono);font-size:1.15rem;font-weight:500;letter-spacing:-.02em;color:var(--fg);line-height:1}
    .s-val.amber{color:var(--amber)}
    section{display:flex;flex-direction:column;gap:.625rem}
    .section-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.1em;color:var(--fg3);font-weight:500;display:flex;align-items:center;gap:.75rem}
    .section-label::after{content:'';flex:1;height:1px;background:var(--border)}
    .foot{display:flex;align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;padding-top:1.5rem;border-top:1px solid var(--border)}
    .foot-copy{font-size:.7rem;color:var(--fg2);font-family:var(--mono)}
    .foot-copy a{text-decoration:none;color:inherit}
    ::-webkit-scrollbar{width:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
    @media(max-width:640px){
      .topbar{padding:0 1rem}
      .main{padding:2rem 1rem 4rem}
      .topbar-right{gap:.75rem}
      .card-hdr{flex-direction:column}
      .card-meta{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.4rem;margin-top:1rem}
      .card-meta .meta-line{display:flex;justify-content:space-between;align-items:center;width:100%}
      .summary{flex-direction:column}
      .summary-item{border-right:none;border-bottom:1px solid var(--border)}
      .plane-grid{grid-template-columns:1fr}
      .info-row{flex-direction:column;align-items:flex-start;gap:.25rem}
      .info-value{text-align:left;width:100%}
    }
    @media(max-width:480px){
      .topbar-right .clock,.wordmark-sub{display:none}
      .summary-item{padding:.75rem 1rem}
    }
  </style>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23e8a020'%3E%3Ccircle cx='12' cy='12' r='4'/%3E%3C/svg%3E">
</head>
<body>
  <div class="topbar">
    <div class="topbar-left">
      <div class="wordmark"><span>egress-proxy</span><span class="wordmark-sep">/</span><span class="wordmark-sub">heroku</span></div>
      <div class="topbar-status"><span class="dot"></span>operational</div>
    </div>
    <div class="topbar-right">
      <span class="clock" id="clock">--:--:-- UTC</span>
      <a href="/health" class="nav-link">health</a>
      <a href="https://github.com/mosabbir-maruf/nitro-egress" target="_blank" rel="noopener" class="nav-link" aria-label="GitHub repo"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></a>
    </div>
  </div>
  <div class="main">
    <div class="card">
      <div class="card-hdr">
        <div>
          <h1 class="card-title">Egress <span>Proxy</span></h1>
          <div class="card-sub">Nitro CDN relay · Heroku</div>
        </div>
        <div class="card-meta"></div>
      </div>
      <div class="info-grid">
        <div class="info-row">
          <span class="info-label">Endpoint</span>
          <span class="info-value"><span class="badge">/?url=</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="info-value"><span class="badge">Active</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">Runtime</span>
          <span class="info-value amber">Persistent process</span>
        </div>
        <div class="info-row">
          <span class="info-label">Usage</span>
          <span class="info-value">Manifest + segments · unlimited bandwidth</span>
        </div>
      </div>
    </div>
    <section>
      <div class="section-label">architecture</div>
      <div class="card" style="padding:1.5rem;display:flex;flex-direction:column;gap:1.1rem">
        <p style="margin:0;font-size:.82rem;color:var(--fg2);line-height:1.65"><strong style="color:var(--fg)">proxy.itsnitrox.tech</strong> blocks Cloudflare Workers IPs. This proxy runs on a <strong style="color:var(--fg)">non-Cloudflare</strong> Heroku dyno to bypass the block.</p>
        <div class="plane-grid">
          <div style="border:1px solid var(--border);border-radius:6px;padding:.875rem 1.1rem;display:flex;flex-direction:column;gap:.45rem">
            <span style="font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--amber);font-weight:500">Manifest</span>
            <span style="font-family:var(--mono);font-size:.76rem;color:var(--fg)">HLS playlist</span>
            <span style="font-family:var(--mono);font-size:.76rem;color:var(--fg2)">&rarr; Heroku proxy &rarr; Nitro CDN</span>
          </div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:.875rem 1.1rem;display:flex;flex-direction:column;gap:.45rem">
            <span style="font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--green);font-weight:500">Segments</span>
            <span style="font-family:var(--mono);font-size:.76rem;color:var(--fg)">Video bytes</span>
            <span style="font-family:var(--mono);font-size:.76rem;color:var(--fg2)">&rarr; Heroku proxy &rarr; Nitro CDN</span>
          </div>
        </div>
        <p style="margin:0;font-size:.72rem;color:var(--fg3);line-height:1.65">Proxied hosts: <code style="font-family:var(--mono);background:var(--bg);padding:.1rem .3rem;border-radius:3px;border:1px solid var(--border);color:var(--amber)">proxy.itsnitrox.tech</code>. All requests route through Heroku — no Cloudflare Workers bandwidth limits.</p>
      </div>
    </section>
    <section>
      <div class="section-label">summary</div>
      <div class="summary">
        <div class="summary-item">
          <span class="s-label">Allowed Hosts</span>
          <span class="s-val amber">${ALLOWED_BASE.length}</span>
          <span class="s-label" style="font-size:.62rem;color:var(--fg3);font-family:var(--mono);font-weight:400">domains</span>
        </div>
        <div class="summary-item">
          <span class="s-label">Key Required</span>
          <span class="s-val">${REQUIRED_KEY ? 'Yes' : 'No'}</span>
          <span class="s-label" style="font-size:.62rem;color:var(--fg3);font-family:var(--mono);font-weight:400">X-Proxy-Key auth</span>
        </div>
        <div class="summary-item">
          <span class="s-label">Timeout</span>
          <span class="s-val">None</span>
          <span class="s-label" style="font-size:.62rem;color:var(--fg3);font-family:var(--mono);font-weight:400">streaming</span>
        </div>
      </div>
    </section>
    <footer class="foot">
      <span class="foot-copy">&copy; 2026 <a href="https://github.com/mosabbir-maruf/" target="_blank" rel="noopener">Mosabbir Maruf</a> · <a href="https://github.com/mosabbir-maruf/nitro-egress" target="_blank" rel="noopener">nitro-egress</a></span>
    </footer>
  </div>
  <script>
    (()=>{const p=v=>String(v).padStart(2,'0');function tick(){const n=new Date();document.getElementById('clock').textContent=p(n.getUTCHours())+':'+p(n.getUTCMinutes())+':'+p(n.getUTCSeconds())+' UTC'}tick();setInterval(tick,1000)})();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (reqUrl.pathname === "/health" || reqUrl.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if ((reqUrl.pathname === "/" || reqUrl.pathname === "") && !reqUrl.searchParams.get("url")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" });
      res.end(HTML_PAGE);
      return;
    }

    if (REQUIRED_KEY) {
      const provided = req.headers["x-proxy-key"] || reqUrl.searchParams.get("key") || "";
      if (provided !== REQUIRED_KEY) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
    }

    const target = reqUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, { error: "missing url" });
      return;
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      sendJson(res, 400, { error: "invalid url" });
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      sendJson(res, 400, { error: "only http/https supported" });
      return;
    }
    if (!isAllowedHost(parsed.hostname)) {
      sendJson(res, 403, { error: "host not allowed" });
      return;
    }

    const method = req.method;
    let body;
    if (["POST", "PUT", "PATCH"].includes(method)) {
      body = await readBody(req);
    }

    const isStreaming =
      Boolean(req.headers["range"]) ||
      /\.(mp4|ts|m3u8|webm|m4v|mkv)$/i.test(parsed.pathname);
    const signal = isStreaming ? undefined : AbortSignal.timeout(10000);

    const upHeaders = filterHeaders(req.headers, isDroppedReqHeader);
    upHeaders["Accept-Encoding"] = "identity";

    const upstream = await fetch(target, {
      method,
      headers: upHeaders,
      body: body || undefined,
      signal,
      redirect: "follow",
    });

    const outHeaders = filterHeaders(
      Object.fromEntries(upstream.headers.entries()),
      isDroppedResHeader,
    );
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", () => { try { res.destroy(); } catch {} });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    const code = err?.name === "TimeoutError" ? "timeout" : err?.code || "error";
    if (!res.headersSent) {
      sendJson(res, 502, { error: `proxy error: ${code}` });
    } else {
      try { res.destroy(); } catch {}
    }
  }
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

function gracefulShutdown() {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(PORT, () => {
  console.log(`Egress proxy listening on port ${PORT}${REQUIRED_KEY ? " (key required)" : " (open)"}`);
});
