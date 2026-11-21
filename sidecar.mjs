#!/usr/bin/env node
/**
 * Aura ↔ DSH 局域网配对桥（sidecar）。
 *
 * - mDNS 广播 _dsh._tcp，手机端可自动发现
 * - 配对：短码（code）或长期 token（token）二选一
 * - 反向代理：把带 token 的 HTTP/WS 请求转发到本机 DSH（默认 127.0.0.1:8187）
 *
 * 用法：
 *   node sidecar.mjs
 *   PORT=8765 SECURITY_MODE=code DSH_URL=http://127.0.0.1:8187 node sidecar.mjs
 */
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Bonjour } from "bonjour-service";

const PORT = Number(process.env.PORT ?? 8765);
const SECURITY_MODE = process.env.SECURITY_MODE === "token" ? "token" : "code";
const CODE_TTL = Number(process.env.CODE_TTL ?? 120);
const DSH_URL_RAW = process.env.DSH_URL ?? "auto";
const DSH_URL_AUTO = DSH_URL_RAW.toLowerCase() === "auto";
const DSH_URL = new URL(DSH_URL_AUTO ? "http://127.0.0.1:8187" : DSH_URL_RAW);
const SERVICE_NAME = process.env.SERVICE_NAME ?? "DSH Desktop";
const DSH_AUTH_URL = process.env.DSH_AUTH_URL ?? "";
const TOKEN_FILE = process.env.TOKEN_FILE ?? join(homedir(), ".aura-dsh-bridge", "token");
let DSH_HOST = DSH_URL.hostname;
let DSH_PORT = Number(DSH_URL.port || 80);

/** 探测本机 DSH：优先找加载了 aura-bridge 插件的端口（8187..8820）。 */
async function ensureDshPort() {
  if (!DSH_URL_AUTO) return;
  try {
    const res = await fetch("http://127.0.0.1:" + DSH_PORT + "/aura/health", { signal: AbortSignal.timeout(200) });
    if (res.ok) return;
  } catch {}
  await detectDshPort();
}

async function detectDshPort() {
  if (!DSH_URL_AUTO) return;
  for (let port = 8187; port <= 8820; port++) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/aura/health", { signal: AbortSignal.timeout(150) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.plugin === "aura-bridge") {
          DSH_PORT = port;
          console.log("[dsh] 自动发现插件端口 " + port);
          return;
        }
      }
    } catch {}
  }
  // 桌面端端口可能落在 8820 之外：从系统监听端口里探测
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    const ports = [...new Set([...out.matchAll(/(?:[\d.]+|\[::1?\]):(\d+)\s+\S+\s+LISTENING/gi)].map((m) => Number(m[1])))]
      .filter((port) => port >= 1024 && port !== PORT);
    console.log("[dsh] 候选监听端口 " + ports.length + " 个");
    const probe = async (port) => {
      try {
        const res = await fetch("http://127.0.0.1:" + port + "/aura/health", { signal: AbortSignal.timeout(150) });
        if (!res.ok) return 0;
        const body = await res.json().catch(() => ({}));
        return body.plugin === "aura-bridge" ? port : 0;
      } catch { return 0; }
    };
    const results = [];
    for (let i = 0; i < ports.length; i += 16) {
      const batch = ports.slice(i, i + 16);
      results.push(...await Promise.all(batch.map(probe)));
    }
    const found = results.find((port) => port > 0);
    if (found) {
      DSH_PORT = found;
      console.log("[dsh] 自动发现插件端口 " + found);
      return;
    }
  } catch (error) {
    console.log("[dsh] netstat 探测失败:", error instanceof Error ? error.message : error);
  }
  console.log("[dsh] 未发现 aura-bridge，使用默认 8187");
  DSH_PORT = 8187;
}

mkdirSync(dirname(TOKEN_FILE), { recursive: true });
let token = "";
try { token = readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
if (token.length < 32) {
  token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

let dshCookie = "";
let dshAuthFailures = 0;

/** 用 dsh web 打印的 ?token= URL 换 cookie；cookie 30 天有效，401 时会重试。 */
async function authenticate() {
  if (!DSH_AUTH_URL) return false;
  try {
    const res = await fetch(DSH_AUTH_URL, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) {
      console.error("[auth] 没有拿到 set-cookie，URL 可能已失效");
      return false;
    }
    dshCookie = setCookie.split(";")[0].trim();
    dshAuthFailures = 0;
    console.log("[auth] 已用 DSH_AUTH_URL 换取 cookie");
    return true;
  } catch (error) {
    console.error("[auth] 换取 cookie 失败:", error instanceof Error ? error.message : error);
    return false;
  }
}

let code = "";
let codeExpiresAt = 0;
function currentCode() {
  if (SECURITY_MODE !== "code") return "";
  if (!code || Date.now() > codeExpiresAt) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    codeExpiresAt = Date.now() + CODE_TTL * 1000;
    console.log("[pair] 新配对码:", code, "有效期", CODE_TTL, "秒");
  }
  return code;
}

function constantEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const headerToken = req.headers["x-aura-token"];
  const urlToken = new URL(req.url, "http://local").searchParams.get("token");
  const provided = headerToken || urlToken || "";
  return provided.length > 0 && constantEq(provided, token);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyHttp(req, res) {
  const headers = { ...req.headers };
  delete headers["host"];
  delete headers["x-aura-token"];
  if (dshCookie) headers.cookie = dshCookie;
  const upstream = createServerRequest(req.method, req.url, headers, res);
  upstream.on("response", () => {});
  req.pipe(upstream);
}

function createServerRequest(method, path, headers, res) {
  const upstream = require_http().request({
    host: DSH_HOST, port: DSH_PORT, method, path, headers,
  }, (up) => {
    if (up.statusCode === 401 && DSH_AUTH_URL && dshAuthFailures < 2) {
      dshAuthFailures += 1;
      authenticate().then((ok) => {
        if (!ok) { res.writeHead(401); res.end("dsh auth failed"); return; }
        const retryHeaders = { ...headers };
        if (dshCookie) retryHeaders.cookie = dshCookie;
        const retry = createServerRequest(method, path, retryHeaders, res);
        // 重放请求体不可行，这里只对无 body 的 GET 有效
        retry.end();
      });
      up.resume();
      return;
    }
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "dsh_unreachable" }); });
  return upstream;
}

// node:http request 的显式引入，避免顶层重复 import 名字冲突
import * as http from "node:http";
function require_http() { return http; }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;

  if (path === "/aura/pair/info") {
    return json(res, 200, { name: SERVICE_NAME, mode: SECURITY_MODE, port: PORT, path: "/aura/pair" });
  }
  if (path === "/aura/pair/status") {
    return json(res, 200, { mode: SECURITY_MODE, code: SECURITY_MODE === "code" ? currentCode() : undefined, expiresIn: Math.max(0, Math.floor((codeExpiresAt - Date.now()) / 1000)), port: PORT });
  }
  await ensureDshPort();
  if (path === "/aura/file") {
    if (!authorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
    const file = url.searchParams.get("path") ?? "";
    try {
      const { statSync, createReadStream } = await import("node:fs");
      const info = statSync(file);
      if (!info.isFile() || info.size > 15 * 1024 * 1024) { json(res, 400, { error: "bad_file" }); return; }
      const ext = file.toLowerCase().split(".").pop();
      const type = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": String(info.size) });
      createReadStream(file).pipe(res);
    } catch (error) {
      json(res, 404, { error: "not_found", detail: String(error) });
    }
    return;
  }
  if (path === "/aura/detail") {
    try {
      const upstream = await fetch("http://127.0.0.1:" + DSH_PORT + path + (url.search || ""), { signal: AbortSignal.timeout(3000) });
      const body = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    } catch (error) {
      json(res, 502, { error: "dsh_plugin_unreachable", detail: String(error) });
    }
    return;
  }
  await ensureDshPort();
  if (path === "/aura/send" || path === "/aura/upload") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch("http://127.0.0.1:" + DSH_PORT + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(30000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
    } catch (error) {
      json(res, 502, { error: "dsh_plugin_unreachable", detail: String(error) });
    }
    return;
  }
  await ensureDshPort();
  if (path === "/aura/sessions") {
    try {
      const upstream = await fetch("http://127.0.0.1:" + DSH_PORT + "/aura/sessions", { signal: AbortSignal.timeout(3000) });
      const body = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    } catch (error) {
      json(res, 502, { error: "dsh_plugin_unreachable", detail: String(error) });
    }
    return;
  }
  if (path === "/aura/pair/verify" && req.method === "POST") {
    const body = await readBody(req);
    let input = req.headers["x-aura-code"] ?? "";
    if (!input && body.length) {
      try { input = JSON.parse(body.toString("utf8")).code ?? ""; } catch {}
    }
    if (SECURITY_MODE === "code" && !constantEq(input, currentCode())) {
      return json(res, 401, { error: "code_invalid" });
    }
    return json(res, 200, { token, mode: SECURITY_MODE });
  }

  if (!authorized(req)) {
    return json(res, 401, { error: "unauthorized", pair: "/aura/pair" });
  }
  return proxyHttp(req, res);
});

// WebSocket / 任意 Upgrade 的透明 TCP 代理
server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const target = connect(DSH_PORT, DSH_HOST, () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== "x-aura-token" && key !== "cookie")
      .concat(dshCookie ? [["cookie", dshCookie]] : [])
      .map(([key, value]) => key + ": " + String(value))
      .join("\r\n");
    target.write(req.method + " " + req.url + " HTTP/1.1\r\n" + headers + "\r\n\r\n");
    if (head?.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.log("[bridge] 端口 " + PORT + " 已被占用，已有实例在运行，退出");
    process.exit(0);
  }
  console.error("[bridge] 启动失败:", error);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", async () => {
  await detectDshPort();
  if (DSH_AUTH_URL) await authenticate();
  const bonjour = new Bonjour();
  try { bonjour.publish({
    name: PORT === 8765 ? SERVICE_NAME : SERVICE_NAME + " (" + PORT + ")",
    type: "dsh",
    port: PORT,
    host: process.env.MDNS_HOST ?? "aura-dsh.local",
    txt: { mode: SECURITY_MODE, path: "/aura/pair", version: "1", dsh: String(DSH_PORT) },
  }); } catch (error) { console.error("[mdns] 发布失败（可能有同名实例）：", error instanceof Error ? error.message : error); }
  // UDP 广播兜底：部分 Windows/Android 组合的 mDNS 会被防火墙挡住
  const beacon = createSocket({ type: "udp4", reuseAddr: true });
  beacon.bind(() => beacon.setBroadcast(true));
  const payload = Buffer.from(JSON.stringify({ name: SERVICE_NAME, port: PORT, mode: SECURITY_MODE, version: 1, dsh: DSH_PORT }));
  const targets = (process.env.BEACON_TARGETS ?? "255.255.255.255,192.168.1.255").split(",").map((s) => s.trim()).filter(Boolean);
  setInterval(() => {
    for (const target of targets) {
      try { beacon.send(payload, 8766, target); } catch {}
    }
  }, 2000).unref();
  console.log("[bridge] UDP 广播 255.255.255.255:8766");
  if (DSH_URL_AUTO) setInterval(() => { ensureDshPort().catch(() => {}); }, 20000).unref();
  console.log("[bridge] 监听 0.0.0.0:" + PORT);
  console.log("[bridge] 转发到 " + DSH_URL.href);
  console.log("[bridge] 模式: " + SECURITY_MODE + (SECURITY_MODE === "code" ? "，配对码: " + currentCode() : ""));
  console.log("[bridge] token 文件: " + TOKEN_FILE);
  console.log("[bridge] DSH 鉴权: " + (DSH_AUTH_URL ? (dshCookie ? "已注入 cookie" : "未取得 cookie") : "未配置 DSH_AUTH_URL"));
});
