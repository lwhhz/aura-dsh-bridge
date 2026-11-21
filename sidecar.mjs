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
const DSH_URL = new URL(process.env.DSH_URL ?? "http://127.0.0.1:8187");
const SERVICE_NAME = process.env.SERVICE_NAME ?? "DSH Desktop";
const DSH_AUTH_URL = process.env.DSH_AUTH_URL ?? "";
const TOKEN_FILE = process.env.TOKEN_FILE ?? join(homedir(), ".aura-dsh-bridge", "token");
const DSH_HOST = DSH_URL.hostname;
const DSH_PORT = Number(DSH_URL.port || 80);

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

server.listen(PORT, "0.0.0.0", async () => {
  if (DSH_AUTH_URL) await authenticate();
  const bonjour = new Bonjour();
  try { bonjour.publish({
    name: PORT === 8765 ? SERVICE_NAME : SERVICE_NAME + " (" + PORT + ")",
    type: "dsh",
    port: PORT,
    host: process.env.MDNS_HOST ?? "aura-dsh.local",
    txt: { mode: SECURITY_MODE, path: "/aura/pair", version: "1" },
  }); } catch (error) { console.error("[mdns] 发布失败（可能有同名实例）：", error instanceof Error ? error.message : error); }
  // UDP 广播兜底：部分 Windows/Android 组合的 mDNS 会被防火墙挡住
  const beacon = createSocket({ type: "udp4", reuseAddr: true });
  beacon.bind(() => beacon.setBroadcast(true));
  const payload = Buffer.from(JSON.stringify({ name: SERVICE_NAME, port: PORT, mode: SECURITY_MODE, version: 1 }));
  const targets = (process.env.BEACON_TARGETS ?? "255.255.255.255,192.168.1.255").split(",").map((s) => s.trim()).filter(Boolean);
  setInterval(() => {
    for (const target of targets) {
      try { beacon.send(payload, 8766, target); } catch {}
    }
  }, 2000).unref();
  console.log("[bridge] UDP 广播 255.255.255.255:8766");
  console.log("[bridge] 监听 0.0.0.0:" + PORT);
  console.log("[bridge] 转发到 " + DSH_URL.href);
  console.log("[bridge] 模式: " + SECURITY_MODE + (SECURITY_MODE === "code" ? "，配对码: " + currentCode() : ""));
  console.log("[bridge] token 文件: " + TOKEN_FILE);
  console.log("[bridge] DSH 鉴权: " + (DSH_AUTH_URL ? (dshCookie ? "已注入 cookie" : "未取得 cookie") : "未配置 DSH_AUTH_URL"));
});
