import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("egress proxy exited during startup");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(25);
  }
  throw new Error("egress proxy did not become healthy");
}

async function startProxy() {
  const port = await reservePort();
  const child = spawn(process.execPath, ["egress-proxy.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      EGRESS_PROXY_KEY: "test-key",
      PROXY_ALLOWED_DOMAINS: "127.0.0.1",
      EGRESS_PROXY_HEADER_TIMEOUT_MS: "150",
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);
  return { baseUrl, child };
}

async function stopProxy(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function settlesWithin(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("enforces egress boundaries while preserving allowed media streaming", async (t) => {
  let receivedHeaders = null;
  let resolveUpstreamClose;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClose = resolve;
  });
  const upstream = http.createServer((req, res) => {
    if (req.url === "/ok") {
      receivedHeaders = req.headers;
      res.writeHead(200, { "set-cookie": "upstream=secret", "x-upstream": "ok" });
      res.end("media bytes");
      return;
    }
    if (req.url === "/redirect-allowed") {
      res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/ok` });
      res.end();
      return;
    }
    if (req.url === "/redirect-blocked") {
      res.writeHead(302, { location: "http://localhost:9999/private" });
      res.end();
      return;
    }
    if (req.url === "/slow") return;
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.write("first chunk");
      const interval = setInterval(() => res.write("next chunk"), 20);
      req.once("close", () => {
        clearInterval(interval);
        resolveUpstreamClose();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const { baseUrl, child } = await startProxy();
  const target = (path) => `http://127.0.0.1:${upstreamPort}${path}`;
  const throughProxy = (url) => `${baseUrl}/?url=${encodeURIComponent(url)}`;
  const keyHeaders = { "x-proxy-key": "test-key" };

  t.after(async () => {
    await stopProxy(child);
    await close(upstream);
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);

  const missingKey = await fetch(throughProxy(target("/ok")));
  assert.equal(missingKey.status, 403);

  const blockedHost = await fetch(throughProxy(`http://localhost:${upstreamPort}/ok`), {
    headers: keyHeaders,
  });
  assert.equal(blockedHost.status, 403);

  const allowed = await fetch(throughProxy(target("/ok")), {
    headers: {
      ...keyHeaders,
      authorization: "Bearer should-not-leave-the-proxy",
      cookie: "session=should-not-leave-the-proxy",
      "x-forwarded-for": "203.0.113.5",
      referer: "https://nxsha.space/",
    },
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "media bytes");
  assert.equal(allowed.headers.get("set-cookie"), null);
  assert.equal(allowed.headers.get("x-upstream"), "ok");
  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(receivedHeaders.cookie, undefined);
  assert.equal(receivedHeaders["x-proxy-key"], undefined);
  assert.equal(receivedHeaders["x-forwarded-for"], undefined);
  assert.equal(receivedHeaders.referer, "https://nxsha.space/");
  assert.match(receivedHeaders["accept-encoding"], /identity/);

  const allowedRedirect = await fetch(throughProxy(target("/redirect-allowed")), {
    headers: keyHeaders,
  });
  assert.equal(allowedRedirect.status, 200);
  assert.equal(await allowedRedirect.text(), "media bytes");

  const blockedRedirect = await fetch(throughProxy(target("/redirect-blocked")), {
    headers: keyHeaders,
  });
  assert.equal(blockedRedirect.status, 502);
  assert.equal((await blockedRedirect.json()).error, "proxy ERR_REDIRECT_HOST");

  const slow = await fetch(throughProxy(target("/slow")), { headers: keyHeaders });
  assert.equal(slow.status, 502);
  assert.equal((await slow.json()).error, "proxy timeout");

  const abortController = new AbortController();
  const stream = await fetch(throughProxy(target("/stream")), {
    headers: keyHeaders,
    signal: abortController.signal,
  });
  const reader = stream.body.getReader();
  await reader.read();
  abortController.abort();
  await settlesWithin(upstreamClosed, 1_000, "upstream stream remained open after client abort");
});
