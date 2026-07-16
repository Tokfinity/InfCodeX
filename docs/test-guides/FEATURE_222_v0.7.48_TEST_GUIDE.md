# FEATURE_222 v0.7.48 — MCP 2025-11-25 Reverse Capabilities 人测指引

> **目的**：验证 server→client 反向能力 + 生态兼容在真实/半真实 MCP server 下可用：
> (1) `type:"http"` 配置 auto-detect（Streamable HTTP 优先，旧 SSE fallback）；
> (2) catalog 对 `prompts/list`/`resources/list` `-32601` 容错；
> (3) roots 暴露 workspace；
> (4) elicitation（form/url）反钓鱼展示（哪个 server 在问 + 发送前 review + url 不自动打开）；
> (5) OAuth 401 触发零配置发现登录（浏览器同意，不自动打开，127.0.0.1 回调）。
>
> **前置**：
> - KodaX v0.7.48 已构建（`npm run build`）。
> - 自动化测试是主要证据：`npm test -w @kodax-ai/agent -- src/capabilities/mcp`（130+ 例，每 slice 有 fake-MCP-server）。本指引是真实 server 的补充 smoke。
> - 部分用例需要一个对应能力的 MCP server（HTTP/SSE、会 elicit、OAuth 保护）；没有就跳过该项，以自动化测试为准。

---

## Test 1 — `type:"http"` 配置 auto-detect（最重要，最易测）

### 步骤

1. 在 `~/.kodax/config.json` 的 `mcpServers` 加一个 **HTTP MCP server**，`type` 写 `"http"`（不是 `streamable-http`/`sse`）：
   ```json
   { "mcpServers": { "demo": { "type": "http", "url": "<你的 HTTP MCP server URL>", "connect": "lazy" } } }
   ```
2. 启动 KodaX，触发该 server 连接（首次用到其工具，或 `connect: "prewarm"`）。
3. 通过 SDK 或诊断查看 resolved transport：
   ```bash
   node --eval "import('@kodax-ai/agent').then(async m => { /* 构造 manager 后 */ })"
   ```
   或在能显示 MCP 诊断的地方查看 `resolvedTransport` 字段。

### 期望结果

- 现代 Streamable HTTP server → `resolvedTransport` = `http:auto->streamable-http`，能 ready、能发现工具。
- 仅旧 HTTP+SSE 的 server（POST initialize 回 405/404）→ 自动 fallback，`resolvedTransport` = `http:auto->sse`，仍能 ready、能发现工具。
- **认证场景不 fallback**：若 server 对 POST initialize 回 401/403，**不会**退到 SSE，而是进入 OAuth 流程（见 Test 5）或明确报认证错误。

> 已实测参考：「小智数据问答」HTTP server → `http:auto->sse`，发现 1 个 tool，`mcp_search` 能搜到，`tools/call` 正常发出（业务返回的用户态错误属于服务端，不属 KodaX 链路）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| `Unknown transport type "http"` | 配置层未识别 alias — 确认 `npm run build` 后跑的是 0.7.48 |
| 旧 SSE server 连不上、不 fallback | 检查 server POST initialize 返回码是否 400/404/405（仅这三个 fallback）|
| 401 被错误地 fallback 到 SSE | 不应发生；401/403/5xx/网络错误不 fallback |

---

## Test 2 — catalog 对 optional list `-32601` 容错

### 步骤

1. 连一个**只实现 tools、不实现 prompts（或 resources）**的 MCP server（很多业务 server 如此，`prompts/list` 回 `-32601`）。
2. 让 KodaX 刷新该 server 的 catalog 并尝试调用其工具。

### 期望结果

- catalog 刷新**成功**，工具可见、可 `tools/call`（不再因为 `prompts/list -32601` 让整个 server 不可用）。
- 若 `tools/list` 本身 `-32601`（server 无任何工具）→ 该 server 仍会失败（无 tools = 无核心能力，符合设计）。

---

## Test 3 — roots（server 读 workspace 根）

### 步骤

1. 连一个会发 `roots/list` 的 MCP server（或用自动化测试 `runtime.test.ts` 的 Slice A 用例作为证据）。
2. 在 KodaX 的项目目录下启动。

### 期望结果

- server 收到的 roots 是当前 workspace 的 `file://` URI（cwd，必要时含 git root / 额外目录），去重、cwd 在前。
- ACP/编辑器场景为 roots-only（无交互对话框）。

---

## Test 4 — elicitation（form / url）反钓鱼

### 步骤（需要一个会 elicit 的 server）

1. **form**：让 server 发 `elicitation/create{ mode:"form" }` 索要若干字段。
2. **url**：让 server 发 `elicitation/create{ mode:"url" }` 要求浏览器授权。

### 期望结果

- **form**：每个字段提示都显示「**哪个 MCP server 在请求**」（如 `MCP server "demo" is requesting information.`）；收集完所有字段后出现 **review-before-send** 确认（列出将发送的值 + Send/Cancel），选 Cancel 则不发送。
- **url**：提示显示完整 URL + 域名 + 「Only continue if you trust this domain. KodaX will NOT open it automatically」；KodaX **绝不自动打开浏览器**，也不把 URL 内容暴露给模型；选 accept 仅表示"我自己去打开"。
- headless/print 模式或 ACP（无 url 交互面）→ 自动 decline，不挂起。

---

## Test 5 — OAuth 零配置发现登录（401）

### 步骤（需要一个 OAuth 保护的 MCP server）

1. 连一个受 OAuth 保护的 HTTP MCP server（`config.auth` 可不填端点，留空走自动发现）。
2. 首次连接触发 401。

### 期望结果

- KodaX 自动发现授权服务器（RFC 9728 → RFC 8414/OIDC），动态注册 client（RFC 7591），通过 **url-elicitation 同意门**展示授权 URL（**不自动打开浏览器**）。
- 你在浏览器完成授权后重定向到 `http://127.0.0.1:<port>/callback`（**不是** `localhost`），KodaX 完成 token 交换并重试连接成功。
- token 过期/`403 insufficient_scope` 会自动续期/step-up 重新登录。
- 若 AS 不支持 PKCE `S256` → 明确报错拒绝降级（不会用不安全的 `plain`）。
- headless（无 url 同意面）→ 不登录，原样上抛认证错误。

### 失败排查

| 现象 | 诊断 |
|---|---|
| 浏览器被自动打开 | 不应发生（反钓鱼）；KodaX 只展示 URL |
| 重定向落 `localhost` 收不到 | 应是 `127.0.0.1`；检查 redirect URI |
| 授权后一直挂起 | 回调监听应在展示 URL **之前**就起；检查端口占用 |

---

## 回归基线说明

- 全量 `npm test` 偶发若干 timeout/Windows temp-lock 失败（worktree / session-storage / repo-intelligence / selection / recovery），单独跑均通过 —— 属环境/负载 flaky，非本 feature 回归。
- MCP 套件（`npm test -w @kodax-ai/agent -- src/capabilities/mcp`，130+ 例）+ `npm run build` 应全绿。
