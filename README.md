# aura-dsh-bridge

Aura 手机端 ↔ DSH 桌面端的**局域网配对桥**（sidecar）。让手机在局域网内发现 DSH、输入配对码、拿到长期 token，然后通过桥访问 DSH。

MIT License。与 DeepSeek 官方无隶属关系。

## 现状

| 能力 | 状态 |
|---|---|
| mDNS 广播 `_dsh._tcp` | ✅ |
| UDP 广播兜底（8766） | ✅ |
| 6 位配对码 → 长期 token | ✅ |
| token 模式（无码直连） | ✅ 代码支持 |
| 反向代理到 DSH 本机 Web | ⚠️ 受 DSH 自身鉴权限制，见下 |
| 会话列表 / 发指令 / 文件上传 | ⏳ 待 DSH 鉴权打通 |

## 重要发现：DSH Web 自带鉴权

DSH 的 Web 服务不是匿名可访问的：直接请求 `http://127.0.0.1:8187/` 会返回

```
401 dsh web authentication required; reopen the URL printed by dsh web.
```

鉴权是 **cookie + 签名 secret**，cookie 由 `dsh web` 打印的 URL 首次访问时种下。
因此桥不能只做透明反向代理，必须：

1. 用户把 `dsh web` 打印的带 token URL 交给桥；
2. 桥用该 URL 向 DSH 换取 cookie，并在代理请求中带上；
3. 或者改用 DSH 插件形态（进程内），天然以 owner Peer 身份访问。

在打通前，桥只负责发现与配对（已可用）。

## DSH_AUTH_URL（关键）

DSH Web 需要先带 `?token=` 访问一次拿 cookie。启动 sidecar 时把 `dsh web` 打印的 URL 传进来：

```bash
DSH_URL=http://127.0.0.1:8187 \
DSH_AUTH_URL="http://127.0.0.1:8187/?token=<printed-token>" \
node sidecar.mjs
```

sidecar 启动时会 GET 该 URL，取 `set-cookie` 并在所有代理请求/升级中注入 Cookie；401 时自动重试一次。
已验证：注入后通过 sidecar 访问 DSH 返回 200 HTML。

## DSH 插件（进程内，推荐）

把 `plugin/` 复制到 DSH profile，再用 patch 插入：

```bash
cp -r plugin "$USERPROFILE/.dsh/profiles/desktop/plugins/aura-bridge"
```

`cordis.patch.yml` 追加：

```yaml
- insert:
    - id: aura-bridge
      name: './plugins/aura-bridge/index.mjs'
```

重启 DSH 后：

```
GET /aura/sessions              # live 会话
GET /aura/detail?id=...         # 消息 + 工具调用 + 推理
GET /aura/detail?id=...&debug=types  # 事件类型统计
```

## 运行

```bash
cd dsh-plugin
npm install
PORT=8765 SECURITY_MODE=code DSH_URL=http://127.0.0.1:8187 node sidecar.mjs
```

启动后终端会打印 6 位配对码；手机 Aura → 首页 DSH FAB → 配对新电脑 → 自动发现「DSH Desktop」→ 输入配对码 → 已配对。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8765 | 桥端口 |
| `SECURITY_MODE` | code | code / token |
| `CODE_TTL` | 120 | 配对码有效期（秒） |
| `DSH_URL` | http://127.0.0.1:8187 | 本机 DSH 地址 |
| `SERVICE_NAME` | DSH Desktop | mDNS/广播显示名 |
| `TOKEN_FILE` | ~/.aura-dsh-bridge/token | 长期 token 落盘 |
| `MDNS_HOST` | aura-dsh.local | mDNS 主机名（ASCII，避免中文主机名解析失败） |
| `BEACON_TARGETS` | 255.255.255.255,192.168.1.255 | UDP 广播目标 |

## 手机端

Aura App（`lwhhz/aura`）v1.2.7：

- 首页第二个 FAB → DSH 实时对话
- 配对页：mDNS + UDP 双通道发现、手动 IP/端口/配对码
- 配对成功显示「已配对 + token 已保存」

## 接口

```
GET  /aura/pair/info                 -> { name, mode, port, path }
GET  /aura/pair/status               -> { mode, code, expiresIn, port }
POST /aura/pair/verify  x-aura-code  -> { token }
*    /*                  x-aura-token -> 反向代理到 DSH（需 DSH 鉴权打通）
WS   upgrade             x-aura-token -> TCP 透明代理到 DSH
```

## 路线图

1. 接收 `DSH_AUTH_URL`，换取并刷新 cookie，打通代理；
2. 会话列表 / 实时输出 / 发指令；
3. 手机 → PC 文件上传（落点与限额）；
4. PC → 手机下载；
5. 迁移为 DSH 插件形态（进程内，免 cookie）。

## 许可

MIT。见 LICENSE。
