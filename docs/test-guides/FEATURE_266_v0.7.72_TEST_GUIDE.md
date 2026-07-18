# FEATURE_266 Learning Center 与 Learned Capability Runtime — 人工测试指南

## 功能概览

**功能名称**：Learning Center + Learned Capability Runtime Control Plane

**目标版本**：v0.7.72

**Feature ID**：FEATURE_266

**测试日期**：待填写

**测试人员**：待填写

> 发布候选说明（2026-07-18）：以下人工用例用于保留发布证据，不构成人工签字门槛；剩余发布动作仅为包版本与 Git tag 定版。

本功能把 learned capability 的生命周期、通知、查询和治理统一到
Runtime-owned Learning Center，并保持 inline、Worker、daemon 与 REPL 表面一致。
Learned Skill 的优先级低于正式 Skill；F266 不执行 learned Extension 代码，也不
引入新的生成循环。

## 测试环境

- Node.js 20 或更高版本。
- 使用临时 `KODAX_HOME`，避免把人工测试数据写入真实用户目录。
- 已执行 `npm run build`。
- 分别准备 inline Runtime、Worker Runtime 和 daemon Runtime 测试入口。

## 测试用例

### TC-001：Learning Center 查询与人类可读标识

1. 导入两个不同 owner、名称相近的 proposal/capability。
2. 执行 `/learn`，按名称和 slug 搜索并打开详情。
3. 尝试用含路径分隔符或冲突 slug 的名称创建记录。

预期：

- [ ] 正常操作使用名称/slug，不要求用户输入内部 opaque ID。
- [ ] 歧义结果明确列出 owner/provenance，不能静默选错。
- [ ] 非法名称和冲突 slug 被确定性拒绝，无半写入记录。

### TC-002：生命周期与通知状态分离

1. 对同一记录依次执行 acknowledge、snooze、reject、disable、rollback、archive
   和 restore 中允许的转换。
2. 在每个关键步骤重启 Runtime 并重新查询。
3. 使用两个不同 client identity 读取/确认同一通知。

预期：

- [ ] 非法生命周期转换返回明确错误，原状态不变。
- [ ] acknowledge/snooze 只改变通知游标，不改变 capability 生命周期。
- [ ] 两个 client 的未读游标相互独立，重连后可恢复。

### TC-003：learned Skill 优先级与 promotion/rollback

1. 创建一个与正式 Skill 同名的 learned Skill，并保持 learned 状态 active。
2. 查询 Skill registry，再执行显式 promotion。
3. 制造 promotion 名称冲突，然后验证 snapshot 与 rollback。

预期：

- [ ] 正式 Skill 始终优先，learned Skill 不覆盖正式目录。
- [ ] 冲突 promotion 在写入前失败，不破坏任一版本。
- [ ] promotion 成功后 ownership 转移明确；rollback 恢复精确 snapshot。

### TC-004：Inline、Worker 与 daemon 一致性

1. 在三种 Runtime 形式中执行相同的 list/detail/acknowledge/action 脚本。
2. 在 Worker 形式中提交一次通知变更后立即 hard dispose。
3. daemon client 断线后以相同 identity 重连。

预期：

- [ ] 三种 Runtime 返回 transport-safe 等价 DTO 与事件顺序。
- [ ] hard dispose 前持久化完成，重启后通知状态未丢失。
- [ ] 只有 Runtime owner 执行写入/job；client 不能绕过 owner fence。

### TC-005：REPL、Ink 与 headless 展示

1. 分别制造 info、warning、error 三种待处理学习通知。
2. 检查 Ink 底部状态段、`/learn`、`/status` 和 headless 启动摘要。
3. 缩窄终端宽度并生成长 final text。

预期：

- [ ] Ink 只增加紧凑且非零的 Learning segment，不恢复旧 Classic 状态栏。
- [ ] 严重级别、未读数量、详情与 durable state 一致。
- [ ] 窄终端行预算正确，final text 不被状态段遮挡。
- [ ] headless/Classic 获得等价文本信息，不依赖 Ink。

### TC-006：订阅竞态、断连清理与 transient principal

1. 在 subscriber 完成第一次 durable event 读取、但尚未挂 waiter 时，由另一个
   client 写入一条 Learning event。
2. 在空游标上发起 `subscribe().next()`，随后在没有新 event 的情况下调用
   iterator `return()`，模拟 daemon client 断连。
3. 依次使用大量不同 transient daemon principal 查询 Learning Center，再用相同
   stable client identity 重连并检查 acknowledge 状态。

预期：

- [ ] 第 1 步的 event 通过 read-register-recheck 被立即返回，不等下一条 event 才唤醒。
- [ ] `return()` 立即完成，pending waiter 被移除；下一条 event 不会投递给已断连订阅。
- [ ] Runtime 不按 transient principal 永久保留 facade；stable identity 的 durable
  notification cursor 仍能跨重连恢复。

## 自动化基线（2026-07-18）

- `npm run build`：通过。
- F266 聚焦组：8 个测试文件，148/148 通过。
- F266/F270 changed-code 综合覆盖：2294/2780 statements，82.52%。
- F266 全部属于 Layer 1 确定性验证，provider 调用数为 0，成本 `$0`。
- 新增 lost-wakeup、iterator cancellation 与 facade-retention 确定性回归：
  Learning service 18/18、Runtime Learning 5/5 通过。
- 2026-07-18 follow-up 覆盖组中 Actor/Learning/prompt 为 90.62% lines、
  80.86% branches；daemon/Runtime Learning 为 89.34% lines、80.23% branches。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 6 | - | - | - |

**测试结论**：待填写

**发现的问题**：待填写

**证据位置**：待填写
