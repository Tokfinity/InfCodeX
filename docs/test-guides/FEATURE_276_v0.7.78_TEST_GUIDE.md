# FEATURE_276 v0.7.78 人工测试指南

## 目标

验证首次 setup、全部分离配置初始化、共享帮助、自定义 Provider 向导和文档路径。
所有场景使用临时 `KODAX_HOME`，不得指向真实 `~/.kodax`。

## 准备

```powershell
$env:KODAX_HOME = Join-Path $env:TEMP 'kodax-f276-manual'
npm run build
```

确认该路径不是现有配置目录后再开始。测试完成可关闭终端，让临时环境变量失效。

## 场景 1：help 无写入

1. 确认临时 `KODAX_HOME` 不存在。
2. 运行 `node dist/kodax_bootstrap.js setup --help`。
3. 检查输出包含：
   - 全部内置 API Provider 与环境变量名；
   - core、MCP、Extensions、A2A 活跃文件和模板路径；
   - `kodax -r`、`kodax -c`；
   - `/model`、`/mode`、`/effort`、`/agent-mode`；
   - Ctrl+T、Shift+Tab、Alt+M；
   - `kodax setup --custom` 与重启 terminal/doctor 指导。
4. 确认 `$env:KODAX_HOME` 仍不存在。

## 场景 2：首次初始化八个文件

1. 运行 `node dist/kodax_bootstrap.js setup`。
2. 在 Provider 选择处取消。
3. 确认以下文件存在：
   - `config.json`
   - `config.example.jsonc`
   - `integrations/mcp.json`
   - `integrations/mcp.example.jsonc`
   - `integrations/extensions.json`
   - `integrations/extensions.example.jsonc`
   - `integrations/a2a.json`
   - `integrations/a2a.example.jsonc`
4. 确认三个活跃 integration 文件分别为 MCP v1、Extensions v1、A2A v2 的安全空文档。
5. 确认 `config.json` 是严格 JSON，且 `config.example.jsonc` 第一行同时点名
   `mcp.json`、`extensions.json`、`a2a.json`。

## 场景 3：已有文件不被覆盖

1. 在 `config.json` 增加一个可识别的合法 JSON 字段，在任一模板增加测试注释。
2. 再次运行 setup 并取消。
3. 确认输出将这些文件标为 `existing`，且测试字节仍原样存在。

## 场景 4：旧 MCP/Extensions 保全

1. 使用新的临时 `KODAX_HOME`，只创建 `config.json`：

```json
{
  "mcpServers": {
    "local": { "type": "stdio", "command": "node", "args": ["server.js"] }
  },
  "extensions": ["C:/extensions/example.mjs"]
}
```

2. 运行 setup 并取消。
3. 确认新 `mcp.json` 和 `extensions.json` 含旧条目，而不是空文档。
4. 确认旧 core 字段没有被自动清理。

## 场景 5：自定义 Provider

1. 运行 `node dist/kodax_bootstrap.js setup --custom`。
2. 确认不会先出现 built-in/custom route 选择。
3. 检查每一步都解释：
   - Provider local alias；
   - OpenAI/Anthropic protocol 的判断来源；
   - 从 Provider API 文档获取 Base URL；
   - 只输入环境变量名、不输入 API key 值；
   - 从 Provider 文档获取 model id。
4. 完成并确认写入。
5. 检查 `config.json` 只包含公开 metadata 和环境变量名，不包含凭据值。

## 场景 6：首次裸启动 gate

1. 使用新的临时 `KODAX_HOME`。
2. 设置任一受支持环境变量，例如 `$env:OPENAI_API_KEY = 'manual-test-only'`。
3. 裸运行 `node dist/kodax_bootstrap.js`。
4. 确认仍先进入 setup，而不是直接进入 REPL。
5. 取消后检查八个文件已初始化。

## 场景 7：REPL help

1. 使用已配置、可进入 REPL 的临时环境。
2. 执行 `/setup --help`。
3. 确认内容与 `kodax setup --help` 的 setup guide 相同。
4. 确认 help 本身没有修改配置文件。

## 场景 8：help 在启动副作用之前返回

1. 使用新的临时 `KODAX_HOME`，写入一个合法但包含旧 `agentMode` 和过期
   session-retention 状态的 `config.json`。
2. 记录该目录内所有文件的字节内容和修改时间。
3. 运行 `node dist/kodax_bootstrap.js setup --help`。
4. 确认退出码为 0、帮助完整，且没有迁移配置、清理 session、创建锁或更改任何字节。

## 场景 9：无效活跃配置阻断写入

分别使用四个新的临时 `KODAX_HOME`，令以下某一个活跃文件无效：

- `config.json`：无效 JSON 或非对象；
- `integrations/mcp.json`：不符合 MCP 文档契约；
- `integrations/extensions.json`：不符合 Extensions 文档契约；
- `integrations/a2a.json`：未知顶层字段或错误版本/结构。

每次运行 `node dist/kodax_bootstrap.js setup`，确认：

1. 输出将对应文件标记为 `invalid` 并给出诊断；
2. 退出码非 0，Provider 向导没有启动；
3. 无效文件字节不变，其他缺失配置或模板也没有被创建；
4. 修正文件后再次运行，才会继续初始化。

## 场景 10：环境变量不能绕过首次初始化

1. 使用新的临时 `KODAX_HOME`。
2. 同时设置 `$env:KODAX_PROVIDER = 'openai'` 和一个受支持的 API-key 环境变量。
3. 裸运行 `node dist/kodax_bootstrap.js`。
4. 确认仍进入 setup；仅显式 CLI `--provider` 才可按原契约跳过交互 gate。

## 场景 11：并发与终端取消

1. 同时启动两个 `kodax setup --custom`，让它们基于同一个初始
   `config.json` revision 完成输入；确认只有一个写入成功，另一个明确报告冲突。
   同时触发其他 KodaX core-config writer（REPL 设置、SDK config patch 或
   Custom Provider CRUD），以及启动期 permission/agent-mode 自愈与 legacy cleanup，
   也必须得到相同的互斥保护。
2. 让 legacy MCP 合法、Extensions 非法并执行公共迁移命令；确认两份目标文件均未创建。
   在迁移期间并发创建目标文件；确认 setup 不覆盖并发写入的字节。
3. 在 Provider 选择处发送 EOF（关闭标准输入）或按 Ctrl+C；确认向导及时取消、
   不挂起、不写入 Provider metadata，且不遗留 `config.json.write.lock`。

## 自动化边界验证

```powershell
npm run build
npx vitest run src/kodax_cli.setup-boundary.test.ts
```

该测试已属于常规 `test:system`/CI，从真实构建产物验证无副作用 help、八文件
初始化、权威 A2A 校验、无效配置阻断、中途 EOF、`--custom` 透传和退出码。

## 通过标准

- 十一个场景全部通过。
- 任何既有配置或模板都没有被覆盖。
- API key 值没有进入提示回显或配置文件。
- 活跃 `config.json` 保持严格 JSON。
- 自定义 `KODAX_HOME` 中安装的模板第一行显示该实际目录，不残留
  `~/.kodax` 占位路径。
