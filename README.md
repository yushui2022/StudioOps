# StudioOps

桌面端优先的 macOS 本地服务器与 AI 服务控制台。

当前仓库是从空仓库开始搭建的第一版骨架。它已经包含一个可运行的本地 Agent、共享契约、服务注册表、launchd 适配器边界，以及一个 Web 控制台。桌面端会用 Tauri 2 包装同一套 Web 前端，不再维护两套业务逻辑。

## 运行

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:7227>。

```bash
npm test
npm run typecheck
```

桌面壳需要 Rust/Tauri 工具链：

```bash
cd apps/desktop
npm install
npm run build
```

## 目录

- `services/agent`：本机控制层，HTTP API、WebSocket、适配器和服务注册表。
- `packages/contracts`：桌面端、Web、Agent 共用的 TypeScript 契约。
- `apps/web`：第一版控制台；后续由 Tauri 2 桌面壳复用。
- `docs/architecture.md`：技术架构和分阶段路线。
- `docs/research/mac-dash.md`：基于 mac-dash 实际源码的复用与取舍记录。
- `docs/research/adjacent-projects.md`：Dockge、Uptime Kuma、Netdata、OliveTin 等项目的复用边界。

## 安全边界

Agent 默认只监听回环地址。绑定局域网或 Tailscale 时必须设置 `STUDIOOPS_TOKEN`。客户端不能提交任意 shell、路径或 launchd label；服务目标必须先写入受控配置并注册适配器。
