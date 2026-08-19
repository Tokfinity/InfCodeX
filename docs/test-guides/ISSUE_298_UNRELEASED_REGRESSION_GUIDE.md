# Issue 298 Provider Abort Classification - 人工回归测试指导

## 功能概述

**功能名称**: Provider 请求期间 Stop 保留 Runtime interruption 终态
**版本**: Unreleased source after v0.7.92
**测试日期**: 2026-08-19
**测试人员**: 待填写

**功能描述**: 运行使用 run-scoped credential 的 Provider 请求时，用户 Stop
必须终止为 `interrupted`，不能被脱敏成普通凭据失败。

---

## 测试环境

### 前置条件

- 构建包含 Issue 298 修复的 KodaX，并让 KodaX Space 使用该构建。
- 配置一个可正常响应的 Anthropic 或 OpenAI Provider 凭据。
- 打开 KodaX Space 的运行上下文，以便核对 Run 终态和事件。

### 浏览器/环境要求

- 桌面环境: Windows 10/11，KodaX Space v0.1.43 或后续兼容版本。
- 网络: 正常网络；性能用例可重复执行。

---

## 测试用例

### TC-001: Provider 请求进行中 Stop

**优先级**: 高
**类型**: 正向测试

**前置条件**:

- Provider 凭据有效，Session 当前无活动 Run。

**测试步骤**:

1. 发送任意普通文本。
2. 约 2 秒内、模型仍在运行时点击 Stop。
3. 等待 Run 进入终态并打开运行上下文。

**预期效果**:

- [ ] UI 显示 `Runtime run interrupted`，不显示 run-scoped credential 失败。
- [ ] Run phase、terminal event 和 Stop outcome 均为 interrupted。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-002: 未 Stop 的真实 Provider 失败

**优先级**: 高
**类型**: 负向测试

**前置条件**:

- 使用可触发 Provider 请求失败的隔离测试配置，且不要点击 Stop。

**测试步骤**:

1. 发送任意文本并等待 Provider 失败。
2. 检查 UI、Run 状态和终态事件。

**预期效果**:

- [ ] Run 保持 failed，不被误报为 interrupted。
- [ ] 错误继续遵守凭据脱敏规则，不泄露敏感值。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-003: Provider admission 前立即 Stop

**优先级**: 中
**类型**: 边界测试

**前置条件**:

- Session 当前无活动 Run。

**测试步骤**:

1. 发送空白以外的最短文本。
2. 立即点击 Stop，不等待 Provider 首包。
3. 检查最终提示和 Run 状态。

**预期效果**:

- [ ] 运行以 cancelled 或 interrupted 的权威终态结束。
- [ ] 不出现 run-scoped credential Provider failure。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-004: 中断提示的 UI 呈现

**优先级**: 高
**类型**: UI测试

**前置条件**:

- 已完成 TC-001。

**测试步骤**:

1. 查看被中断用户消息对应的终态提示。
2. 切换到其他 Session 后再返回。

**预期效果**:

- [ ] `Runtime run interrupted` 归属正确的用户消息，文案完整可读。
- [ ] 重开 Session 后提示不变，不转换成凭据错误。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-005: 连续 Stop 收敛时间

**优先级**: 中
**类型**: 性能测试

**前置条件**:

- Provider 可稳定建立流式请求。

**测试步骤**:

1. 重复五次“发送文本，约 2 秒内点击 Stop”。
2. 记录每次从点击 Stop 到 Runtime 终态的时间。

**预期效果**:

- [ ] 每次均直接收敛到 cancellation/interruption，不进入 Provider 重试退避。
- [ ] 没有 Run 长时间停留在 failed 前的未知状态。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-006: 凭据脱敏保持不变

**优先级**: 高
**类型**: 安全测试

**前置条件**:

- 使用只包含于测试环境的唯一凭据标记。

**测试步骤**:

1. 执行 TC-001。
2. 搜索 Run status、event journal、Session 数据和 UI 文本中的唯一标记。

**预期效果**:

- [ ] 任何持久化文件和 UI 均不包含凭据标记。
- [ ] 修复只保留取消语义，没有放宽 Provider 错误脱敏。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

### TC-007: Anthropic 与 OpenAI SDK 兼容性

**优先级**: 中
**类型**: 兼容性测试

**前置条件**:

- 分别准备可用的 Anthropic 与 OpenAI 测试 Provider。

**测试步骤**:

1. 使用 Anthropic Provider 执行 TC-001。
2. 使用 OpenAI Provider 执行 TC-001。
3. 比较两次 Runtime 终态和 UI 文案。

**预期效果**:

- [ ] 两个 SDK 的 Stop 都收敛为 cancellation/interruption。
- [ ] 两个 SDK 均不显示 run-scoped credential Provider failure。

**实际结果**: 待填写
**是否通过**: [ ] Pass / [ ] Fail

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 7 | - | - | - |

**测试结论**: 待填写
**发现的问题**: 如有问题请记录 Run ID、Provider、Stop 时间和终态事件。

---

*测试指导生成时间: 2026-08-19*
*Issue ID: 298*
