import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import tls from "node:tls";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { resolveDirectLink, verifyDirectLink } from "./src/doodstream/resolver.js";

const HTML_PAGE = fs.readFileSync(new URL("client/dashboard.html", import.meta.url), "utf8");
const RESOLVE_PAGE = fs.readFileSync(new URL("client/resolver.html", import.meta.url), "utf8");

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
  "dood.ws",
  "dood.video",
  "dood.so",
  "dood.sh",
  "dood.pm",
  "doodcdn.com",
  "dood.li",
  "myvidplay.com",
  "do7go.com",
  "cloudatacdn.com",
  "cloudadsts.com",
  "cloudadus.com",
];

if (PROXY_ALLOWED_EXTRA) {
  for (const d of PROXY_ALLOWED_EXTRA.split(",")) {
    const h = parseAllowedDomain(d);
    if (h) ALLOWED_BASE.push(h);
  }
}

// --- HTTP/2 with Chrome TLS fingerprint for doodstream CDN domains ---
const SSL_OP_TLSEXT_PADDING = 1 << 4;
const SSL_OP_NO_ENCRYPT_THEN_MAC = 1 << 19;

const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

const CHROME_H2_SETTINGS = {
  headerTableSize: 65536,
  enablePush: false,
  initialWindowSize: 6291456,
  maxFrameSize: 16384,
  maxConcurrentStreams: 1000,
  maxHeaderListSize: 262144,
};

function chromeTlsOptions(hostname, alpn) {
  return {
    host: hostname,
    port: 443,
    servername: hostname,
    ALPNProtocols: alpn || ['h2', 'http/1.1'],
    ciphers: CHROME_CIPHERS,
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
    ecdhCurve: 'X25519:prime256v1:secp384r1',
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    secureOptions: SSL_OP_TLSEXT_PADDING | SSL_OP_NO_ENCRYPT_THEN_MAC,
  };
}

const h2Sessions = new Map();

function getH2Session(origin) {
  if (h2Sessions.has(origin)) {
    const s = h2Sessions.get(origin);
    if (!s.closed && !s.destroyed) return s;
    h2Sessions.delete(origin);
  }
  const url = new URL(origin);
  const session = http2.connect(origin, {
    settings: CHROME_H2_SETTINGS,
    createConnection: () => tls.connect(chromeTlsOptions(url.hostname, ['h2'])),
  });
  session.on('error', () => h2Sessions.delete(origin));
  session.on('close', () => h2Sessions.delete(origin));
  h2Sessions.set(origin, session);
  return session;
}

const CHROME_PROXY_HOSTS = ['cloudatacdn.com', 'cloudadsts.com', 'cloudadus.com'];

function needsChromeTls(hostname) {
  const h = normalizeHost(hostname);
  return CHROME_PROXY_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

function fetchWithChromeH2(urlStr, { headers, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const session = getH2Session(url.origin);
    const reqHeaders = { ':method': 'GET', ':path': url.pathname + url.search, ':authority': url.host, ':scheme': 'https' };
    if (headers) {
      for (const k in headers) reqHeaders[k.toLowerCase()] = String(headers[k]);
    }
    const req = session.request(reqHeaders);
    req.on('response', (responseHeaders) => {
      const status = responseHeaders[':status'];
      const outHeaders = {};
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (!k.startsWith(':')) outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      resolve({
        status,
        headers: outHeaders,
        body: req,
        ok: status >= 200 && status < 300,
      });
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => req.close(), { once: true });
    }
    req.end();
  });
}

function fetchWithChromeH1(urlStr, { headers, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      ...chromeTlsOptions(url.hostname, ['http/1.1']),
    }, (res) => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: res,
        ok: res.statusCode >= 200 && res.statusCode < 300,
      });
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    req.end();
  });
}

async function fetchWithChromeFallback(urlStr, opts) {
  try {
    return await fetchWithChromeH1(urlStr, opts);
  } catch {
    return fetchWithChromeH2(urlStr, opts);
  }
}
// ---------------------------------------------------------

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
const CONFIG_JSON = JSON.stringify({
  allowedHosts: ALLOWED_BASE.length,
  keyRequired: !!REQUIRED_KEY,
  headerTimeout: Math.round(UPSTREAM_HEADER_TIMEOUT_MS / 1000),
});

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
    if (response.body instanceof Readable) {
      response.body.destroy();
    } else {
      await response.body?.cancel();
    }
  } catch {}
}

function proxyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function getLocation(headers) {
  if (typeof headers?.get === 'function') return headers.get("location");
  return headers?.location || headers?.Location || null;
}

async function fetchAllowedTarget(target, { method, headers, body, signal }) {
  let currentUrl = target;
  let currentMethod = method;
  let currentBody = body;
  const useChrome = needsChromeTls(new URL(currentUrl).hostname);

  for (let redirects = 0; ; redirects += 1) {
    const upstream = useChrome
      ? await fetchWithChromeFallback(currentUrl, { headers, signal })
      : await fetch(currentUrl, {
          method: currentMethod,
          headers,
          body: currentBody,
          signal,
          redirect: "manual",
        });

    if (!isRedirect(upstream.status)) return { upstream, target: currentUrl };

    const location = getLocation(upstream.headers);
    await cancelBody(upstream);
    if (!location) throw proxyError("ERR_REDIRECT_MISSING_LOCATION");
    if (redirects >= MAX_REDIRECTS) throw proxyError("ERR_TOO_MANY_REDIRECTS");

    const next = parseTarget(location, currentUrl);
    if (next.error) throw proxyError(`ERR_REDIRECT_${next.error.toUpperCase()}`);

    if (!useChrome && (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && currentMethod === "POST"))) {
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

    if (pathname === "/api/config") {
      sendJson(res, 200, CONFIG_JSON);
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
      const nodeStream = upstream.body instanceof Readable
        ? upstream.body
        : Readable.fromWeb(upstream.body);
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
