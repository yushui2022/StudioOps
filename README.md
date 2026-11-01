# StudioOps

桌面端优先的 macOS 本地服务器与 AI 服务控制台。

当前仓库是从空仓库开始搭建的第一版骨架。它已经包含一个可运行的本地 Agent、共享契约、服务注册表、launchd 适配器边界，以及一个 Web 控制台。桌面端会用 Tauri 2 包装同一套 Web 前端，不再维护两套业务逻辑。

## 运行

要求 Node.js 22.5+（使用内置 `node:sqlite` 保存操作历史）。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:7227>。

复制 `config/services.example.yaml` 为 `config/services.yaml`，再按实际项目填写。`command`、`cwd`、`composeFile`、launchd label 和健康检查都来自这份受控配置；网页不能临时提交 shell 命令。

当前已接入的真实边界：

- `process`：启动、停止、重启、暂停、恢复、日志和 PID/健康检查。
- 进程快照：通过 PID/端口读取 CPU、RSS 内存和内存占比，并实时显示在服务卡片。
- `launchd`：`launchctl print`、`kickstart`、`bootout`/`bootstrap`、可选 `plistFile` 和配置日志。
- 本机现有 LaunchAgent：Ollama、ComfyUI 和 Ollama Tunnel 均通过真实 `gui/501/...` label 管理。
- `docker-compose`：项目级 `up -d`、`down`、`restart`、`ps` 和 `logs`。
- `EventStore`：操作历史保存到 `data/studioops.sqlite`，面板可直接查看最近操作。
- 配置备份：面板“备份配置”会把 `services.yaml` 复制到 `data/backups/`。
- 配置编辑：面板可新增、编辑、删除服务；保存前校验 ID、适配器、命令、健康端点和动作白名单。
- 配置热加载：保存或恢复后立即刷新服务注册表，不需要重启 App。
- 配置回滚：设置页列出最近备份，可直接恢复；当前配置在覆盖前会自动备份。
- 桌面端：Tauri 2 窗口随 Agent 启动，关闭窗口后保留在菜单栏，可从菜单栏重新打开或退出。
- 硬件摘要：芯片型号、P/S/GPU 核心数、内存总量，以及实时活跃核心数（P/S 分列）。
- 主机监控：系统负载、内存、磁盘余量，以及 `macmon` 提供的 Apple Silicon GPU/ANE/功耗/温度；内存占用与 macmon 使用同一口径。
- 实时推送：WebSocket 每 2 秒推送主机指标，每 5 秒推送服务状态；订阅在连接建立前不会丢失。
- 服务行内展开：点击任意服务行向下展开状态、配置、Ollama 模型和最近日志，不离开列表。
- Ollama 模型列表：点击 Ollama 服务行，显示已安装模型、大小、参数量、量化方式和加载状态。
- 进程图标：应用进程显示对应 `.app` 图标，其他进程用首字母占位；图标提取后缓存在 `data/icons`。
- 项目视图：Node/Python/自建常驻服务标记 `category: project` 后，在“项目”页单独管理端口、PID、CPU/内存、日志和启停，不和系统进程混在一起。
- 推理进程：总览单独显示 Ollama/ComfyUI 主进程与子进程的内存、CPU 和系统内存压力；主进程可停止服务，子进程可单独终止。
- 进程终止：进程页可对当前用户进程发送 SIGTERM，失败后可二次确认 SIGKILL；保护系统进程、其他用户和 StudioOps 自身/父进程链，操作写入审计。
- 进程浏览：`/api/processes` 返回按 CPU 或内存排序的进程表，面板支持搜索、排序和占用条。
- Docker：`/api/docker` 显示 daemon 状态和容器列表；daemon 可用时可对容器执行启动、停止、重启。
- 终端风格面板：总览、服务、进程、容器、日志、设置六个视图；边框式面板标题、分块柱状历史、底部快捷键栏；`1-6` 切视图、`r` 刷新、`/` 搜索、`Esc` 关闭抽屉。

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

以后也可以在仓库根目录执行 `npm run desktop:dev` 或 `npm run desktop:build`。

## 目录

- `services/agent`：本机控制层，HTTP API、WebSocket、适配器和服务注册表。
- `packages/contracts`：桌面端、Web、Agent 共用的 TypeScript 契约。
- `apps/web`：控制台页面；由浏览器和 Tauri 2 桌面壳共同复用。
- `apps/desktop/src-tauri`：桌面壳和 Agent resource 启动逻辑。
- `docs/architecture.md`：技术架构和分阶段路线。
- `docs/research/mac-dash.md`：基于 mac-dash 实际源码的复用与取舍记录。
- `docs/research/adjacent-projects.md`：Dockge、Uptime Kuma、Netdata、OliveTin 等项目的复用边界。

## 复用策略

StudioOps 不把所有能力重新实现一遍，也不提前安装一堆后台页面。现在实际复用的只有两个：

- **mac-dash + launchd**：作为 Agent、动作白名单、WebSocket 和 Tauri 壳的架构参考，并负责 Ollama、ComfyUI、Node/Python 原生项目。
- **macmon**：读取 Apple Silicon 的 GPU/ANE/功耗/温度。

其余项目按触发条件再加入，不是当前缺口：有公网服务告警需求时再加 Uptime Kuma；Docker 项目较多时再加 Dockge；OliveTin 只作为可选的“按钮层”；Homepage 最后再加，它只是入口页，不负责启停服务。详细边界见 `docs/research/adjacent-projects.md`。

## 安全边界

Agent 默认只监听回环地址。绑定局域网或 Tailscale 时必须设置 `STUDIOOPS_TOKEN`。远程浏览器在“设置 → 访问 Token”保存后，HTTP 请求和 WebSocket 都会携带它。客户端不能提交任意 shell、路径或 launchd label；服务目标必须先写入受控配置并注册适配器。
