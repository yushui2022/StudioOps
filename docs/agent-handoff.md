# StudioOps 开发交接清单

更新时间：2026-11-02

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
| 当前最近提交  | 以 `git log --oneline -1` 为准                                                       |
| 未提交改动    | 干净；开始前仍先看 `git status`，不要覆盖用户已有的未提交改动                        |

本机配置文件 `config/services.yaml` 被 Git 忽略，只代表这台 Mac 的真实服务，不能提交到公共仓库。示例配置在 `config/services.example.yaml`。

## 当前已经完成

| 能力                    | 当前状态               | 主要代码位置                                                                                                           | 验证情况                                                                                                                   |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Agent 控制层            | 已完成第一版           | `services/agent/src/index.ts`                                                                                          | Hono HTTP API、WebSocket、静态 Web 页面可启动                                                                              |
| 统一服务注册表          | 已完成第一版           | `services/agent/src/core/service-registry.ts`                                                                          | 只允许已注册服务和已声明动作                                                                                               |
| 配置加载                | 已完成第一版           | `services/agent/src/core/config.ts`                                                                                    | YAML、服务字段、动作白名单、路径解析和端口校验                                                                             |
| process 适配器          | 已完成第一版           | `services/agent/src/adapters/process.ts`                                                                               | 启停、重启、暂停、恢复、日志、PID、端口发现                                                                                |
| launchd 适配器          | 已完成第二版           | `services/agent/src/adapters/launchd.ts`                                                                               | print/kickstart/bootout/bootstrap；支持 plistFile；停止后健康为 unknown                                                    |
| Docker Compose 适配器   | 已完成第二版           | `services/agent/src/adapters/docker-compose.ts`                                                                        | `up/down/restart/ps/logs`；服务数/运行数/容器状态；真实 Compose 全流程已实测；错误提取 stderr                              |
| HTTP/TCP/进程健康检查   | 已完成第一版           | `services/agent/src/core/health.ts`                                                                                    | Ollama、ComfyUI 返回健康状态                                                                                               |
| Ollama/ComfyUI 健康摘要 | 已完成轻量版           | `services/agent/src/core/health.ts`                                                                                    | Ollama 模型数量；ComfyUI 设备和版本                                                                                        |
| macOS 主机指标          | 已完成第三版           | `services/agent/src/core/system.ts`                                                                                    | 芯片/P/S/GPU 核心数、内存、活跃核心；P/S 占用、频率、风扇、功耗、温度                                                      |
| 进程指标                | 已完成第一版           | `services/agent/src/core/process-metrics.ts`                                                                           | `ps` 读取 CPU、RSS、内存占比                                                                                               |
| ComfyUI 队列            | 已完成                 | `core/comfyui.ts`、`/api/services/:id/comfyui`、`/api/services/:id/comfyui/cancel`、`apps/web/app.js`                  | 运行/等待/历史；MPS VRAM；中断/取消；comfy-cancel 审计                                                                     |
| Tailscale 身份审计      | 已完成                 | `core/event-store.ts`、`services/agent/src/index.ts`、`apps/web/app.js`                                                | Tauri/本机/远程 actor；Tailscale-User-Login/Name 写入审计；旧 SQLite 自动加列                                              |
| 网络世界地图            | 已完成                 | `core/network-connections.ts`、`/api/network/connections`、`apps/web/assets/world-map.svg`、`apps/web/app.js`          | lsof ESTABLISHED/LISTEN；公网过滤；入站 GeoIP；离线地图弧线；出站列表；不抓包                                              |
| 推理网关                | 已完成                 | `services/gateway/src/*`、`core/gateway-service.ts`、`/api/gateway/*`、`apps/web/app.js`                               | 11435/8191 反向代理、队列/并发/超时/取消、内存准入、空闲模型卸载、LaunchAgent 常驻、网关视图、最近事件和持久化模型调用记录 |
| 算力用户审计            | 已完成                 | `core/compute.ts`、`/api/compute`、`apps/web/app.js`                                                                   | compute 标准用户、会话/进程/磁盘/登录历史、Tailscale SSH 状态与开关、主目录权限告警、管理审计                              |
| Ollama 模型操作         | 已完成                 | `services/agent/src/core/ollama.ts`、`/api/services/:id/models`、`/api/services/:id/models/:action`                    | 合并 tags/ps；VRAM/内存/到期；加载/卸载；服务停止隐藏操作；model-load/unload 审计                                          |
| 进程图标                | 已完成                 | `services/agent/src/core/process-icons.ts`、`/icons/:key.png`                                                          | 从 .app 提取并缓存 64px PNG；无图标进程用首字母占位                                                                        |
| 后端稳定性与安全        | 已完成                 | `services/agent/src/index.ts`、`config-store.ts`、`event-store.ts`、`service-registry.ts`、`process.ts`、`main.rs`     | 动作串行、轮询防重叠、配置错误禁写、配置审计、事件保留、WS Origin 校验、路径校验、复用已有 Agent                           |
| 单桌面实例              | 已完成                 | `apps/desktop/src-tauri/src/main.rs`、`Cargo.toml`                                                                     | Tauri single-instance；重复启动只聚焦原窗口，不新增 Agent                                                                  |
| 启动错误提示            | 已完成                 | `apps/desktop/src-tauri/src/main.rs`、`apps/web/app.js`                                                                | 端口冲突/连续启动失败弹窗；配置错误顶部横幅；日志路径提示                                                                  |
| Agent 自动重启          | 已完成                 | `apps/desktop/src-tauri/src/main.rs`                                                                                   | 桌面端 supervisor 监控 Agent；异常退出退避重启；正常退出不拉起                                                             |
| 项目服务模板            | 已完成                 | `services/agent/src/core/project-templates.ts`、`/api/project-templates`、`apps/web/app.js`                            | 7 个模板；选目录自动补全名称/ID/日志/命令/端口/健康检查                                                                    |
| 项目开机启动开关        | 已完成                 | `core/project-persistence.ts`、`/api/projects/:id/autostart`、`apps/web/app.js`                                        | 常驻项目独立控制 RunAtLoad；只重写 plist，不重启当前服务                                                                   |
| 项目服务常驻            | 已完成                 | `services/agent/src/core/project-persistence.ts`、`/api/projects/:id/persist`                                          | 生成 LaunchAgent、bootstrap/bootout、KeepAlive、RunAtLoad、取消常驻                                                        |
| cloudflared 隧道        | 已完成                 | `adapters/cloudflared.ts`、`core/config.ts`、`apps/web/app.js`、`apps/web/index.html`                                  | quick/config/token；公网地址/错误/日志；quick tunnel 安全审计高风险；真实 quick tunnel 已实测                              |
| 日志实时流              | 已完成                 | `core/log-stream.ts`、`apps/web/app.js`、`apps/web/index.html`、`packages/contracts`                                   | offset tail + WebSocket 增量；搜索、清空、错误高亮、轮转重置；客户端关闭即停止                                             |
| LaunchAgent 发现        | 已完成                 | `core/launchd-discovery.ts`、`/api/launchd/agents`、`apps/web/app.js`                                                  | 扫描用户 plist + launchctl 状态；prefill 导入表单；已配置标记；仍走白名单                                                  |
| 告警与通知              | 已完成                 | `core/alerts.ts`、`/api/alerts/status`、`/api/alerts/settings`、`apps/web/app.js`                                      | 服务掉线/操作失败/内存/磁盘/温度；确认时间、滞后、去重、重复间隔、恢复通知、测试通知                                       |
| 指标历史                | 已完成                 | `core/metrics-store.ts`、`core/metrics-sampler.ts`、`/api/metrics/history`、`/api/metrics/settings`、`apps/web/app.js` | SQLite 原始+1m/1h rollup；5m/1h/24h；服务 CPU/内存；采样和保留可配                                                         |
| 外部访问安全检查        | 已完成                 | `core/security-audit.ts`、`/api/security/audit`、`apps/web/app.js`、`apps/web/index.html`                              | 审计回环绑定、Token、Funnel、Ollama 11434、项目入口和 ACL 提醒；高风险在设置页展示                                         |
| 项目 Tailnet 入口       | 已完成                 | `core/tailscale.ts`、`/api/tailscale/projects`、`/api/projects/:id/tailscale`、`apps/web/app.js`                       | 项目卡片开放/关闭；自动分配 HTTPS 端口；配置保存 tailscaleServePort；旧端口入口自动清理                                    |
| Tailscale 私网访问      | 已完成                 | `core/tailscale.ts`、`core/api-token.ts`、`/api/remote-access`、`/api/security/token`、`apps/web/app.js`               | 状态、Tailnet IP、MagicDNS、Serve 开关；Token 文件 0600；本机免 Token、远程强制 Token；仅 tailnet，不启用 Funnel           |
| 卸载与恢复              | 已完成                 | `services/agent/src/core/uninstall.ts`、`/api/uninstall/*`、`apps/web/app.js`、`scripts/uninstall-studioops.sh`        | 导出配置/数据；停止托管进程；清理 com.studioops.* LaunchAgent；重置常驻配置；退出桌面端                                    |
| 项目服务视图            | 已完成                 | `packages/contracts`、`core/config.ts`、`core/discovery.ts`、`apps/web/app.js`                                         | `category: project` 单独成页；自动发现监听端口的开发进程并可纳入项目                                                       |
| 推理进程面板            | 已完成                 | `services/agent/src/core/inference.ts`、`/api/inference`、`apps/web/app.js`                                            | 识别 Ollama/ComfyUI 进程树；内存汇总、压力提示、停止/终止快捷操作                                                          |
| 进程身份持久化          | 已完成                 | `services/agent/src/adapters/process.ts`、`core/process-metrics.ts`                                                    | 自动 pid 文件（启动时间+命令）；Agent 重启后重新识别并校验 PID 复用                                                        |
| 进程终止                | 已完成                 | `services/agent/src/core/process-control.ts`、`/api/processes/:pid/terminate`                                          | 仅当前用户；保护祖先进程链；SIGTERM 失败后可 SIGKILL；写入审计                                                             |
| 进程浏览                | 已完成                 | `services/agent/src/core/process-list.ts`、`/api/processes`                                                            | 按 CPU/内存排序、搜索、占用条、4 秒刷新                                                                                    |
| Docker 状态和动作       | 已完成                 | `services/agent/src/core/docker-status.ts`、`/api/docker`                                                              | daemon 状态、容器列表、启动/停止/重启；已用真实容器验证                                                                    |
| 实时推送                | 已修复                 | `services/agent/src/index.ts`                                                                                          | 订阅先于首帧挂载；系统 2 秒、服务 5 秒推送                                                                                 |
| 远程 Token 鉴权         | 已完成                 | `services/agent/src/index.ts`、`apps/web/app.js`、设置页                                                               | HTTP Bearer + WebSocket query token；本机回环无需 Token                                                                    |
| 操作审计                | 已完成第一版           | `services/agent/src/core/event-store.ts`                                                                               | SQLite 保存启停动作和错误                                                                                                  |
| 配置备份                | 已完成                 | `services/agent/src/core/config-store.ts`、`apps/web/app.js`                                                           | 自动/手动备份、列表、恢复；保留最近 30 份                                                                                  |
| 配置写入和热加载        | 已完成                 | `services/agent/src/core/config-store.ts`、`/api/config/services`                                                      | 增删改、校验、原子写入、备份、立即刷新注册表                                                                               |
| 运行中改配置语义        | 已完成                 | `services/agent/src/core/config-diff.ts`、`apps/web/app.js`                                                            | 只标记运行参数变更；提示立即重启或更新常驻；名称/说明变更不重启                                                            |
| Web 面板                | 已完成终端风格 v5      | `apps/web/index.html`、`apps/web/app.js`、`apps/web/styles.css`                                                        | 六视图、服务行内展开、编辑表单、备份恢复、边框标题、分块柱状图                                                             |
| Tauri 桌面壳            | 已完成可编译版         | `apps/desktop/src-tauri/`                                                                                              | 复用同一 Web；Agent 作为 release 资源启动                                                                                  |
| 菜单栏入口              | 已完成                 | `apps/desktop/src-tauri/src/main.rs`                                                                                   | “打开 StudioOps/退出 StudioOps”；窗口关闭后隐藏                                                                            |
| macOS App 打包          | 已生成 `StudioOps.app` | `apps/desktop/src-tauri/target/release/bundle/macos/StudioOps.app`                                                     | 构建通过；尚未完成签名、DMG 和安装升级流程                                                                                 |
| Release 首次配置        | 已完成并本机验收       | `config/services.first-run.yaml`、`apps/desktop/src-tauri/src/main.rs`                                                 | 首次启动写入 App 数据目录；已有配置不覆盖；含 Rust 与 TS 测试                                                              |
| Release Node 查找       | 已完成并本机验收       | `apps/desktop/src-tauri/src/main.rs`                                                                                   | 支持 `STUDIOOPS_NODE`、Homebrew、Volta、nvm；Agent 日志写 `agent.log`                                                      |
| Release 资源打包        | 已修复                 | `apps/desktop/src-tauri/tauri.conf.json`                                                                               | 显式映射 `agent.cjs` 和 `web`，不再落到 `Resources/_up_/...`                                                               |
| Release 前后端连接      | 已修复                 | `apps/web/app.js`、`services/agent/src/index.ts`                                                                       | 内嵌页面固定请求 7227；仅对 Tauri origin 开放 CORS                                                                         |
| 本机真实服务            | 已接入本机配置         | `config/services.yaml`                                                                                                 | Ollama、ComfyUI、Ollama Tunnel 的 LaunchAgent 状态可看                                                                     |

## 本机真实服务状态

| 服务              | 当前登记方式 | 目标                                      | 健康/运行信息                                                             |
| ----------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------- |
| Ollama            | launchd      | `gui/501/ai.local.ollama`                 | 11434，健康检查 200，发现 4 个模型                                        |
| ComfyUI           | launchd      | `gui/501/ai.local.comfyui`                | 8188，健康检查 200，设备为 mps                                            |
| Ollama Tunnel     | launchd      | `gui/501/ai.local.ollama-tunnel`          | `11434→11435`、`8190→8191`；已实测 VPS 回环和 Docker 网桥经过网关         |
| Inference Gateway | launchd      | `gui/501/com.studioops.inference-gateway` | 11435/8191/11436；并发 2/1、队列 8、内存预算 52 GB；真实 Sub2API 已过网关 |
| Docker            | CLI 已安装   | Docker Desktop 2.x / daemon 可启动        | `/api/docker` 显示状态；已用测试容器验证启动/停止/重启并清理              |
| Tailscale         | 已安装并验收 | `1.104.4`；tailnet `yushui2022.github`    | 100.115.137.62；MagicDNS + Serve 已验证；StudioOps 仅 tailnet 开放        |
| cloudflared       | 已接入       | 版本 2026.10.7                            | quick tunnel 已实测；config/token 命令有单测                              |

## Release 验收记录（2026-11-01）

在 `npm run desktop:build` 之后直接启动 `StudioOps.app` 验收：

1. 首次启动自动生成 `~/Library/Application Support/com.studioops.desktop/services.yaml`，uid 正确替换，`studioops.sqlite` 和 `agent.log` 同时生成。
2. Agent 监听 `127.0.0.1:7227`；`/api/services` 返回 Ollama `running/healthy`（4 个模型）、ComfyUI `running/healthy`（mps）、Ollama Tunnel `running/unknown`。
3. 窗口显示“已连接”，服务卡片和主机指标正常渲染。
4. 二次启动不会覆盖已经修改过的 `services.yaml`（Rust 单测覆盖）。
5. 通过菜单退出后，桌面进程和 Agent 子进程都消失，7227 端口释放。

2026-11-01 第二轮终端风格验收：

1. 总览页显示 2 秒实时采样：P-CPU、S-CPU、GPU、ANE、风扇、采样时间、六张带分块柱状历史的指标卡；面板标题嵌在边框上。
2. 服务、进程、容器、日志、设置五个视图均可切换；服务操作按当前状态只显示有意义的按钮；`1-6`、`r`、`/`、`Esc` 快捷键可用。
3. 进程页显示 top 50（总进程数、CPU/内存条）；Docker 页显示 daemon 版本和容器，已用 `node:22-bookworm-slim` 测试容器验证启动/停止/重启后删除。
4. 日志页支持 100/300/1000 行、自动刷新和 error/warn 高亮；设置页显示配置路径、绑地址、Token 状态和数据目录。
5. WebSocket 修复后，`SAMPLE`、指标值和面积图每 2 秒更新；此前订阅消息会因服务端首帧未挂监听而丢失。
6. 设置页保存 Token 后，HTTP 401/200 和 WebSocket 1008/正常消息均已用独立 Agent 实例验证。
7. 服务编辑表单新增 process 服务（含 args/cwd/env/pidFile/日志/端口/健康检查），保存后立即出现在服务列表，无需重启 Agent。
8. 编辑服务后再次保存，环境变量和 PID 文件仍保留；配置校验会拒绝非法 ID、未知适配器、缺少命令/Compose 文件和非法 launchd target。
9. 设置页可看到每次保存前的备份并恢复；恢复后注册表立即回到备份内容。非法 YAML reload 返回 400，上一份可用配置保持不变。
10. 把进程服务写坏后通过 `POST /api/config/reload` 验证：返回 400，旧服务列表继续可用。
11. 用真实 Ollama LaunchAgent 验证停止/启动：`bootout` 后状态 stopped、11434 关闭；`bootstrap + kickstart` 后恢复 running/healthy。停止状态不再显示 unhealthy，而是 unknown。
12. 桌面端按钮曾提示“Agent 未启动或端口 7227 不可达”：根因是 Tauri 内嵌页面跨域请求带 `x-studioops-actor`，而 CORS 预检没允许该头。已加入 allowHeaders，并用 OPTIONS 验证返回 204 和完整 allow-headers。以后新增自定义请求头必须同步更新 CORS。
13. 点击 Ollama 服务行会在表格内向下展开，不打开右侧抽屉；展开区请求 `/api/services/ollama/models`，显示 4 个模型、大小、量化、加载状态和最近日志。再点一次收起。
14. 进程页实际终止一个测试 node 进程：确认框 → SIGTERM → 进程消失 → toast 和 `process:<pid>` 审计记录。Agent 父进程链（zsh）被拒绝终止，返回 400 “StudioOps 进程链”。
15. 进程页显示真实应用图标：Chrome、WeChat、StudioOps、Ollama 等取到 `.app` 图标，WindowServer 等系统进程使用首字母占位；图标缓存在 `data/icons/`。
16. 总览顶部硬件摘要显示 Apple M5 Max、12P + 6S + 40GPU、64 GB，以及活跃核心数（总计 18，P/S 分列）；P-CPU/S-CPU 百分比之和与整体 CPU 一致。
17. 推理进程面板实际显示 ComfyUI 主进程 2.28 GB、Ollama 40 MB、ComfyUI worker/bridge；主进程显示“停止服务”，子进程显示“终止”，压力徽标为正常。
18. 后端加固验收：同一服务并发动作串行（单测）；系统/服务轮询有 busy guard；配置 YAML 损坏后 add 返回 400、restore 可恢复；配置变更写入审计；恶意 Origin 的 HTTP 返回 403、WebSocket 返回 1008；`/../etc/passwd` 返回 404；桌面端检测到 7227 已有 Agent 时不再启动第二个。
19. 项目视图验收：新增 `category: project` 的 Demo API 后，只在“项目”页出现，显示端口 3100、PID、CPU/内存和日志/编辑/启动操作；服务页与进程页不混入项目卡片。
20. 自动发现验收：本机启动一个监听 4322 的 Node 服务后，“项目 → 自动发现”自动列出它及已运行的 kopi 开发服务，显示端口、内存和命令；无需手工录入即可“一键纳入项目”。
21. 项目常驻验收：一个监听 4399 的 Node 项目执行“设为常驻”后生成 `com.studioops.project.persist-test.plist`，launchd running、端口 200、只有一个监听进程；取消常驻后 plist 删除、launchd 卸载、配置恢复 process。
22. Agent 自动重启验收：直接 `kill -9` 7227 的 Agent，约 2 秒后出现新 PID 并恢复 `/api/health`；退出 App 后 Agent 停止且不重启。已有 Agent 被接管时，旧 Agent 消失后也会自动补起。
23. 启动错误验收：用 `python3 -m http.server 7227` 占用端口后启动 App，弹出“StudioOps Agent 无法启动 / 端口 7227 已被其他程序占用”对话框，并提示 `lsof` 排查命令；关闭占用后再次启动恢复正常。
24. 进程身份验收：启动一个无端口、无 pidFile 的 Node 项目，生成 `data/pids/adopt-test.pid`（含 PID、lstart、命令行）；kill Agent 后子进程继续运行，新 Agent 启动后仍识别同一 PID；停止后 pid 文件删除。
25. 项目模板验收：打开“新增项目服务”可选择 Node/npm、Vite、Python、uvicorn、PM2、静态站点；选择 `/Users/orlando/Documents/kopi` 后自动填充 ID/name/target/日志路径；切到 uvicorn 后命令、参数、端口和健康检查自动更新。
26. 重启语义验收：运行中的服务只改名称时 `restartRequired=false`；改端口时返回 `changedFields=["port"]` 和 `restartRequired=true`；前端弹出“立即重启/更新常驻”提示。
27. 开机启动开关验收：常驻项目关闭开机启动后 plist 的 RunAtLoad 变 false，当前服务仍保持运行；重新开启后变为 true；取消常驻后 plist 和 launchd 都能回收。
28. 单实例验收：首次启动 App 后执行 `open -n /Applications/StudioOps.app`，桌面进程保持 1 个、Agent 保持 1 个，第二次启动只聚焦已有窗口。
29. Tailscale 验收：假 CLI 覆盖 Running 状态、Serve 配置、无 Token 拒绝、Token 权限 0600、导出不包含 `api-token`；随后在本机安装 Tailscale 1.104.4 并登录，真实 Serve 已开放 `https://<your-mac>.<your-tailnet>.ts.net/`；tailnet 无 Token 访问 `/api/config` 返回 401，带 Token 返回 200，本地回环访问不需要 Token；远程页面登录后可正常加载。浏览器系统代理需要绕过 `*.ts.net`。
30. 项目 Tailnet 验收：临时项目 4398 在项目页点“开放 Tailnet”，自动分配 8443 并生成 `https://<your-mac>.<your-tailnet>.ts.net:8443/`；真实 curl 返回 200，Tailscale Serve 同时保留 StudioOps 443；关闭后 8443 入口消失、443 不受影响；配置写入 tailscaleServePort。
31. 外部访问安全检查验收：设置页显示 6 项正常、1 条 ACL 无法本机验证警告；真实环境无 Funnel、无 11434 暴露；项目 11434 入口被 API 以 400 拒绝；模拟 Funnel 和 Ollama 暴露时审计返回 critical。
32. cloudflared 验收：临时 HTTP 服务 4397 通过 quick tunnel 启动，日志解析出 `https://head-sending-material-nursery.trycloudflare.com`，真实公网 curl 返回 200；服务页显示 running 和公网地址；停止后 cloudflared 子进程和 PID 文件回收；config/token 命令构造由单测覆盖；模拟 PATH 中无 cloudflared 时服务状态为 error 并返回安装提示。named tunnel 真实域名联调需要 Cloudflare 账号和域名，尚未执行。
33. 指标历史验收：Agent 默认 10 秒采样，SQLite 写入原始点和 1m/1h rollup；5m 返回 10 秒点、1h 返回 1 分钟点、24h 返回 5 分钟点；历史视图显示 6 张系统曲线和服务 CPU/内存；重启 Agent 后历史仍在；设置页可保存采样间隔和保留天数。
34. 告警与通知验收：真实进程被 kill 后进入 pending，超过确认时间后 firing，服务重启后发送恢复通知；同一告警在确认后不重复发送；内存阈值滞后由单测覆盖；设置页显示开关、阈值、活动告警和最近记录；`POST /api/alerts/test` 成功触发 macOS 桌面通知。
35. 日志实时流验收：WebSocket 订阅先返回最后 2 行，追加文件后 1 秒内只推送新增行；搜索 `line-3` 只显示匹配行并高亮；清空视图不删除日志文件；文件截断后返回 reset；error/warn 行有颜色；关闭页面/切换视图后订阅停止。
36. 推理网关验收：网关作为独立 LaunchAgent 运行，`11435/8191/11436` 均监听回环；单元/集成测试覆盖转发、流式、并发、队列满 429、排队超时 503、客户端断开取消、请求超时 504、请求体 413、内存预算和模型槽位；真实环境自动卸载 bge-m3 后加载 qwen 27B；SSH 隧道改为 `11434→11435`、`8190→8191` 后，VPS 回环和 Docker 网桥请求都计入网关；真实 Sub2API `/v1/chat/completions` 返回 200，网关只记录元数据不记录 prompt。
37. Compose 验收：临时 Compose 项目包含 web/worker 两个 node 服务；`up -d` 后项目卡片显示 `2 / 2` 服务和两个 running 容器，日志返回 `web tick`/`worker tick`；`restart` 后仍 running；`down` 后服务数保留 2、运行容器 0、状态 stopped；未影响现有 qq-stack。
38. LaunchAgent 导入验收：真实环境扫描 7 个用户 agent，列出 4 个 `ai.local.*`、loaded/PID 和命令；已配置的 ollama/comfyui/ollama-tunnel 禁用导入；临时 HOME 中导入 `ai.local.demo`，表单预填 target/plist/log，保存后配置为 launchd 服务并通过白名单校验。
39. Ollama 模型验收：bge-m3 在 UI 显示 VRAM/内存/到期；卸载后 `/api/ps` 为空、UI 变为“磁盘”并显示加载按钮；重新加载后恢复 VRAM；审计记录 model-unload/model-load；服务停止时按钮由 `state === running` 隐藏。
40. ComfyUI 队列验收：真实 ComfyUI 返回 1 个运行任务、6 条历史和 mps 显存；服务行显示 MPS VRAM/GPU/温度；模拟 ComfyUI 服务验证运行任务 `/interrupt`、等待任务 `delete`，两次 comfy-cancel 审计成功；未取消真实任务。
41. Tailscale 身份审计验收：带 `Tailscale-User-Login`/`Tailscale-User-Name` 的远程请求写入审计，`/api/events` 返回 `actor=web`、`remoteUser=friend@example.com`、`remoteName=Friend User`；本机事件仍不带远程身份。
42. 网络地图验收：真实环境显示服务器位置 Shanghai · CN、0 个公网入站、70+ 个本机外联；入站/出站/全部切换正常；出站 top 8 目的地后台 GeoIP，地图显示金色出站弧线；Tailscale/回环/私网过滤；`lsof` 解析和方向判断有单测。
43. 卸载与恢复验收：设置页显示 1 个测试 LaunchAgent 和托管服务；导出生成 `~/Downloads/StudioOps-backup-*.tar.gz`；清理后测试 plist 和非 StudioOps plist 的对照结果正确，托管进程停止、常驻配置恢复 process、配置自动备份，Agent 仍可响应；`scripts/uninstall-studioops.sh --yes --purge-data --remove-app` 在临时 HOME 中移除 data、app 和 LaunchAgent，同时保留备份归档。

这次验收同时修掉了两个开发模式看不出的问题：Tauri 资源被放进 `Resources/_up_/...` 导致 Agent 找不到；内嵌 Web 页面的 `/api` 相对地址和跨域请求无法到达 7227。以后修改打包配置后必须重新做一次上面的真机验收。

**TCC 注意**：如果直接启动仓库目录里（`~/Documents/...`）的 `StudioOps.app`，macOS 会弹“访问文稿文件夹”的权限框并卡住 Agent。验收或日常使用请把 App 放到 `/Applications` 或 `~/Applications` 再启动。

## 还没有完成、按优先级排序

| 优先级 | 工作项                       | 要做的行为                                                                                                            | 建议修改位置                                                                                              | 验收标准                                                                        |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P0     | 提交当前未提交改动           | 合并进程指标、菜单栏、App 打包配置；补齐测试和文档                                                                    | `services/agent/src/core/process-metrics.ts`、`services/agent/src/adapters/*`、`apps/desktop/src-tauri/*` | 工作区干净；四个检查命令通过；提交信息清楚                                      |
| P0     | Release 首次启动配置         | 已完成：首次启动把 `config/services.first-run.yaml` 写入 App 数据目录，UID 自动替换，已有配置不覆盖                   | `apps/desktop/src-tauri/src/main.rs`、`config/services.first-run.yaml`                                    | 首次打开 App 能看到可用服务配置；升级不覆盖用户配置（构建后仍需真机验收）       |
| P0     | Release 真实运行验收         | 已完成本机验收：从 `StudioOps.app` 启动，Agent 在 7227，Web 已连接并显示 Ollama/ComfyUI 健康；退出后 Agent 子进程回收 | `apps/desktop/src-tauri/`                                                                                 | 菜单栏“打开/退出”的人工点击验收仍建议补一次                                     |
| P0     | 配置和端口生命周期           | 处理端口被占用、Agent 已运行、旧进程残留、配置 YAML 语法错误                                                          | `services/agent/src/index.ts`、桌面 Rust                                                                  | 有明确错误提示；不能静默启动第二个 Agent                                        |
| P0     | 桌面安全默认值               | 已完成 Web 端 Token 保存/清除和 WS query 鉴权；HTTP 与 WebSocket 都已验证；还缺桌面设置页                             | `services/agent/src/index.ts`、`apps/web/`、桌面设置页                                                    | 非回环监听无 token 时拒绝启动；带 token 的 HTTP 和 WebSocket 都能鉴权（已验证） |
| P1     | 服务配置编辑器               | 已完成：面板新增/编辑/删除服务，服务端校验，保存前自动备份，设置页可恢复                                              | `apps/web/`、`services/agent/src/core/config-store.ts`                                                    | 不手改 YAML 也能登记 Node/Python/launchd/Compose 服务（已实测）                 |
| P1     | 配置热加载                   | 已完成：保存/恢复后直接替换注册表并广播；非法 reload 保留上一份可用配置                                               | `ServiceRegistry`、Agent API                                                                              | 新服务出现在列表；非法配置不会破坏当前配置（已实测）                            |
| P1     | launchd 发现                 | 已完成：读取用户 plist + launchctl 状态，显示 loaded/PID、命令和已配置标记；导入打开预填表单                          | `services/agent/src/core/launchd-discovery.ts`、`/api/launchd/agents`、设置页                             | 能列出 `ai.local.*` 和其他用户 LaunchAgent；动作仍走白名单（已实测）            |
| P1     | cloudflared named 真机联调   | quick/config/token 适配器已完成；还需要 Cloudflare 域名、named tunnel 和 Access 的真实联调                            | `docs/cloudflared.md`、真实 Cloudflare 账号                                                               | named tunnel 固定域名可访问；Access 策略生效；日志能看到连接状态                |
| P1     | Docker 可用性和 Compose 实测 | 已完成：真实临时 Compose 项目验证 up/down/restart/logs；项目页显示服务数和容器状态                                    | `services/agent/src/adapters/docker-compose.ts`、项目页                                                   | Compose 动作和错误提示有真实证据（已实测）                                      |
| P1     | 真实暂停/恢复边界            | UI 已按状态过滤动作；launchd、Docker、模型服务不再显示无效暂停按钮；process 的 SIGSTOP/SIGCONT 待补测试               | `ServiceDefinition.allowedActions`、`apps/web/app.js`                                                     | UI 只显示服务声明的动作；暂停后状态和错误可解释                                 |
| P1     | 日志体验                     | 已完成：offset tail + WebSocket 增量、搜索、清空视图、error/warn 高亮、轮转/截断 reset、100/300/1000 行               | `services/agent/src/core/log-stream.ts`、Agent WebSocket、`apps/web/app.js`                               | 日志不会阻塞 Agent；单次读取有上限；长日志可连续查看（已实测）                  |
| P1     | 指标历史                     | 已完成：SQLite 原始+rollup、5m/1h/24h 曲线、服务 CPU/内存、采样和保留设置                                             | `services/agent/src/core/metrics-store.ts`、`core/metrics-sampler.ts`、Web 历史视图                       | 重启后历史仍在；采样频率和保留天数可配置（已实测）                              |
| P1     | Ollama 控制                  | 已完成：模型加载/卸载、VRAM/内存、到期时间、审计；服务停止隐藏操作                                                    | `services/agent/src/core/ollama.ts`、`/api/services/:id/models/:action`                                   | 面板能区分服务运行和模型加载；操作有审计（已实测）                              |
| P1     | ComfyUI 控制                 | 已完成：队列/运行/历史、中断/取消、MPS VRAM/GPU/温度、comfy-cancel 审计                                               | `services/agent/src/core/comfyui.ts`、`/api/services/:id/comfyui`                                         | 不影响现有服务启停；队列操作有审计（已实测）                                    |
| P2     | 项目运行时模板               | Node/Python/PM2 项目模板；生成 start/stop/restart/status/logs 配置                                                    | `config/services.example.yaml`、新增模板目录                                                              | 新增项目只填路径、命令、端口即可登记                                            |
| P2     | 通知和告警                   | 已完成 P0：服务掉线、操作失败、内存/磁盘/温度阈值、去重和恢复通知；后续再补 ntfy/Telegram/Uptime Kuma                 | `services/agent/src/core/alerts.ts`、设置页                                                               | 告警有确认时间、滞后、去重、恢复通知和审计记录（已实测）                        |
| P2     | 开机启动                     | 用 launchd 管理 StudioOps Agent/Desktop；提供安装/卸载脚本                                                            | 新增 `scripts/com.studioops.agent.plist`、桌面设置                                                        | 重启 Mac 后按用户选择启动；卸载可恢复                                           |
| P2     | App 发布                     | 代码签名、notarization、DMG、版本号、升级策略和 CI                                                                    | `apps/desktop/src-tauri/tauri.conf.json`、CI                                                              | 新机器可安装；升级不丢 `services.yaml`、SQLite 和备份                           |
| P2     | 插件 SDK                     | 定义适配器、健康检查、动作、日志、详情字段的扩展协议                                                                  | `packages/contracts`、`services/agent/src/adapters`                                                       | 新增适配器不需要修改 UI 核心逻辑                                                |
| P2     | 完整测试                     | 适配器单测、API 鉴权、WebSocket、配置回滚、Tauri smoke test                                                           | `services/agent/test/`、Rust tests                                                                        | 核心控制路径有可重复测试；危险动作有 mock 保护                                  |

## 参考项目和复用时机

下面的项目不是“没做完的集成”，而是按需求分阶段接入。现在就用的只有 mac-dash（架构和 launchd 路线）和 macmon（Apple Silicon 指标）；其余项目有明确触发条件再加。

| 项目                                                   | 现在是否使用 | 什么时候接                                           | 不要直接照搬的部分                                        |
| ------------------------------------------------------ | ------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| [mac-dash](https://github.com/talhaorak/mac-dash)      | 已复用架构   | 现在：launchd 管理 Ollama、ComfyUI、Node/Python 项目 | 它主要管理 launchd；StudioOps 还要覆盖 Docker、模型、隧道 |
| [macmon](https://github.com/vladkens/macmon)           | 已实际调用   | 现在：Apple Silicon 的 GPU/ANE/功耗/温度             | 只读取指标，不用它做服务控制                              |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 未装         | 有公网服务告警需求时                                 | 不当作 StudioOps 控制层                                   |
| [Dockge](https://github.com/louislam/dockge)           | 未装         | 只有 Docker 项目较多、需要项目目录管理时             | 不把 Docker socket 直接暴露给浏览器                       |
| [OliveTin](https://github.com/OliveTin/OliveTin)       | 未装         | 需要固定脚本“按钮层”时                               | 不让 shell 按钮绕过服务注册表和审计                       |
| [Netdata](https://github.com/netdata/netdata)          | 未装         | 需要长期指标和图表时                                 | 不重复做完整监控平台                                      |
| [Homepage](https://github.com/gethomepage/homepage)    | 未装         | 最后再加，只需要统一入口页时                         | 只是入口页，不负责启停服务                                |
| Tailscale                                              | 已安装并接入 | 现在作为管理面私网访问方案                           | 不把管理面板直接暴露公网                                  |
| cloudflared                                            | 已接入       | 需要公网项目入口时                                   | named tunnel 必须配合 Cloudflare Access                   |
| frp                                                    | 未安装       | 如果需要公开演示，再单独实现 VPS 配置                | 不在本机假装存在 frpc                                     |
| Ollama                                                 | 本机已运行   | 继续补模型/任务 API                                  | 不把 11434 直接暴露公网                                   |
| ComfyUI                                                | 本机已运行   | 继续补队列/历史 API                                  | 不让 Docker 版本替代原生 MPS 运行                         |

## 建议新的 Agent 按这个顺序工作

1. 先读取本文件、`docs/architecture.md`、`docs/research/mac-dash.md` 和 `docs/adr/0001-agent-first.md`。
2. 执行 `git status --short`，保留当前未提交改动；先完成 P0，不要重写架构。
3. 执行 `npm run typecheck && npm test && npm run format:check`；改 Rust 时再跑 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
4. 前端已经重做为终端风格：总览、服务、进程、容器、日志、设置。继续改 UI 时保持等宽字体、细线边框、边框式标题、分块柱状图和 2 秒采样；新增面板要么带 `.panel-head h2`，要么直接写 `data-title`，否则边框标题不显示。
5. 下一步优先做 P0：端口/重复启动/YAML 错误提示、token 设置页和完整鉴权。
6. 配置编辑和热加载已完成；接下来做 launchd 发现、cloudflared tunnel、Compose 实测和 Ollama/ComfyUI 控制。
7. 最后做模型服务控制、指标历史、通知、开机启动和发布流程。
8. 每个阶段都要更新本文件的“当前状态”和验收结果；不要只改 README。

## 已知限制和风险

| 限制                                      | 影响                                        | 处理方式                                                     |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `config/services.yaml` 是本机私有文件     | 其他机器没有真实服务登记                    | 提供配置编辑器和示例模板；不提交真实路径和用户信息           |
| 面板保存会重写 YAML                       | 手写注释不会保留；覆盖前原文件在备份目录    | 重要配置先备份；恢复后注释同样来自备份文件                   |
| Compose 项目还没有真实动作证据            | 只能验证单容器启停，不能声称 Compose 已完成 | 找到真实 Compose 项目后实测 up/down/restart/logs             |
| macOS 不能保存任意进程内存快照            | “保存状态”只能保存配置、代码、数据库和备份  | UI 文案必须明确                                              |
| 进程终止只覆盖当前用户                    | 无法结束 root 和其他用户的进程              | 需要更高权限时使用系统工具，不扩大 Agent 权限                |
| 推理进程按命令行和进程树识别              | 特殊启动脚本可能识别不到                    | 优先用服务 PID 和子进程树；后续可加显式启动路径配置          |
| RSS 汇总不等于独占内存                    | 共享内存可能被重复计算                      | 文案标为“内存占用”，不宣称精确独占                           |
| 强制终止可能丢失未保存数据                | SIGKILL 不会给应用收尾机会                  | UI 二次确认，默认先 SIGTERM                                  |
| Agent 依赖桌面 supervisor 运行            | 退出 App 后普通 process 服务不会继续被守护  | 常驻项目交给 launchd；卸载时通过 Tauri 退出 App 并回收 Agent |
| 端口 7227 被其他程序占用                  | Agent 无法启动，面板无法连接                | 桌面端弹窗提示并使用 lsof 排查；不会启动第二个 Agent         |
| 没有请求限流和多用户权限                  | 本机同用户可调用所有 API                    | 远程模式必须配置 Token；多用户场景再引入角色                 |
| 未常驻项目由 Agent 启动                   | Mac 重启后不会自动拉起                      | 项目页“设为常驻”生成 LaunchAgent；卸载会清理这些 LaunchAgent |
| 项目对外访问还没有统一入口                | 端口可看，但公网域名/隧道未绑定             | 后续接 cloudflared/tunnel，并在项目卡片展示入口地址          |
| 自动发现要求工作目录在用户目录且监听 TCP  | 系统目录启动或无端口的进程不会出现          | 特殊项目可用“新增项目服务”手动登记                           |
| release App 还未签名/notarize             | 只能本机开发使用                            | 发布前完成证书、DMG 和升级策略                               |
| 从 `~/Documents` 启动 App 会被 TCC 拦截   | Agent 可能卡在“访问文稿文件夹”权限框        | 验收和日常使用都从 `/Applications` 或 `~/Applications` 启动  |
| 远程绑定需要 token                        | 忘记 token 会无法访问                       | 本机可从 API/UI 读取并复制；远程设备必须粘贴 Token           |
| 项目 Tailnet 入口绕过 StudioOps Token     | 有 tailnet 访问权限的设备可直接访问项目端口 | 项目自身必须登录；Tailscale ACL 限制设备；不要共享整个 Mac   |
| cloudflared named tunnel 未做真实域名联调 | 只能验证命令、配置和 quick tunnel           | 配置 Cloudflare 域名后补测 named tunnel + Access             |
| 告警活动状态只在内存                      | Agent 重启后 active 状态会重新评估          | 告警历史写入 SQLite；后续可持久化 active 状态和静默窗口      |
| StudioOps 不会随登录自动启动              | Mac 重启后 tailnet 入口在但 Agent 未运行    | 后续加入开机启动/登录项；当前需打开一次 App                  |
