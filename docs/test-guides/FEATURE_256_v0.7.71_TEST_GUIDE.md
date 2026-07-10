# Worker-Hosted Embedded Runtime - 人工测试指导

## 功能概述

**功能名称**: Worker-Hosted Embedded Runtime + Hard Disposal
**版本**: `v0.7.71`
**Feature ID**: `256`

验证 SDK 在保持同一 `KodaXRuntime` 接口的同时，可将私有 embedded
Runtime 放入独立 Worker，并在关闭时确定性销毁。

## 测试环境

- Node.js 20 和 22 各执行一次。
- 已执行 `npm run build`，`dist/runtime-worker.js` 存在。
- 使用独立临时 `homeDir`，避免污染真实会话。

## 测试用例

### TC-001: Worker Runtime 基本服务

**优先级**: 高

1. 调用 `createKodaXRuntime({ mode: 'embedded', isolation: 'worker' })`。
2. 创建 session，随后 list/load 该 session。
3. 读取 `runtime.identity`。
4. 调用 `runtime.close()`。
5. 再调用 `runtime.status.snapshot()`。

预期：

- [ ] `mode === 'embedded'`，`isolation === 'worker'`。
- [ ] `workerThreadId` 是正整数。
- [ ] session 服务行为与 inline 相同。
- [ ] close 正常完成；关闭后的请求明确报 transport closed。

### TC-002: 资源限制与重复关闭

**优先级**: 高

1. 创建 Worker Runtime，并设置 `maxOldGenerationSizeMb` 与
   `shutdownTimeoutMs`。
2. 连续调用两次 `close()`。

预期：

- [ ] 配置可被 Worker 接受。
- [ ] 第二次关闭幂等，不抛异常，不残留 Node 进程/Worker。

### TC-003: 不支持的组合 fail-closed

**优先级**: 高

1. 调用 `createKodaXRuntime({ mode: 'daemon', isolation: 'worker' })`。
2. 连接不具备 `hardDispose` 的 daemon，同时要求
   `requirements: { hardDispose: true }`。

预期：

- [ ] daemon + worker 组合立即拒绝。
- [ ] capability 不满足时连接失败，不降级到 inline/宿主执行。

### TC-004: 发布包 sidecar

**优先级**: 高

1. 执行 `npm pack --dry-run --json`。
2. 检查文件列表。
3. 在临时项目安装 tgz 并运行 TC-001。

预期：

- [ ] 包含 `dist/runtime-worker.js` 与共享 chunks。
- [ ] 安装后的 `/runtime` 子路径可启动 Worker Runtime。

## 边界与风险

- [ ] inline 默认路径没有额外 Worker 冷启动。
- [ ] Worker 资源限制不被描述为恶意代码 sandbox。
- [ ] Worker 冷启动只发生一次，后续 session/run 请求复用同一 Worker。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 4 | - | - | - |

**测试结论**: [待填写]
