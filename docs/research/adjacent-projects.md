# 可复用的成熟项目边界

StudioOps 的目标是集成面板，因此不把所有能力重新实现一遍。这里记录“什么时候复用、复用什么”，避免把按需项目误当成当前缺口。

## 现在就复用

| 项目                                              | 复用方式                                                                    | 当前状态                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [mac-dash](https://github.com/talhaorak/mac-dash) | 复用 Agent-first、launchd 管理、动作白名单、WebSocket topic、Tauri 壳的架构 | 已按源码结构落地；launchd 管理 Ollama、ComfyUI、Node/Python 项目 |
| [macmon](https://github.com/vladkens/macmon)      | 直接调用 `macmon pipe --samples 1` 读取 Apple Silicon 的 GPU/ANE/功耗/温度  | 已接入系统指标卡片                                               |

## 运维模块调研

指标、告警、日志和备份的候选项目与取舍已经单独整理在 [`ops-monitoring.md`](./ops-monitoring.md)。简短结论：

- 指标继续用 SQLite，不嵌入 Prometheus/VictoriaMetrics
- 告警借鉴 Alertmanager 的去重/分组/抑制和 Netdata 的滞后/延迟，不引入独立服务
- 日志借鉴 Loki 的低基数标签和按流限流，但先做本地有界 ring buffer
- 备份借鉴 Litestream 的快照思路，先使用 SQLite `VACUUM INTO`
- 图表先沿用现有 SVG 风格，uPlot 作为后续性能备选

## 有明确需求再加

| 项目                                                   | 什么时候加                                     | 接入方式                                                        |
| ------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------- |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 有公网服务告警需求时                           | 作为外部告警系统或探测数据源，不当作 StudioOps 控制层           |
| [Dockge](https://github.com/louislam/dockge)           | 只有 Docker 项目较多、需要项目目录和更新交互时 | 复用 Compose 项目模型，仍由 `DockerComposeAdapter` 执行受控动作 |
| [OliveTin](https://github.com/OliveTin/OliveTin)       | 需要把固定脚本做成“按钮层”时                   | 只借鉴固定按钮、参数限制和执行日志；不让它绕过服务注册表和审计  |
| [Netdata](https://github.com/netdata/netdata)          | 需要长期主机/容器指标和图表时                  | 作为可选外部指标源；StudioOps 保留轻量快照                      |
| [Homepage](https://github.com/gethomepage/homepage)    | 最后再加，只需要统一入口页时                   | 只是入口导航，不负责启停服务                                    |

## 为什么不直接拼成多个后台页面

这些项目各自解决一个问题：容器项目、告警、指标或入口导航。它们没有共同的服务 id、权限策略、操作审计和桌面生命周期。StudioOps 先统一这些边界，再通过适配器接入它们，用户最终只操作桌面 App 或一个 Web 页面。

顺序原则：先把 Ollama、ComfyUI 和 Node/Python 原生项目的启停、日志、健康检查做扎实，再按上面的触发条件增加项目。不要为了“看起来集成得多”提前安装 Dockge、Homepage 或 Uptime Kuma。

## 选择标准

- 能否在本机运行并以稳定 API/CLI 查询状态。
- 能否把动作限制在已登记的服务目标上。
- 是否允许保留本地配置和数据，避免服务绑定云端。
- 是否能在桌面端退出后继续由 launchd 或 Docker 独立运行。
