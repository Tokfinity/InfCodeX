# FEATURE_251 v0.7.61 人工测试指导

## 功能概述

**功能名称**：Tool-Output 语义压缩（rtk-style Token Killer）
**版本**：v0.7.61
**测试日期**：2026-07-05
**测试人员**：待填写

本测试指导用于验证 bash tool 输出会在 tool 层内完成语义压缩，同时保持 `Command:` / `Exit:` 头部保真、raw 输出可恢复、现有 guardrail 行为不回退。

## 测试环境

- Node.js 20+
- 已安装仓库依赖
- 默认从仓库根目录执行命令，特别注明的除外
- 不需要发布 npm 包或打 release tag

## 自动化基线

1. 在 `packages/coding` 下运行：
   `npx vitest run src/tools/output-filters/detect.test.ts src/tools/output-filters/declarative.test.ts src/tools/output-filters/generic.test.ts src/tools/output-filters/never-worse.test.ts src/tools/output-filters/registry.test.ts src/tools/output-filters/context-savings.test.ts src/tools/output-filters/compiled/git-diff.test.ts src/tools/output-filters/compiled/git-status.test.ts src/tools/output-filters/compiled/git-log.test.ts src/tools/output-filters/compiled/test-runner.test.ts src/tools/output-filters/compiled/lint.test.ts src/tools/output-filters/compiled/json-output.test.ts src/tools/bash.test.ts`
2. 在 `packages/agent` 下运行：
   `npx vitest run src/session-lineage/compaction/result-extractors.test.ts`
3. 在 `packages/coding` 下运行：
   `npx vitest run src/tools/tool-result-truncation-guardrail.test.ts src/tools/tool-result-policy.test.ts`
4. 在仓库根目录运行：
   `npm run build -w @kodax-ai/coding`

**预期结果**：上述测试和 build 全部通过。

## 手动测试用例

### TC-001：ANSI 输出保持可读

**优先级**：高
**类型**：正向测试

**测试步骤**：
1. 通过 bash tool 运行一个同时打印彩色 stdout 和 stderr 的命令。
2. 检查返回的 tool output。

**预期效果**：
- [ ] `Command:` 和 `Exit:` 各出现一次，且位置与原 bash 输出契约一致。
- [ ] ANSI escape sequence 被移除。
- [ ] stdout 和 stderr 的正文仍然可读。

### TC-002：大型 `git diff` 被摘要，并保留 raw 恢复路径

**优先级**：高
**类型**：正向测试 / 恢复测试

**测试步骤**：
1. 准备一个包含多文件变更的大型 diff。
2. 通过 bash tool 运行 `git diff`。
3. 检查返回输出和 raw-output hint 路径。
4. 打开 hint 指向的 raw-output 文件。

**预期效果**：
- [ ] 输出包含 `[git diff summarized: ...]` 摘要行。
- [ ] 每个文件的 additions/deletions 统计可见。
- [ ] 输出包含 raw recovery hint。
- [ ] raw-output 文件包含原始 decoded diff body。

### TC-003：`git status` 和 `git log` 摘要保留决策信息

**优先级**：中
**类型**：正向测试

**测试步骤**：
1. 在有多个 changed/untracked 文件的仓库中运行 `git status --porcelain=v1`。
2. 运行一个较长的 `git log --oneline`。

**预期效果**：
- [ ] status 输出按状态码分组，并保留代表路径。
- [ ] log 输出保留最新记录，并显示总行数/展示行数。
- [ ] 小输出在 `never_worse` 判断压缩会变大时可以保持 raw。

### TC-004：测试和 lint 输出聚焦失败与诊断

**优先级**：高
**类型**：正向测试

**测试步骤**：
1. 运行一个包含大量通过记录和一个失败的测试命令。
2. 运行一个包含大量进度噪声和少量诊断的 lint/typecheck 命令。

**预期效果**：
- [ ] 失败行、关键 stack snippet、最终 summary 保留。
- [ ] 通过记录和进度噪声被移除或大幅减少。
- [ ] lint/typecheck 的诊断行和问题汇总保留。
- [ ] 有损压缩时包含 raw recovery hint。

### TC-005：包管理器、Docker、infra CLI 进度流被压缩

**优先级**：中
**类型**：兼容性测试

**测试步骤**：
1. 运行一个进度输出较重的包管理器命令，例如 `pnpm install`。
2. 运行一个会在 stderr 输出 BuildKit 进度的 `docker build` 命令。
3. 运行一个会输出重复创建/上传进度的 infra CLI 命令，例如 `terraform apply` 或 AWS S3 上传。

**预期效果**：
- [ ] 重复 progress 行被剥离或限制在上限内。
- [ ] 最终 summary 保留。
- [ ] stderr-aware 规则不会丢掉 stdout 中的重要摘要。
- [ ] BuildKit 常见的 `DONE 0.xs` 行被识别为进度噪声。

### TC-006：大型 JSON / NDJSON 输出变成结构摘要

**优先级**：中
**类型**：数据处理测试

**测试步骤**：
1. 运行输出大型 JSON 的命令，例如 `aws ... --output json`、`kubectl ... -o json`、`jq` 或 `curl`。
2. 运行输出 NDJSON 的命令，例如分页的 `gh api`。
3. 检查返回输出。

**预期效果**：
- [ ] 输出显示 JSON 或 NDJSON 的结构摘要。
- [ ] 数组长度、对象 key 数量、代表 key 可见。
- [ ] 有损压缩时包含 raw recovery hint。

### TC-007：guardrail 与异常路径保持原行为

**优先级**：高
**类型**：回归测试

**测试步骤**：
1. 运行一个刻意制造超长输出的命令，触发现有尾部截断。
2. 运行一个 timeout 命令。
3. 运行一个 background 命令。
4. 运行 ledger extractor 自动化测试。

**预期效果**：
- [ ] 现有 bash tail truncation 仍然工作。
- [ ] timeout 和 background 路径不进入完成态语义压缩。
- [ ] `extractBashResult` 仍能从完成态 bash 输出中恢复 exit code 和 tail。

## Context 消耗验证

自动化测试 `packages/coding/src/tools/output-filters/context-savings.test.ts` 覆盖 10 个固定样例：

| 场景 | 预期验证点 |
|---|---|
| 120 文件的 `git diff` | 整体摘要显著减少 token，并保留 raw 恢复 |
| Vitest 大量通过 + 单个失败 | 保留失败与 summary，去掉通过噪声 |
| `pnpm install` 进度流 | 去掉重复 progress |
| `git status` 210 个路径 | 按状态分组并限制代表路径数量 |
| `git log` 160 行历史 | 保留最新记录并报告摘要 |
| lint/typecheck 噪声 + 诊断 | 保留诊断和问题汇总 |
| `docker build` stderr 进度 | 识别 BuildKit 进度噪声 |
| `terraform apply` / S3 上传进度 | 去掉重复创建/上传进度 |
| 大型 AWS 风格 JSON 数组 | 输出结构摘要 |
| GitHub API NDJSON 事件流 | 输出 NDJSON 结构摘要 |

**预期效果**：
- [ ] 每个样例的压缩后 token 数小于 raw token 数。
- [ ] 每个样例达到测试中登记的最低节省比例。
- [ ] `lossiness` 与测试登记值一致。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 7 | 待填写 | 待填写 | 待填写 |

**测试结论**：待填写
**功能 ID**：251
