# FEATURE_223 v0.7.50 — Sidecar Verifier Custom Provider Stall Fix 人测指引

## 功能概述

**功能名称**: Sidecar Verifier Custom Provider Stall Fix  
**版本**: v0.7.50  
**测试日期**: 2026-06-12  
**测试人员**: 待填写

验证 Worker text-only 完成后 Sidecar Verifier 不再长时间假死在 `PLANNED`，并确认自定义 OpenAI-compatible / DeepSeek V4 flash provider 路径具备真实 forced tool choice、可取消 timeout、可诊断日志，以及 DeepSeek V4 thinking replay 配置说明。

---

## 测试环境

### 前置条件

- 使用本分支构建后的 KodaX。
- 准备一个自定义 `protocol:"openai"` provider，优先使用客户真实 DeepSeek V4 flash endpoint。
- Shell 中设置对应 API key，例如 `MY_DEEPSEEK_API_KEY`。
- 开启 verifier 诊断：

```bash
export KODAX_VERIFIER_LOG=1
```

Windows PowerShell:

```powershell
$env:KODAX_VERIFIER_LOG="1"
```

### 推荐 custom provider 配置

```json
{
  "provider": "custom-deepseek-v4",
  "customProviders": [
    {
      "name": "custom-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "supportsThinking": true,
      "reasoningCapability": "native-toggle",
      "replayReasoningContent": true,
      "models": [
        { "id": "deepseek-v4-flash", "replayReasoningContent": true }
      ]
    }
  ],
  "verifierLog": true
}
```

---

## 测试用例

### TC-001: Verifying 状态不再显示为 PLANNED

**优先级**: 高  
**类型**: UI / 回归测试

**步骤**:
1. 启动 `kodax`。
2. 使用会触发 Worker text-only 结束的简单代码任务，例如让它检查一个小文件并给出结论。
3. 观察 Worker 最终回答后、sidecar verifier 运行期间的状态行。

**预期结果**:
- [ ] 状态行显示 `Verifying` 或 `[AMA Verifying] Verifying agent output`。
- [ ] verifier 期间不再停留在 `PLANNED - Worker`。
- [ ] 任务不需要用户中断即可进入后续完成/继续流程。

---

### TC-002: 自定义 DeepSeek V4 flash verifier 不再长期空转

**优先级**: 高  
**类型**: 正向 / 性能回归

**步骤**:
1. 使用推荐配置中的 `custom-deepseek-v4`。
2. 确认 `KODAX_VERIFIER_LOG=1` 已开启。
3. 运行一个会实际改文件的小任务，例如修改 README 中一行无害文本后让 KodaX 总结。
4. 查看 verifier 日志中的 provider/model、elapsedMs、trace。

**预期结果**:
- [ ] verifier 日志出现一次明确的 sidecar 记录。
- [ ] elapsedMs 通常明显低于旧的 15s timeout 上限。
- [ ] trace 优先为 `verifier_ok`；如果上游不支持 `tool_choice`，允许出现兼容 fallback 后的正常 verdict。
- [ ] 没有连续多轮 `timeout` / `provider_error` 导致后续请求明显限速。

---

### TC-003: `tool_choice` 不兼容端点可降级

**优先级**: 中  
**类型**: 兼容性 / 负向测试

**步骤**:
1. 准备一个会拒绝 `tool_choice` 参数的 OpenAI-compatible 测试网关，或临时代理返回类似 `unsupported parameter: tool_choice` 的错误。
2. 使用该 provider 作为主模型或 verifier provider。
3. 开启 `KODAX_VERIFIER_LOG=1` 后运行一个 Worker text-only 结束任务。

**预期结果**:
- [ ] KodaX 不崩溃。
- [ ] verifier 请求不会卡死；上游拒绝 forced `tool_choice` 后会重试兼容模式。
- [ ] 最坏结果是 fail-open accept，不阻塞主 Worker。

---

### TC-004: timeout / 用户中断不会留下 zombie verifier

**优先级**: 高  
**类型**: 负向 / 稳定性测试

**步骤**:
1. 使用较慢或可人为延迟的 OpenAI-compatible endpoint。
2. 触发一个 Worker text-only 完成后的 verifier。
3. 在 verifier 阶段按 Ctrl+C 中断。
4. 立即发起下一个简单请求。

**预期结果**:
- [ ] Ctrl+C 后底层 verifier stream 被取消。
- [ ] 下一轮请求不被上一轮 zombie stream 长时间占用速率额度。
- [ ] 不出现连续 429/503 retry-after 串联放大的卡顿。

---

### TC-005: DeepSeek V4 thinking replay 不再 400

**优先级**: 高  
**类型**: 配置 / 回归测试

**步骤**:
1. 确认 custom provider 设置了 `replayReasoningContent:true`。
2. 开启 reasoning/thinking 模式。
3. 连续进行两轮以上对话，或触发 verifier revise 后的 reanimate 重跑。
4. 观察上游错误与 KodaX 输出。

**预期结果**:
- [ ] 多轮 replay 不出现 DeepSeek V4 的 `reasoning_content must be passed back` 类 400。
- [ ] 如果移除 `replayReasoningContent:true` 后复测，允许复现该错误，以证明配置项是 load-bearing。

---

### TC-006: 独立 verifier provider 仍可作为缓解路径

**优先级**: 中  
**类型**: 配置 / 兼容性测试

**步骤**:
1. 设置主 provider 为自定义 DeepSeek。
2. 设置 verifier 到一个独立快模型：

```bash
export KODAX_VERIFIER_PROVIDER=anthropic
export KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001
export KODAX_VERIFIER_LOG=1
```

3. 运行一个 Worker text-only 结束任务。

**预期结果**:
- [ ] verifier 日志显示使用 env 指定的 provider/model。
- [ ] 主 Worker 仍使用自定义 DeepSeek。
- [ ] `Verifying` 状态和 verdict 日志正常。

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---|---|---|---|
| 6 | - | - | - |

**测试结论**: 待填写  
**发现的问题**: 如有问题，请记录 provider 名称、model、baseUrl 类型、`KODAX_VERIFIER_LOG=1` 下的 elapsedMs/trace，以及是否设置 `replayReasoningContent`。

