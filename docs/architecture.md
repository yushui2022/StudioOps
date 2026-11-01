# StudioOps 技术架构

## 目标

StudioOps 是一台 Mac 的本地运维控制台：桌面端是主入口，Web 端共享同一个本地 Agent。它管理三四个小项目、launchd 服务、Docker Compose、Ollama/ComfyUI、内网穿透和主机指标。

## 总体结构

```text
┌──────────────────────┐      ┌──────────────────────┐
│ Tauri 2 desktop shell│      │ Web companion        │
│ 主入口/菜单栏/通知    │      │ 局域网或 Tailscale   │
└──────────┬───────────┘      └──────────┬───────────┘
           └──────────────┬──────────────┘
                          ▼
              ┌────────────────────────┐
              │ Local Agent            │
              │ Hono API + WebSocket   │
              │ auth / audit / registry│
              └────────────┬───────────┘
                           ▼
       ┌────────────┬────────────┬────────────┬────────────┐
       │ launchd    │ Docker     │ AI         │ Tunnel     │
       │ adapter    │ adapter    │ adapter    │ adapter    │
       └────────────┴────────────┴────────────┴────────────┘
```

## 核心决策

1. **Agent 是唯一控制层**：UI 不执行命令，不访问 Docker socket，也不直接读 launchd。所有操作经过服务注册表、动作白名单和审计事件。
2. **配置与运行时分离**：`config/services.yaml` 描述服务；SQLite 保存状态快照、事件和日志索引。代码和配置可进入 Git，进程内存不能被“保存”。
3. **适配器优先**：先实现 `launchd`、`docker-compose`、`process`、`ollama`、`comfyui`、`tunnel` 六个适配器。每个适配器负责发现、状态、动作、健康检查和日志入口。
4. **能力声明**：服务只显示它声明支持的动作。`pause` 只对明确支持的本地进程开放；网络服务默认不显示暂停，避免误把断线当成停止。
5. **实时推送按订阅惰性启动**：system/services/events 使用 WebSocket 主题；没有订阅者时不做高频轮询。历史曲线再进入 SQLite，避免把 Agent 变成重型监控系统。
6. **安全默认值**：默认只监听 `127.0.0.1`；一旦绑定局域网或 Tailscale，必须配置 token。服务目标由配置产生，不接受客户端提交的路径和 shell 字符串。

## 版本路线

### 0.1 可运行骨架（已完成）

- Agent 健康检查、主机指标、服务列表、动作白名单。
- Mock adapter 验证桌面/Web 共用控制契约。
- launchd adapter 的安全边界和命令映射。
- 一个不依赖构建工具的 Web 控制台。

### 0.2 真实服务接入（进行中）

- YAML 配置加载与 schema 校验。
- launchd：`print/kickstart/kill`、日志、崩溃状态。
- Docker Compose：项目级 up/down/restart/logs，禁止裸 Docker socket 暴露到浏览器。
- 进程与端口健康检查。
- SQLite 操作审计、服务日志入口和最近操作面板。
- 进程级 CPU/RSS 内存采集，和服务状态一起通过 WebSocket 更新。

当前本机配置已验证 Ollama（11434）和 ComfyUI（8188）的真实状态；Docker Compose 适配器已完成，但 Docker daemon 当前未运行。

主机快照会读取 `macmon pipe --samples 1`，在可用时提供 GPU、ANE、功耗和 CPU/GPU 温度；没有 macmon 时会保留系统 load、内存和磁盘指标。

### 0.3 AI 与穿透

- Ollama 模型与运行任务状态。
- ComfyUI 队列、执行中任务和 GPU 指标入口。
- Tailscale/cloudflared/frp 的状态适配器；公网入口单独标识。

### 0.4 桌面体验

- Tauri 2 桌面壳、菜单栏、通知、快捷操作。
- 启动时 Agent 生命周期管理。
- 同一 Web 前端在桌面和浏览器保持一致。

## 关键验收标准

- 桌面端和 Web 端都能看到同一服务状态，并能执行同一白名单动作。
- 任意动作都能追溯到服务 id、适配器、操作者和结果。
- 未配置 token 时 Agent 永远不绑定非回环地址。
- 添加一个新服务只需要配置或新增适配器，不改 UI 的核心控制逻辑。
