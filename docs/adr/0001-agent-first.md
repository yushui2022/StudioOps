# ADR 0001：Agent-first，桌面端和 Web 共用本地控制层

## 状态

Accepted

## 背景

用户需要在一台 Mac 上管理 launchd、Node/Python 项目、Docker、Ollama、ComfyUI 和内网穿透。若桌面端和 Web 各自直接调用系统命令，权限、安全和行为会快速分叉。

## 决策

用一个本地 Agent 作为唯一控制层。Tauri 桌面端和 Web 端只调用同一组 HTTP/WebSocket API；所有服务动作先经过注册表和适配器能力校验。

## 依据

这保留了 mac-dash 源码中已经验证的路线：Hono API、明确的 service id/action 白名单、主题化 WebSocket 推送、插件/路由隔离和 Tauri 2 桌面壳。StudioOps 在此基础上增加跨运行时适配器和持久化状态边界。

## 结果

- 新增服务主要是新增配置或适配器，不需要重复开发桌面和 Web 页面。
- Agent 可以默认只监听回环地址；需要远程访问时再显式打开 token 和隧道。
- 桌面端依赖 Rust/Tauri 工具链，但 Agent 和 Web 可以先独立运行和测试。
