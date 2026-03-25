# FEATURE_034 v0.7.0 测试指导

## 这份文档是测什么的

`FEATURE_034` 做的是 KodaX 的 `Extension + Capability Runtime`。  
这次最重要的新能力有两类：

- extension 可以加载、热重载，并参与 agent 主循环
- extension 的 `session state` 和 `session records` 现在可以随会话一起保存，并在 `resume` 后恢复

所以这份测试指导分成两部分：

1. 快速人工验证：从 `kodax` / REPL 视角确认功能真的可用
2. 深入验证：直接调用 `runKodaX()`，确认“持久化 + 恢复”这条底层链路没问题

如果你只是想在提交前做一轮高价值人工测试，优先做前两条用例就够了。

---

## 为什么文档里不只是运行 `kodax`

你刚才困惑的点是对的。

原因是：

- `034` 的定位不是“只给 REPL 用的插件功能”
- 它本质上是一个 `headless programmable runtime`
- 所以最核心的能力，应该能在 **不经过 REPL** 的情况下直接被代码调用

也就是说：

- `kodax` / REPL 测的是“宿主接线对不对”
- `runKodaX()` 测的是“runtime 本体对不对”

因此文档里会同时出现：

- `npm run dev -- --extension ...`
- `node --import tsx/esm ...manual-runner.mts`

这不是写错了，而是分别在测两层东西。

如果你只想做“像用户一样”的手工测试，那就先跑本文档的“快速人工验证”部分。

---

## 测试前准备

### 前置条件

- 已在仓库根目录执行过 `npm install`
- 已完成一次 `npm run build`
- 本机至少配置了一个能正常工作的 provider

### 建议环境变量

下面示例用 `anthropic`，你也可以换成自己本机能用的 provider。

```powershell
$env:KODAX_MANUAL_PROVIDER = "anthropic"
$env:KODAX_MANUAL_MODEL = ""
```

如果你想在第二次恢复时更容易看出 model override 生效，可以再设一个：

```powershell
$env:KODAX_MANUAL_RESUME_MODEL = "manual-resumed-model"
```

### 准备临时目录

```powershell
New-Item -ItemType Directory -Force .\.tmp\feature-034-manual | Out-Null
```

---

## 测试准备

### 1. 创建测试 extension

文件路径：
`C:\Works\GitWorks\KodaX\.tmp\feature-034-manual\manual-extension.mjs`

```js
export default function(api) {
  api.registerCommand({
    name: 'show-ext-state',
    description: 'Show persisted extension runtime state',
    handler: async () => ({
      message: JSON.stringify({
        visits: api.runtime.getSessionState('visits') ?? 0,
        records: api.runtime.listSessionRecords().length,
      }, null, 2),
    }),
  });

  api.hook('session:hydrate', (context) => {
    const visits = Number(context.getState('visits') ?? 0) + 1;
    context.setState('visits', visits);
    context.appendRecord('hydrate', { visits }, { dedupeKey: 'latest' });
  });

  api.hook('provider:before', (context) => {
    const visits = Number(api.runtime.getSessionState('visits') ?? 0);
    if (visits > 1 && process.env.KODAX_MANUAL_RESUME_MODEL) {
      context.replaceModel(process.env.KODAX_MANUAL_RESUME_MODEL);
    }
  });

  api.hook('turn:settle', (context) => {
    api.runtime.appendSessionRecord('turn', {
      lastText: context.lastText,
      hadToolCalls: context.hadToolCalls,
      success: context.success,
    });
  });
}
```

### 2. 创建底层验证 runner

文件路径：
`C:\Works\GitWorks\KodaX\.tmp\feature-034-manual\manual-runner.mts`

```ts
import path from 'node:path';
import { createExtensionRuntime, runKodaX } from '../../packages/coding/src/index.ts';
import { FileSessionStorage } from '../../packages/repl/src/interactive/storage.ts';

const mode = process.argv[2] ?? 'first';
const provider = process.env.KODAX_MANUAL_PROVIDER ?? 'anthropic';
const model = process.env.KODAX_MANUAL_MODEL || undefined;
const extensionPath = path.resolve('.tmp/feature-034-manual/manual-extension.mjs');
const storage = new FileSessionStorage();
const runtime = createExtensionRuntime();

await runtime.loadExtension(extensionPath);

const result = await runKodaX(
  {
    provider,
    model,
    extensionRuntime: runtime,
    session: {
      id: 'feature-034-manual',
      storage,
      resume: mode !== 'first',
    },
  },
  mode === 'first'
    ? 'FEATURE_034 manual persistence pass 1'
    : 'FEATURE_034 manual persistence pass 2',
);

const saved = await storage.load('feature-034-manual');
const diagnostics = runtime.getDiagnostics();

console.log(JSON.stringify({
  mode,
  success: result.success,
  lastText: result.lastText,
  extensionState: saved?.extensionState,
  extensionRecords: saved?.extensionRecords,
  failures: diagnostics.failures,
  defaults: diagnostics.defaults,
  loadedExtensions: diagnostics.loadedExtensions,
}, null, 2));

await runtime.dispose();
```

---

## 快速人工验证

### TC-034-001：REPL 能加载 extension，并暴露命令和 diagnostics

优先级：高

步骤：

1. 在仓库根目录运行：

```powershell
npm run dev -- --extension .\.tmp\feature-034-manual\manual-extension.mjs
```

2. 进入 REPL 后，输入：

```text
/extensions
```

3. 再输入：

```text
/show-ext-state
```

预期结果：

- `/extensions` 能正常输出 extension runtime diagnostics
- 输出里能看到已加载的 extension
- 输出里能看到 extension command，例如 `/show-ext-state`
- `/show-ext-state` 能执行成功
- 这时 `visits` 可能还是 `0`

说明：

- `show-ext-state` 读取的是 extension 的持久化 session state
- `visits` 是在 `session:hydrate` hook 中写入的
- 这个 hook 会在真正的 agent 运行 / session hydrate 时触发
- 仅仅启动 REPL、查看 `/extensions`、执行 extension command，本身不一定会先触发一次 hydrate

所以这里更合理的预期是：

- `/show-ext-state` 能正常执行
- 输出结构正确
- 真正的 `visits` 增长，应该在后面的 runner 验证或完成一次实际 agent 交互后观察

### TC-034-002：REPL 的 `/reload` 不回归，extension 仍然可用

优先级：高

步骤：

1. 在同一个 REPL 会话里执行：

```text
/reload
```

2. 然后再执行：

```text
/extensions
```

3. 再执行：

```text
/show-ext-state
```

预期结果：

- `/reload` 不报语法错误
- `/reload` 不出现旧的死分支或乱码提示
- `/extensions` 仍能显示 extension diagnostics
- `/show-ext-state` 仍能执行

---

## 深入验证：底层持久化与恢复

### TC-034-003：首次运行会写入 extension state 和 session records

优先级：高

步骤：

1. 运行：

```powershell
node --import tsx/esm .\.tmp\feature-034-manual\manual-runner.mts first
```

2. 观察控制台输出中的：

- `success`
- `extensionState`
- `extensionRecords`

3. 打开 session 文件：

```text
%USERPROFILE%\.kodax\sessions\feature-034-manual.jsonl
```

预期结果：

- `success` 为 `true`
- `extensionState` 中能看到当前 extension 的 namespace
- namespace 下面有 `visits: 1`
- `extensionRecords` 里至少有两类记录：
  - `hydrate`
  - `turn`
- session 文件第一行 `meta` 包含 `extensionState`
- session 文件中存在 `_type: "extension_record"` 的记录行

### TC-034-004：第二次运行可以 resume，并恢复之前的 extension 数据

优先级：高

步骤：

1. 再运行一次：

```powershell
node --import tsx/esm .\.tmp\feature-034-manual\manual-runner.mts second
```

2. 再次观察输出中的：

- `extensionState`
- `extensionRecords`

3. 再次打开：

```text
%USERPROFILE%\.kodax\sessions\feature-034-manual.jsonl
```

预期结果：

- `success` 为 `true`
- `extensionState` 里的 `visits` 从 `1` 增加到 `2`
- `hydrate` 记录仍然只保留一条最新值，因为用了 `dedupeKey: "latest"`
- `hydrate.data.visits` 变成 `2`
- `turn` 记录继续累加，不会被覆盖
- 没有出现恢复后 state/records 丢失的情况

---

## 负向验证

### TC-034-005：非 JSON 值不会写入持久化层，而是进入 diagnostics

优先级：中

步骤：

1. 临时把 `manual-extension.mjs` 里的 `turn:settle` 改成：

```js
api.hook('turn:settle', () => {
  api.runtime.setSessionState('bad-map', new Map([['x', 'y']]));
  api.runtime.appendSessionRecord('bad-set', new Set(['x']));
});
```

2. 执行：

```powershell
node --import tsx/esm .\.tmp\feature-034-manual\manual-runner.mts second
```

3. 观察输出里的 `failures`
4. 再打开 `feature-034-manual.jsonl`
5. 测完后把 extension 文件恢复

预期结果：

- 整个运行不会因为 `Map` / `Set` 崩掉
- `failures` 里能看到 `stage: "persistence"`
- `target` 能看到类似：
  - `sessionState:bad-map`
  - `sessionRecord:bad-set`
- session 文件中不会真的写入这些非法值
- 其他正常的 JSON state/records 仍然可用

---

## 边界用例

### BC-034-001：删除 session state

步骤：

1. 在 extension 里执行：

```js
api.runtime.setSessionState('visits', undefined);
```

2. 再跑一次 runner

预期结果：

- 对应 key 会从 `extensionState` 中移除
- 不会残留 `null`、`"undefined"` 这类脏值

### BC-034-002：多个 extension 的 namespace 隔离

步骤：

1. 再创建第二个 extension，也写入 `visits`
2. 同时加载两个 extension
3. 运行一次 runner 或 REPL 会话

预期结果：

- `extensionState` 按 extension namespace 分开
- 两个 extension 写相同 key 时不会互相覆盖

---

## 如果你只想做最小提交前验证

建议至少做这 3 步：

1. `npm run dev -- --extension .\.tmp\feature-034-manual\manual-extension.mjs`
2. 在 REPL 里执行 `/extensions`、`/show-ext-state`、`/reload`
3. 执行两次：

```powershell
node --import tsx/esm .\.tmp\feature-034-manual\manual-runner.mts first
node --import tsx/esm .\.tmp\feature-034-manual\manual-runner.mts second
```

只要这几步都符合预期，`034` 这次最关键的价值链路基本就覆盖到了。

---

生成时间：2026-03-25  
Feature ID：FEATURE_034
