# Constructed Handler Worker Fault Isolation - 人工测试指导

## 功能概述

**功能名称**: Constructed Handler Worker Fault Isolation
**版本**: `v0.7.72`
**Feature ID**: `257`

验证 generated constructed handler 不再在宿主 V8 isolate 中执行，CPU
死循环可以硬终止，同时工具能力、plan mode 与撤销语义保持不变。

## 测试环境

- 已执行 `npm run build`。
- `dist/constructed-handler-worker.js` 存在。
- 使用临时 workspace 和测试 constructed artifact。

## 测试用例

### TC-001: 非主线程执行

1. 激活返回 `String(isMainThread)` 的 JavaScript handler。
2. 调用该 constructed tool。

预期：

- [ ] 返回 `false`。
- [ ] REPL/SDK 宿主仍可响应其他操作。

### TC-002: CPU 死循环硬终止与恢复

**优先级**: 高

1. handler 在 `input.spin === true` 时执行 `while (true) {}`，timeout 设为
   50-500 ms。
2. 以 `spin: true` 调用。
3. 超时后以 `spin: false` 再次调用同一版本。

预期：

- [ ] 首次调用在 timeout 后失败，错误说明 Worker 已终止。
- [ ] KodaX UI/进程未冻结。
- [ ] 第二次调用自动重建 Worker 并成功。

### TC-003: Reverse tool RPC 与能力拒绝

1. 声明 `read` 能力并从 handler 调用 `ctx.tools.read`。
2. 未声明 `bash`，再尝试调用 `ctx.tools.bash`。

预期：

- [ ] `read` 走宿主 `executeTool()` 并返回正常结果。
- [ ] `bash` 以 `CapabilityDeniedError` 失败。
- [ ] 未发生直接宿主函数传递或静默降级。

### TC-004: 撤销与发布包

1. 激活并调用 handler。
2. revoke 对应 name/version。
3. 再次通过 registry 调用。
4. 检查 npm pack 文件列表。

预期：

- [ ] revoke 后 registry 不再暴露该工具。
- [ ] 对应 Worker 被销毁或不再保持进程存活。
- [ ] 包含 `dist/constructed-handler-worker.js`。

## 安全边界

- [ ] 文档/UI 不把 Worker 称为安全 sandbox。
- [ ] 仍执行静态规则、LLM review、激活审批和工具能力检查。
- [ ] 直接 import 文件/网络模块的恶意代码不在本 feature 的安全承诺内。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 4 | - | - | - |

**测试结论**: [待填写]
