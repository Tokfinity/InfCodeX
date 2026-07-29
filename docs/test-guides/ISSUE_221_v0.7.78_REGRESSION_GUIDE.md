# ISSUE 221 v0.7.78 回归指南

## 目标

验证 FEATURE_276 复核发现的首次初始化绕过、help 副作用、无效配置误报和并发覆盖
均已关闭，同时保持活跃 `config.json` 为严格 JSON。

## 自动化验证

```powershell
npm run build
npm run test:fast
npm run test:unit
npm run test:contract
npm run test:system

npx vitest run src/kodax_cli.setup-boundary.test.ts
npx vitest run packages/repl/src/common/agent-mode-migration.test.ts
npx vitest run packages/repl/src/common/integration-config.test.ts
```

预期所有命令成功。构建产物边界测试必须覆盖：

- `setup --help` 在含旧迁移/retention 状态的 home 中不改任何文件；
- 真实 `setup` 创建四个活跃文件和四个模板；
- 无效 MCP/A2A 配置得到诊断、退出码为 1、原字节不变且不创建其他文件；
- 回答一题后 EOF 正常取消，真实 `--custom` action 只保存公开 metadata。

## 手工抽查

1. 新建临时 `KODAX_HOME`，设置 `KODAX_PROVIDER` 和任一 Provider API-key
   环境变量，裸运行 KodaX；确认仍进入 setup。
2. 分别破坏 core、MCP、Extensions、A2A 活跃文件并运行 setup；确认每次都在
   写入前停止，且 Provider 向导不启动。
3. 使用自定义 `KODAX_HOME` 初始化后，检查 `config.example.jsonc` 第一行显示
   实际目录，且活跃 `config.json` 可由严格 `JSON.parse` 读取。
4. 同时打开两个自定义 Provider setup，或同时触发 SDK/REPL core 配置写入；
   确认一个持有共享 writer lock 时，另一个不会覆盖它，而是报告配置冲突。
5. 持有 `config.json.write.lock` 后启动含旧 permission/agent-mode 的 KodaX，
   确认运行期只做内存规范化，不越过锁改写文件；公共 legacy 迁移的 MCP/Extensions
   任一预检失败时，两份目标文件均不落盘。
6. 在 Provider 选择提示处关闭标准输入或按 Ctrl+C；确认及时取消且没有遗留
   `config.json.write.lock`。

## 通过标准

- 所有自动化测试通过。
- help 零写入；无效 active/legacy 配置零写入；KodaX 并发提交不覆盖。
- 环境变量不能冒充显式 CLI Provider 选择。
- 活跃 `config.json` 未增加注释，模板路径提示准确。
