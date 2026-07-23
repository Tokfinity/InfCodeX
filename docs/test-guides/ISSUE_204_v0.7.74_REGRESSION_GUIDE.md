# Issue 204 v0.7.74 回归测试指南

> 目标：验证权限模式切换没有裸 `Auto` 暂态或异步乱序，并区分合法的 `Auto[RULES]` 粘性状态。

## 环境

- 使用隔离的 `KODAX_HOME` 和可用的 Auto LLM classifier 配置。
- 分别在 embedded Runtime 与 shared daemon 路径测试。
- 如终端支持按键诊断，先确认默认 Shift-Tab 被识别为权限模式切换；Shift+Enter 应识别为换行。

## Case 1：普通三档循环

1. 从 Edits 按一次 Shift-Tab 进入 Auto。
2. 观察切换后的第一帧和稳定帧。
3. 再按 Shift-Tab 完成 `Auto -> Plan -> Edits -> Auto`。

验收：

- [ ] 进入 Auto 的第一帧即为 `Auto[LLM]` 或已配置的 `Auto[RULES]`。
- [ ] 不出现裸 `Auto` 第四状态。
- [ ] 三档顺序稳定，最终模式与最后一次按键一致。

## Case 2：快速切换

1. 在 Runtime/daemon 响应较慢时快速按 Shift-Tab 六次。
2. 等待所有设置同步完成，再执行 `/mode` 和 `/auto-engine`。

验收：

- [ ] UI 不回跳到较早模式。
- [ ] Runtime 持久化模式等于最后一次按键选择。
- [ ] 重启 REPL 后模式与 engine 一致。

## Case 3：Rules 粘性与显式恢复

1. 在 Auto 中执行 `/auto-engine rules`。
2. 离开 Auto，再循环回 Auto。
3. 执行 `/auto-engine llm`。

验收：

- [ ] 回到 Auto 后仍显示 `Auto[RULES]`，不会被模式循环偷偷重置。
- [ ] `/auto-engine llm` 后立即显示 `Auto[LLM]` 并持久化。

## Case 4：Shift+Enter

1. 在输入框键入两段文字，中间按 Shift+Enter。
2. 确认输入框包含换行，且权限模式未变化。

验收：

- [ ] Shift+Enter 只插入换行。
- [ ] Shift-Tab 才切换权限模式（除非用户自行修改终端映射）。

## 记录

- Tester：
- Date：
- Commit：
- Runtime mode：embedded / daemon
- Result：PASS / FAIL
- Notes：
