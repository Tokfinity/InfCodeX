# FEATURE_270 统一 Actor/Turn 控制面 — 人工测试指南

## 功能概览

**功能名称**：Ultra-Aligned Adaptive Multi-Agent Actor Control Plane

**目标版本**：v0.7.72

**Feature ID**：FEATURE_270

**测试日期**：待填写

**测试人员**：待填写

本功能用一个 Runtime-owned Actor/Turn 树替代旧 child-task、Workflow-local
scheduler 和并行外部任务投影。AMA 保留主动协作能力；Workflow 只在显式请求时
使用，并把所有 child Agent 纳入同一容量、事件、输出和恢复模型。

## 测试环境

- Node.js 20 或更高版本。
- 使用临时 `KODAX_HOME` 和临时 session 存储。
- 已执行 `npm run build`。
- 准备 inline、Worker、daemon Runtime，以及一个支持 follow-up/interrupt 的外部
  Agent fixture。

## 测试用例

### TC-001：递归 Actor 树与直接父级完成

1. root 使用 `spawn_agent` 创建 child，child 再创建 grandchild。
2. grandchild 完成后分别从 child 与 root 调用 `list_agents`/`agent_output`。
3. 让 parent Turn 在 descendant 尚存活时完成。

预期：

- [ ] 路径稳定为 direct-parent tree，名称/路径碰撞和 traversal 被拒绝。
- [ ] grandchild completion 只投递给 direct parent 一次。
- [ ] root 看到有界结果与 unresolved descendant，不收到重复原始噪声。
- [ ] descendant 后续完成写入 parent mailbox，不隐式唤醒或 re-parent。

### TC-002：Actor identity 与 Turn 生命周期

1. 完成、失败和 interrupt 同一 Actor 的不同 Turn。
2. 对 idle Actor 调用 `send_message`，确认不启动 Turn。
3. 对 idle 与 running Actor 分别调用 `followup_task`。

预期：

- [ ] terminal Turn 不删除 Actor identity，历史可复用。
- [ ] idle `send_message` 只入 mailbox；idle follow-up 原子启动新 Turn。
- [ ] running follow-up 在安全边界加入当前 Turn，不消耗第二槽位。
- [ ] interrupt 后 Actor 可再次 follow-up，identity/path 不变。

### TC-003：全局容量、预算与权限单调性

1. 在默认配置下同时保持三个 non-root Turn active。
2. 尝试启动第四个 Turn，随后结束一个既有 Turn 并重试。
3. 以 `N=1`、`N=8` 和非法值启动新 session。
4. 让 descendant 尝试扩大权限或绕过 root work budget。

预期：

- [ ] 第四个启动返回结构化 `AgentLimitReached`，无隐藏队列或残留 Actor/name。
- [ ] 槽位释放后可干净重试；root 始终可响应。
- [ ] `N=1` 为 root-only；`N=8` 合法并警告；非法值被拒绝。
- [ ] descendant 权限只能保持或收窄，预算耗尽返回明确错误且无半提交。

### TC-004：Workflow 与外部 Agent 共用控制面

1. 显式运行 named Workflow，并观察 declared pending steps 与 admitted Turns。
2. 在容量饱和时继续推进 Workflow。
3. 运行外部 Agent Turn，执行 follow-up 与 interrupt 能力检查。

预期：

- [ ] Workflow owner 不占 Agent 槽；leaf step 占统一 non-root 槽。
- [ ] pending protocol step 不伪装成 scheduler-accepted overflow。
- [ ] async Workflow terminal event 保留 result/artifact/coverage/error 结构。
- [ ] 外部 backend 能力不足时明确拒绝，不产生孤儿 Turn 或私有生命周期投影。

### TC-005：升级、恢复与 canonical surface

1. 使用历史 persisted `amaw` 与 `ama-workflow` 配置启动一次。
2. 尝试从 CLI/SDK 输入新的 retired mode 或旧工具名。
3. daemon 运行中断线、重连并重启，检查 actor snapshot/event replay。

预期：

- [ ] 历史值只迁移一次到 AMA 并产生一次通知；新输入直接失败并给出迁移提示。
- [ ] model-visible schema 只包含 7 个 canonical collaboration tools。
- [ ] snapshot 在提交完成前不可见；重启后 Actor identity/Turn history 恢复一致。
- [ ] 无第二 actor/task journal，旧 settled Workflow/F258 历史不被重新物化为 live Turn。

### TC-006：AMA 与显式 Workflow 策略

1. 给 AMA 一个简单单步任务。
2. 给出三个独立审查维度并要求合并结果。
3. 对同一复杂任务分别明确请求 named Workflow 与移除全部 Workflow 语言。

预期：

- [ ] 简单任务保持 solo。
- [ ] 并行任务可自适应使用 Agent，但不会超过三个 active non-root Turn。
- [ ] 明确请求时使用 named Workflow；仅复杂但未请求时不调用 `run_workflow`。
- [ ] prompt 包含 canonical Ultra sentence，且没有静态波次或复杂度触发指令。

## 自动化与评测基线（2026-07-17）

- `npm run build`：通过。
- 本次变更集合：55 个测试文件，999/999 通过。
- F266/F270 扩展 Layer 1：61 个测试文件，1097/1097 通过。
- changed-code coverage：2294/2780 statements，82.52%。
- F270 eval harness + shared one-shot boundary：65/65 通过；新
  dataset/runner statement coverage 为 97.00%，严格 TypeScript 校验通过。
- manifest-only eval：2/2 通过，三个付费 stage 默认跳过；raw root 位于 OS
  临时目录 `kodax-eval-dumps/feature-270/<revision>/`。
- 全量分片中 Actor/Workflow 测试通过；剩余失败/挂起均定位到紧急发版遗留的
  未提交 CLI/auto-mode/schema/KNOWN_ISSUES 改动，不属于 F270 提交。
- 付费 Layer 2/3 尚未运行：冻结预算上限为 `$18`，必须获得 owner 明确授权；
  driver 还要求调用方同时提供 `allowGeneration=true`、
  `KODAX_F270_ALLOW_GENERATION=1` 和可归因的 `KODAX_F270_AUTHORIZATION`。

零成本 manifest 检查：

```powershell
npx vitest run -c vitest.eval.config.ts tests/feature-270.eval.ts
```

获得 owner 授权后，先只运行四调用 pilot；主会话盲审通过后，才按顺序选择
`layer2` 和 `layer3`。不要一次性预设三个付费 stage，也不要添加自动重试。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 6 | - | - | - |

**测试结论**：待填写

**发现的问题**：待填写

**证据位置**：待填写（自动化日志、actor snapshot/event、迁移前后配置、评测 raw dump）
