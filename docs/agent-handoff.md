# StudioOps 开发交接清单

更新时间：2026-11-01

这份文档给新的模型或 Agent 使用。目标是让它先读清楚真实代码和本机状态，再开始改动。

## 仓库、目录和运行方式

| 项目          | 内容                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| Git 仓库      | `https://github.com/yushui2022/StudioOps.git`                                        |
| 本地代码      | `/Users/orlando/Documents/mac服务器/StudioOps`                                       |
| 当前工作区    | 同一个目录直接开发；不要另建一套项目                                                 |
| Obsidian 规划 | `/Users/orlando/Documents/Obsidian Vault/mac服务器管理看板/StudioOps技术架构规划.md` |
| Agent 开发    | `npm run start`，默认监听 `127.0.0.1:7227`                                           |
| Web 开发      | Agent 启动后访问 `http://127.0.0.1:7227/`                                            |
| 桌面开发      | `npm run desktop:dev`                                                                |
| 桌面构建      | `npm run desktop:build`                                                              |
| 测试          | `npm run typecheck && npm test && npm run format:check`                              |
| Rust          | Rust stable、cargo、rustfmt 已安装                                                   |
| 当前最近提交  | `257e48c feat: add config backup and richer dashboard telemetry`                     |
| 当前工作区    | 有未提交的进程指标、菜单栏和桌面打包改动；开始前先看 `git status`，不要覆盖已有改动  |

本机配置文件 `config/services.yaml` 被 Git 忽略，只代表这台 Mac 的真实服务，不能提交到公共仓库。示例配置在 `config/services.example.yaml`。

## 当前已经完成

| 能力                    | 当前状态               | 主要代码位置                                                       | 验证情况                                               |
| ----------------------- | ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Agent 控制层            | 已完成第一版           | `services/agent/src/index.ts`                                      | Hono HTTP API、WebSocket、静态 Web 页面可启动          |
| 统一服务注册表          | 已完成第一版           | `services/agent/src/core/service-registry.ts`                      | 只允许已注册服务和已声明动作                           |
| 配置加载                | 已完成第一版           | `services/agent/src/core/config.ts`                                | YAML、服务字段、动作白名单、路径解析和端口校验         |
| process 适配器          | 已完成第一版           | `services/agent/src/adapters/process.ts`                           | 启停、重启、暂停、恢复、日志、PID、端口发现            |
| launchd 适配器          | 已完成第一版           | `services/agent/src/adapters/launchd.ts`                           | `launchctl print/kickstart/kill`、日志、PID、CPU/RSS   |
| Docker Compose 适配器   | 已完成第一版           | `services/agent/src/adapters/docker-compose.ts`                    | `up/down/restart/ps/logs` 命令构造不经过 shell         |
| HTTP/TCP/进程健康检查   | 已完成第一版           | `services/agent/src/core/health.ts`                                | Ollama、ComfyUI 返回健康状态                           |
| Ollama/ComfyUI 健康摘要 | 已完成轻量版           | `services/agent/src/core/health.ts`                                | Ollama 模型数量；ComfyUI 设备和版本                    |
| macOS 主机指标          | 已完成第一版           | `services/agent/src/core/system.ts`                                | load、内存、磁盘、macmon GPU/ANE/功耗/温度             |
| 进程指标                | 已完成第一版           | `services/agent/src/core/process-metrics.ts`                       | `ps` 读取 CPU、RSS、内存占比                           |
| 操作审计                | 已完成第一版           | `services/agent/src/core/event-store.ts`                           | SQLite 保存启停动作和错误                              |
| 配置备份                | 已完成第一版           | `services/agent/src/index.ts`、`apps/web/app.js`                   | 面板按钮复制 YAML 到 `data/backups/`                   |
| Web 面板                | 已完成可用版           | `apps/web/index.html`、`apps/web/app.js`、`apps/web/styles.css`    | 服务卡片、启停、重启、日志、系统指标、审计             |
| Tauri 桌面壳            | 已完成可编译版         | `apps/desktop/src-tauri/`                                          | 复用同一 Web；Agent 作为 release 资源启动              |
| 菜单栏入口              | 代码已接入，待提交     | `apps/desktop/src-tauri/src/main.rs`                               | “打开 StudioOps/退出 StudioOps”；窗口关闭后隐藏        |
| macOS App 打包          | 已生成 `StudioOps.app` | `apps/desktop/src-tauri/target/release/bundle/macos/StudioOps.app` | 构建通过；尚未完成签名、DMG 和安装升级流程             |
| 本机真实服务            | 已接入本机配置         | `config/services.yaml`                                             | Ollama、ComfyUI、Ollama Tunnel 的 LaunchAgent 状态可看 |

## 本机真实服务状态

| 服务          | 当前登记方式 | 目标                                 | 健康/运行信息                                 |
| ------------- | ------------ | ------------------------------------ | --------------------------------------------- |
| Ollama        | launchd      | `gui/501/ai.local.ollama`            | 11434，健康检查 200，发现 4 个模型            |
| ComfyUI       | launchd      | `gui/501/ai.local.comfyui`           | 8188，健康检查 200，设备为 mps                |
| Ollama Tunnel | launchd      | `gui/501/ai.local.ollama-tunnel`     | 当前有 PID 和日志，尚未有真实 tunnel 健康检查 |
| Docker        | CLI 已安装   | Docker daemon 当前未运行             | Compose 适配器已写，未做真实容器动作验证      |
| Tailscale/frp | 未接入命令   | 当前机器未发现 `tailscale` 或 `frpc` | 需要后续选择方案                              |
| cloudflared   | 已安装       | 版本 2026.10.7                       | 尚未接入 tunnel 适配器                        |

## 还没有完成、按优先级排序

| 优先级 | 工作项                       | 要做的行为                                                                                        | 建议修改位置                                                                                              | 验收标准                                                                 |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P0     | 提交当前未提交改动           | 合并进程指标、菜单栏、App 打包配置；补齐测试和文档                                                | `services/agent/src/core/process-metrics.ts`、`services/agent/src/adapters/*`、`apps/desktop/src-tauri/*` | 工作区干净；四个检查命令通过；提交信息清楚                               |
| P0     | Release 首次启动配置         | 当前 release Agent 将 `STUDIOOPS_CONFIG` 指向 App 数据目录，但首次运行时没有把示例/用户配置种进去 | `apps/desktop/src-tauri/src/main.rs`、`tauri.conf.json`                                                   | 首次打开 App 能看到可用服务配置；升级不覆盖用户配置                      |
| P0     | Release 真实运行验收         | 从 `StudioOps.app` 启动，确认 Agent、Web、LaunchAgent 查询、菜单栏、退出回收                      | `apps/desktop/src-tauri/`                                                                                 | App 启动后访问 7227；退出后 Agent 子进程消失；窗口关闭后菜单栏可恢复     |
| P0     | 配置和端口生命周期           | 处理端口被占用、Agent 已运行、旧进程残留、配置 YAML 语法错误                                      | `services/agent/src/index.ts`、桌面 Rust                                                                  | 有明确错误提示；不能静默启动第二个 Agent                                 |
| P0     | 桌面安全默认值               | 桌面端/远程 Web 的 token 读取、保存、修改和错误提示                                               | `services/agent/src/index.ts`、`apps/web/`、桌面设置页                                                    | 非回环监听无 token 时拒绝启动；带 token 的 HTTP 和 WebSocket 都能鉴权    |
| P1     | 服务配置编辑器               | 在面板添加、编辑、删除服务，并保存 YAML；提供备份和恢复                                           | `apps/web/`、新增 `services/agent/src/core/config-store.ts`                                               | 不手改 YAML 也能登记 Node/Python/launchd/Compose 服务                    |
| P1     | 配置热加载                   | 保存后校验、重新加载服务注册表，不重启桌面 App                                                    | `ServiceRegistry`、Agent API                                                                              | 新服务出现在列表；非法配置不会破坏当前配置                               |
| P1     | launchd 发现                 | 读取 `launchctl list`，展示现有 LaunchAgent；支持选择 label 加入配置                              | 新增 `services/agent/src/core/launchd-discovery.ts`、Web                                                  | 能列出本机 `ai.local.*` 和其他用户 LaunchAgent；动作仍走白名单           |
| P1     | tunnel 适配器                | 接入 cloudflared；后续再选 Tailscale 或 frp；显示连接状态、入口地址、日志                         | 新增 `services/agent/src/adapters/tunnel.ts` 或拆成具体适配器                                             | tunnel 卡片能显示 running/healthy/unhealthy 和日志；没有命令时给清晰错误 |
| P1     | Docker 可用性和 Compose 实测 | 检测 Docker daemon；daemon 不可用时显示原因；daemon 可用时实测 up/down/restart/logs               | `services/agent/src/adapters/docker-compose.ts`、系统卡片                                                 | 不把“Docker CLI 已安装”误显示成“容器可用”                                |
| P1     | 真实暂停/恢复边界            | process 支持 SIGSTOP/SIGCONT；launchd、Docker、模型服务不显示不支持的暂停按钮                     | `ServiceDefinition.allowedActions`、`apps/web/app.js`                                                     | UI 只显示服务声明的动作；暂停后状态和错误可解释                          |
| P1     | 日志体验                     | 日志实时流、搜索、清空视图、错误高亮、最大输出限制                                                | `services/agent/src/index.ts` WebSocket、`apps/web/app.js`                                                | 日志不会阻塞 Agent；单次读取有上限；长日志可连续查看                     |
| P1     | 指标历史                     | 保存系统/服务指标到 SQLite，绘制 CPU、GPU、内存、功耗和温度曲线                                   | `services/agent/src/core/metrics-store.ts`、Web 图表                                                      | 重启后历史仍在；采样频率和保留天数可配置                                 |
| P1     | Ollama 控制                  | 展示模型、当前加载模型、显存/内存信息；提供卸载模型和任务入口                                     | 新增 `services/agent/src/adapters/ollama.ts`                                                              | 面板能区分服务运行和模型加载；动作受配置白名单限制                       |
| P1     | ComfyUI 控制                 | 展示队列、运行任务、历史任务；支持取消队列任务；保留 MPS 指标                                     | 新增 `services/agent/src/adapters/comfyui.ts`                                                             | 不影响现有服务启停；队列操作有审计                                       |
| P2     | 项目运行时模板               | Node/Python/PM2 项目模板；生成 start/stop/restart/status/logs 配置                                | `config/services.example.yaml`、新增模板目录                                                              | 新增项目只填路径、命令、端口即可登记                                     |
| P2     | 通知和告警                   | 服务掉线、重启失败、GPU/磁盘阈值；桌面通知和可选 ntfy/Telegram                                    | Agent 事件层、Tauri 通知、可选 Uptime Kuma                                                                | 告警有去重、恢复通知和审计记录                                           |
| P2     | 开机启动                     | 用 launchd 管理 StudioOps Agent/Desktop；提供安装/卸载脚本                                        | 新增 `scripts/com.studioops.agent.plist`、桌面设置                                                        | 重启 Mac 后按用户选择启动；卸载可恢复                                    |
| P2     | App 发布                     | 代码签名、notarization、DMG、版本号、升级策略和 CI                                                | `apps/desktop/src-tauri/tauri.conf.json`、CI                                                              | 新机器可安装；升级不丢 `services.yaml`、SQLite 和备份                    |
| P2     | 插件 SDK                     | 定义适配器、健康检查、动作、日志、详情字段的扩展协议                                              | `packages/contracts`、`services/agent/src/adapters`                                                       | 新增适配器不需要修改 UI 核心逻辑                                         |
| P2     | 完整测试                     | 适配器单测、API 鉴权、WebSocket、配置回滚、Tauri smoke test                                       | `services/agent/test/`、Rust tests                                                                        | 核心控制路径有可重复测试；危险动作有 mock 保护                           |

## 参考项目和接入边界

| 项目                                                   | 已研究/已接入      | 继续怎么用                                                        | 不要直接照搬的部分                                        |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| [mac-dash](https://github.com/talhaorak/mac-dash)      | 已实际研究源码结构 | 参考 Agent-first、动作白名单、WebSocket topic、插件隔离、Tauri 壳 | 它主要管理 launchd；StudioOps 还要覆盖 Docker、模型、隧道 |
| [Dockge](https://github.com/louislam/dockge)           | 未接 UI            | 借鉴 Compose 项目目录、日志、更新交互                             | 不把 Docker socket 直接暴露给浏览器                       |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 未接入             | 作为外部告警系统或探测数据源                                      | 不当作 StudioOps 控制层                                   |
| [Netdata](https://github.com/netdata/netdata)          | 未接入             | 作为长期指标源；StudioOps 保留轻量主机快照                        | 不重复做完整监控平台                                      |
| [OliveTin](https://github.com/OliveTin/OliveTin)       | 未接入             | 借鉴固定按钮、参数限制、执行日志                                  | 不让 shell 按钮绕过服务注册表和审计                       |
| [Homepage](https://github.com/gethomepage/homepage)    | 未接入             | 仅在需要统一入口链接时作为外部入口                                | StudioOps 自己提供服务操作卡片                            |
| Tailscale                                              | 未安装             | 优先作为管理面私网访问方案                                        | 不把管理面板直接暴露公网                                  |
| cloudflared                                            | 已安装，未接入     | 适合作为可选 tunnel adapter                                       | 不假设 tunnel 一定健康，只看实际进程和探测                |
| frp                                                    | 未安装             | 如果需要公开演示，再单独实现 VPS 配置                             | 不在本机假装存在 frpc                                     |
| Ollama                                                 | 本机已运行         | 继续补模型/任务 API                                               | 不把 11434 直接暴露公网                                   |
| ComfyUI                                                | 本机已运行         | 继续补队列/历史 API                                               | 不让 Docker 版本替代原生 MPS 运行                         |

## 建议新的 Agent 按这个顺序工作

1. 先读取本文件、`docs/architecture.md`、`docs/research/mac-dash.md` 和 `docs/adr/0001-agent-first.md`。
2. 执行 `git status --short`，保留当前未提交改动；先完成 P0，不要重写架构。
3. 执行 `npm run typecheck && npm test && npm run format:check`。
4. 修复 release App 首次配置和真实启动验收，再提交菜单栏/指标改动。
5. 再做配置编辑/热加载、launchd 发现、Docker 状态、tunnel 适配器。
6. 最后做模型服务控制、指标历史、通知、开机启动和发布流程。
7. 每个阶段都要更新本文件的“当前状态”和验收结果；不要只改 README。

## 已知限制和风险

| 限制                                  | 影响                                       | 处理方式                                           |
| ------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `config/services.yaml` 是本机私有文件 | 其他机器没有真实服务登记                   | 提供配置编辑器和示例模板；不提交真实路径和用户信息 |
| Docker daemon 当前未运行              | Compose 适配器还没有真实动作证据           | 先显示 daemon 状态，等 daemon 可用后再实测         |
| Tailscale/frp 未安装                  | 不能声称公网穿透已完成                     | 先接 cloudflared 或安装后再适配                    |
| macOS 不能保存任意进程内存快照        | “保存状态”只能保存配置、代码、数据库和备份 | UI 文案必须明确                                    |
| release App 还未签名/notarize         | 只能本机开发使用                           | 发布前完成证书、DMG 和升级策略                     |
| 远程绑定需要 token                    | 忘记 token 会无法访问                      | 做设置页、环境变量说明和安全错误提示               |
