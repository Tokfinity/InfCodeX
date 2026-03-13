# FEATURE_020: AGENTS.md - 项目级 AI 上下文规则 - 测试指导

## 功能概述

**功能名称**: AGENTS.md - 项目级 AI 上下文规则
**版本**: v0.6.0
**测试日期**: 2026-03-13
**测试人员**: [待填写]

**功能描述**:
实现项目级别的 AI 上下文规则注入机制，允许在项目中创建 AGENTS.md 文件来定义项目特定的 AI 行为规则。支持多层级优先级系统和渐进式加载。

**核心特性**:
- ✅ 支持全局、项目、目录三个层级的规则文件
- ✅ 优先级: global < root < ... < current directory < .kodax/
- ✅ 兼容 pi-mono 的 CLAUDE.md 命名
- ✅ 自动发现并加载所有祖先目录的规则文件
- ✅ 智能注入到系统提示词，不影响现有功能

---

## 测试环境

### 前置条件
- Node.js >= 20.0.0
- TypeScript >= 5.3.0
- KodaX v0.6.0+ (当前开发版本)
- 操作系统: Windows / macOS / Linux

### 测试账号
- 无需特殊账号（本地功能测试）

### 浏览器/环境要求
- 终端环境
- 支持 UTF-8 编码

---

## 测试用例

### TC-001: 验证基本功能 - 单个 AGENTS.md 文件

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 当前目录干净（无 AGENTS.md 或 CLAUDE.md）
- 有写入权限

**测试步骤**:
1. 在测试项目根目录创建 `AGENTS.md` 文件：
   ```markdown
   # Test Project Rules

   This is a test rule for KodaX.
   ```

2. 启动 KodaX REPL：
   ```bash
   npm run dev
   ```

3. 在 KodaX 中执行简单的查询：
   ```
   你好，请告诉我你看到了哪些项目规则？
   ```

**预期效果**:
- [ ] KodaX 正常启动，无错误
- [ ] AI 响应中提及 "Test Project Rules"
- [ ] AI 响应中提及 "This is a test rule for KodaX"
- [ ] 系统提示词中包含该规则内容

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-002: 验证优先级 - AGENTS.md 优先于 CLAUDE.md

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 当前目录存在 CLAUDE.md
- 有写入权限

**测试步骤**:
1. 在同一目录创建两个文件：
   ```bash
   # AGENTS.md
   echo "# AGENTS Rules" > AGENTS.md

   # CLAUDE.md
   echo "# CLAUDE Rules" > CLAUDE.md
   ```

2. 启动 KodaX 并询问规则内容

**预期效果**:
- [ ] AI 只看到 "AGENTS Rules"
- [ ] AI 不提及 "CLAUDE Rules"
- [ ] 验证 AGENTS.md 具有更高优先级

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-003: 验证项目级规则 - .kodax/AGENTS.md

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 测试项目根目录
- 有写入权限

**测试步骤**:
1. 创建项目级规则文件：
   ```bash
   mkdir -p .kodax
   echo "# Project-Level Rules" > .kodax/AGENTS.md
   ```

2. 在根目录创建目录级规则：
   ```bash
   echo "# Directory-Level Rules" > AGENTS.md
   ```

3. 启动 KodaX 并询问规则

**预期效果**:
- [ ] AI 同时看到 "Project-Level Rules" 和 "Directory-Level Rules"
- [ ] 项目级规则被标记为 "Project Rules"
- [ ] 目录级规则被标记为 "Directory Rules"
- [ ] 项目级规则优先级更高（在系统提示词中出现更靠后）

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-004: 验证全局规则 - ~/.kodax/AGENTS.md

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 用户主目录可写
- 全局配置目录不存在或可创建

**测试步骤**:
1. 创建全局规则文件：
   ```bash
   mkdir -p ~/.kodax
   echo "# Global Rules for All Projects" > ~/.kodax/AGENTS.md
   ```

2. 在任意项目启动 KodaX 并询问规则

**预期效果**:
- [ ] AI 看到 "Global Rules for All Projects"
- [ ] 全局规则被标记为 "Global Rules"
- [ ] 全局规则在所有项目中都生效

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-005: 验证多层级继承 - 父子目录规则

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 可创建多级目录结构
- 有写入权限

**测试步骤**:
1. 创建目录结构：
   ```bash
   mkdir -p parent/child
   cd parent
   echo "# Parent Rules" > AGENTS.md
   cd child
   echo "# Child Rules" > AGENTS.md
   ```

2. 在 child 目录启动 KodaX 并询问规则

**预期效果**:
- [ ] AI 同时看到 "Parent Rules" 和 "Child Rules"
- [ ] 父目录规则被标记为 "Directory Rules (from .../parent/AGENTS.md)"
- [ ] 子目录规则被标记为 "Directory Rules (from .../parent/child/AGENTS.md)"
- [ ] 规则按层级顺序加载（父目录在前，子目录在后）

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-006: 验证完整优先级顺序

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 可创建完整的多层级结构
- 有写入权限

**测试步骤**:
1. 创建完整的层级结构：
   ```bash
   # 全局规则
   echo "# Global" > ~/.kodax/AGENTS.md

   # 父目录规则
   mkdir -p parent/child
   cd parent
   echo "# Parent" > AGENTS.md

   # 项目级规则
   mkdir .kodax
   echo "# Project" > .kodax/AGENTS.md

   # 子目录规则
   cd child
   echo "# Child" > AGENTS.md
   ```

2. 在 child 目录启动 KodaX 并询问所有规则

**预期效果**:
- [ ] AI 看到 4 个规则: Global, Parent, Project, Child
- [ ] 规则按正确顺序加载: Global → Parent → Project → Child
- [ ] 每个规则有正确的 scope 标签
- [ ] 系统提示词中所有规则都存在

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-007: 验证无 AGENTS.md 文件的情况

**优先级**: 中
**类型**: 边界测试

**前置条件**:
- 干净的测试目录（无任何 AGENTS.md 或 CLAUDE.md）
- 删除或移走全局规则文件

**测试步骤**:
1. 清理所有规则文件：
   ```bash
   rm -f AGENTS.md CLAUDE.md
   rm -f ~/.kodax/AGENTS.md
   ```

2. 启动 KodaX 并进行正常对话

**预期效果**:
- [ ] KodaX 正常启动，无错误
- [ ] AI 正常响应，不提及任何项目规则
- [ ] 系统提示词中不包含 Project Context 部分
- [ ] 不影响 KodaX 的其他功能

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-008: 验证文件读取错误处理

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 可创建无权限读取的文件
- Unix-like 系统（支持 chmod）

**测试步骤**:
1. 创建一个无法读取的 AGENTS.md：
   ```bash
   echo "# Test Rules" > AGENTS.md
   chmod 000 AGENTS.md
   ```

2. 启动 KodaX 并观察控制台输出

**预期效果**:
- [ ] KodaX 启动时显示警告: "Warning: Could not read .../AGENTS.md"
- [ ] KodaX 不会崩溃，继续运行
- [ ] AI 正常响应（不包含该规则）
- [ ] 错误被优雅地处理

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

**清理**:
```bash
chmod 644 AGENTS.md
rm AGENTS.md
```

---

### TC-009: 验证重复文件去重

**优先级**: 中
**类型**: 边界测试

**前置条件**:
- 测试项目根目录
- 有写入权限

**测试步骤**:
1. 创建可能导致重复的场景：
   ```bash
   # .kodax 指向当前目录（模拟重复）
   ln -s . .kodax
   echo "# Rules" > AGENTS.md
   ```

2. 启动 KodaX 并检查规则加载

**预期效果**:
- [ ] 规则只加载一次，不重复
- [ ] AI 只看到一份 "Rules"
- [ ] 系统不会因为重复而崩溃

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

**清理**:
```bash
rm .kodax AGENTS.md
```

---

### TC-010: 验证 Unicode 和特殊字符

**优先级**: 中
**类型**: 边界测试

**前置条件**:
- 有写入权限
- 终端支持 UTF-8

**测试步骤**:
1. 创建包含特殊字符的规则文件：
   ```bash
   cat > AGENTS.md << 'EOF'
   # 中文规则测试

   这是一个包含中文的规则：你好世界！

   Emoji 测试: 🎉 🚀 💻

   特殊符号: @#$%^&*()_+-={}[]|\:;"'<>?,./

   多行文本:
   - 列表项 1
   - 列表项 2

   代码块:
   \`\`\`typescript
   const test = "code";
   \`\`\`
   EOF
   ```

2. 启动 KodaX 并询问规则内容

**预期效果**:
- [ ] 所有中文字符正确显示
- [ ] Emoji 正确显示
- [ ] 特殊符号正确处理
- [ ] 代码块格式保持完整
- [ ] 多行列表正确渲染

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-011: 验证大文件处理

**优先级**: 低
**类型**: 性能测试

**前置条件**:
- 有写入权限
- 足够的磁盘空间

**测试步骤**:
1. 创建大型规则文件（1000+ 行）：
   ```bash
   cat > AGENTS.md << 'EOF'
   # Large File Test

   $(for i in {1..1000}; do echo "Rule $i: This is rule number $i"; done)
   EOF
   ```

2. 启动 KodaX 并观察加载时间和内存

**预期效果**:
- [ ] KodaX 在合理时间内启动（< 2 秒）
- [ ] 不出现内存溢出错误
- [ ] AI 可以访问所有规则
- [ ] 系统正常运行

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-012: 验证空文件处理

**优先级**: 中
**类型**: 边界测试

**前置条件**:
- 有写入权限

**测试步骤**:
1. 创建空的 AGENTS.md：
   ```bash
   touch AGENTS.md
   ```

2. 启动 KodaX 并检查规则加载

**预期效果**:
- [ ] KodaX 正常启动，无错误
- [ ] 空文件被优雅处理（加载但不影响）
- [ ] 系统提示词中包含空的 Project Context 部分或不包含该部分

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-013: 验证系统提示词格式

**优先级**: 高
**类型**: UI 测试

**前置条件**:
- 有写入权限
- 可访问系统日志或调试信息

**测试步骤**:
1. 创建规则文件：
   ```bash
   cat > AGENTS.md << 'EOF'
   # Test Format

   This is a formatting test.
   EOF
   ```

2. 启动 KodaX 并查看系统提示词格式

**预期效果**:
- [ ] 规则被正确格式化为 Markdown
- [ ] 包含正确的 scope 标签: "Directory Rules (from .../AGENTS.md)"
- [ ] 使用 `---` 分隔符分隔多个规则
- [ ] 整个 Project Context 部分被清晰标记

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-014: 验证与现有功能的兼容性

**优先级**: 高
**类型**: 兼容性测试

**前置条件**:
- KodaX v0.6.0 所有功能正常
- 有写入权限

**测试步骤**:
1. 创建规则文件：
   ```bash
   echo "# Compatibility Test" > AGENTS.md
   ```

2. 测试所有核心功能：
   - 文件读取 (/read)
   - 文件编辑 (/edit)
   - Shell 命令 (/bash)
   - 文件搜索 (/glob, /grep)
   - 帮助命令 (/help)

**预期效果**:
- [ ] 所有核心功能正常工作
- [ ] 规则文件不影响现有功能
- [ ] 不出现冲突或性能问题
- [ ] AI 在执行任务时遵循 AGENTS.md 规则

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-015: 验证动态更新 - 会话中修改规则

**优先级**: 中
**类型**: 交互测试

**前置条件**:
- KodaX 正在运行
- 有写入权限

**测试步骤**:
1. 启动 KodaX（无规则文件）
2. 进行一次对话
3. 在运行时创建/修改 AGENTS.md：
   ```bash
   echo "# New Rule Added" > AGENTS.md
   ```
4. 重启 KodaX 或开始新会话
5. 询问新规则

**预期效果**:
- [ ] 新会话加载新规则
- [ ] 旧会话不受影响（规则在启动时加载）
- [ ] 规则更新不需要重启（新会话即可）
- [ ] AI 在新会话中看到 "New Rule Added"

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

### TC-016: 验证跨平台路径处理

**优先级**: 中
**类型**: 兼容性测试

**前置条件**:
- 在不同操作系统测试（Windows/macOS/Linux）
- 有写入权限

**测试步骤**:
1. 在不同平台创建规则文件：
   - Windows: `C:\Users\{user}\.kodax\AGENTS.md`
   - macOS: `/Users/{user}/.kodax/AGENTS.md`
   - Linux: `/home/{user}/.kodax/AGENTS.md`

2. 启动 KodaX 并检查路径解析

**预期效果**:
- [ ] Windows 路径正确解析（反斜杠）
- [ ] Unix 路径正确解析（正斜杠）
- [ ] 路径显示在规则标签中
- [ ] 跨平台行为一致

**实际结果**:
[待填写]

**状态**: [ ] 通过 [ ] 失败

---

## 测试焦点总结

### API Endpoints (N/A - 本地功能)
| Category | Test Focus |
|----------|------------|
| 功能验证 | 多层级规则加载、优先级顺序、文件发现 |
| 错误处理 | 文件读取失败、空文件、大文件、重复文件 |
| 兼容性 | 与现有功能集成、跨平台路径处理 |
| 格式 | Markdown 渲染、Unicode 支持、特殊字符 |
| 性能 | 大文件加载、启动时间 |

### User Interface (N/A - 无 UI 界面)
| Category | Test Focus |
|----------|------------|
| 系统提示词 | 规则格式化、scope 标签、分隔符 |
| 错误提示 | 文件读取警告、优雅降级 |
| 兼容性 | 不影响现有 REPL 界面 |

### CLI Tools (N/A - 无新 CLI 命令)
| Category | Test Focus |
|----------|------------|
| 集成 | 现有命令不受影响 |

### Data Processing
| Category | Test Focus |
|----------|------------|
| 文件发现 | 遍历目录树、去重、优先级排序 |
| 内容加载 | UTF-8 编码、特殊字符、大文件 |
| 格式化 | Markdown 渲染、scope 标签、系统提示词注入 |

### Authentication & Authorization (N/A - 无认证需求)
| Category | Test Focus |
|----------|------------|

---

## 测试后清理

```bash
# 清理测试文件
rm -f AGENTS.md CLAUDE.md
rm -rf .kodax
rm -f ~/.kodax/AGENTS.md

# 清理测试目录
rm -rf parent/child
```

---

## 已知限制

1. **文件监听**: 当前实现不在运行时监听规则文件变化，需要重启或新会话才能看到更新
2. **文件大小**: 超大文件（> 1MB）可能影响启动性能
3. **并发访问**: 多个 KodaX 实例同时运行时共享规则文件，无冲突

---

## 测试完成标准

- [ ] 所有关键测试用例通过 (TC-001 至 TC-006)
- [ ] 至少 80% 的测试用例通过
- [ ] 无阻塞性问题
- [ ] 兼容性测试全部通过
- [ ] 性能测试可接受（启动时间 < 2 秒）

---

## 问题报告

如果在测试中发现问题，请按以下格式记录：

```markdown
### 问题 [ID]

**测试用例**: TC-XXX
**严重程度**: 高/中/低
**重现步骤**:
1. ...
2. ...

**预期结果**: ...
**实际结果**: ...
**错误信息**: [如有]
```

---

## 测试人员签字

**测试人员**: [姓名]
**测试日期**: [日期]
**测试环境**: [操作系统 + Node.js 版本]
**总体评价**: [ ] 通过 [ ] 需修复 [ ] 阻塞性问题

**备注**:
[其他观察或建议]
