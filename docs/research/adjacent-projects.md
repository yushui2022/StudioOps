# 可复用的成熟项目边界

StudioOps 的目标是集成面板，因此不把所有能力重新实现一遍。下面是“借鉴架构或作为数据源”的边界：

| 项目                                                   | 适合复用的部分                                      | StudioOps 的关系                                     |
| ------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------- |
| [mac-dash](https://github.com/talhaorak/mac-dash)      | macOS launchd、进程、日志、系统状态、插件、Tauri 壳 | 核心 Agent/API 和插件边界的主要参考                  |
| [Dockge](https://github.com/louislam/dockge)           | Compose 项目目录、启停、日志和更新的交互            | 只复用 Compose 项目模型，接入 `DockerComposeAdapter` |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | HTTP/TCP/关键词探测、通知渠道                       | 作为外部告警系统或后续探测数据源，不当作控制层       |
| [Netdata](https://github.com/netdata/netdata)          | 主机、容器和长期指标采集                            | 可选外部指标源；Agent 只保留面板需要的轻量快照       |
| [OliveTin](https://github.com/OliveTin/OliveTin)       | 固定脚本按钮、参数限制和执行日志                    | 只借鉴“动作白名单”思想，不让它成为统一状态模型       |
| [Homepage](https://github.com/gethomepage/homepage)    | 服务入口和链接导航                                  | 不是控制层；StudioOps 自己提供服务卡片和操作         |

## 为什么不直接拼成多个后台页面

这些项目各自解决一个问题：容器项目、告警、指标或入口导航。它们没有共同的服务 id、权限策略、操作审计和桌面生命周期。StudioOps 先统一这些边界，再通过适配器接入它们，用户最终只操作桌面 App 或一个 Web 页面。

## 选择标准

- 能否在本机运行并以稳定 API/CLI 查询状态。
- 能否把动作限制在已登记的服务目标上。
- 是否允许保留本地配置和数据，避免服务绑定云端。
- 是否能在桌面端退出后继续由 launchd 或 Docker 独立运行。
