# Issue 105 v0.7.74 回归测试指南

> 目标：验证 `kodax -c` 与所有 auto-resume 入口不会被空的 ACP/bootstrap Session 遮挡，并在交互恢复后继续使用已保存的 workspace/runtime。

## 环境

- 使用隔离的 `KODAX_HOME` 和一个临时 Git 仓库。
- 同时准备主工作区和一个 worktree；在 worktree 子目录创建至少一轮真实会话。
- 在真实会话之后创建 10 个以上 `msgCount=0` 的 ACP/bootstrap 占位 Session。
- 记录真实 Session ID、标题、tag、worktree 根目录和执行子目录。

## Case 1：Ink `kodax -c`

1. 从主工作区或同一 canonical repo 的另一个目录运行 `kodax -c`。
2. 确认程序选择真实的非空 Session，而不是任一空占位记录。
3. 询问上一轮唯一事实，确认历史已进入模型上下文。
4. 执行一个只读的相对路径 shell 命令，确认 cwd 是已保存的 worktree 子目录。

验收：

- [ ] 选择最新非空 Session，且能越过默认十条摘要窗口。
- [ ] 恢复消息、UI history、title、tag 和 Session ID。
- [ ] 相对路径按已保存的 execution cwd 解析。

## Case 2：Classic REPL

1. 使用项目现有的 classic/readline 启动开关进入传统 REPL。
2. 重复 `-c` 恢复与历史事实检查。
3. 执行相对路径 `!` shell 命令。

验收：

- [ ] Classic 与 Ink 选择同一真实 Session。
- [ ] Classic 恢复 lineage、artifact/extension 状态与 workspace runtime。
- [ ] shell 命令不会落回启动目录。

## Case 3：显式 ID 优先

1. 指定一个较旧但非空的 Session ID，并同时设置 resume/autoResume。
2. 启动 Ink、Classic 或 SDK/direct run。

验收：

- [ ] 始终加载显式 ID，不重新选择“最近”会话。

## Case 4：没有非空会话

1. 使用只包含零消息占位记录的新项目。
2. 运行 `kodax -c`。

验收：

- [ ] 不把空 ACP Session 当作可恢复对话。
- [ ] 正常进入新 Session/fallback 流程，无崩溃、无伪历史。

## 记录

- Tester：
- Date：
- Commit：
- Result：PASS / FAIL
- Notes：
