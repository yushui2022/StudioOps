# mac-dash 源码研究记录

研究对象：`talhaorak/mac-dash`（MIT，macOS 原生服务控制台）。研究重点是实际源码，而不是 README：`server/index.ts`、`server/routes/services.ts`、`server/ws/hub.ts`、`server/plugins/registry.ts`、`server/plugins/types.ts`、`packages/desktop/package.json`。

## 复用的结构

- **Agent-first**：本机 API 服务是唯一控制层，桌面端和 Web 端都只调用它。StudioOps 先用 Hono + Node 运行，后续可以切换到 Bun，不让 UI 直接执行 shell。
- **白名单动作**：服务由配置里的稳定 `id`、`adapter`、`target` 表示；客户端只能请求已注册的动作，不能提交任意路径或命令。
- **插件注册表**：mac-dash 扫描插件目录、读取 manifest、挂载受约束的服务路由。StudioOps 将同样的边界用于 launchd、Docker Compose、Ollama、ComfyUI、隧道和指标采集适配器。
- **按主题订阅的实时推送**：mac-dash 只有在存在订阅者时才轮询并通过 WebSocket 广播。StudioOps 第一版保留 `system`、`services`、`events` 三个主题。
- **桌面壳复用 Web**：mac-dash 用 Tauri 2 包装同一套前端。StudioOps 把桌面端定位成主入口，Web 是同一 Agent 的远程/局域网补充。

## 不直接照搬的部分

- mac-dash 面向 launchd 的大量管理面板很完整，但 StudioOps 的目标包含 Docker、模型服务和穿透，因此需要 adapter 层和统一服务模型。
- launchd、Docker 和模型服务的能力差异很大，不能用一个“通用 shell 按钮”抹平；每个 adapter 必须声明能力、状态来源和失败语义。
- 配置与运行时状态分离：服务清单可版本控制，运行状态和事件历史进入本地数据库。

## 当前代码对应关系

| 设计                 | 当前文件                                      |
| -------------------- | --------------------------------------------- |
| 共享 API/事件契约    | `packages/contracts/src/index.ts`             |
| 服务注册表           | `services/agent/src/core/service-registry.ts` |
| 安全的 launchd 边界  | `services/agent/src/adapters/launchd.ts`      |
| 可替换适配器示例     | `services/agent/src/adapters/mock.ts`         |
| Hono API + WebSocket | `services/agent/src/index.ts`                 |
| Web 控制台           | `apps/web/`                                   |
