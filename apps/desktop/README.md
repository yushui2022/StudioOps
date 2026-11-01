# StudioOps Desktop

桌面端计划使用 Tauri 2 包装 `apps/web`，主进程只负责：

- 启动/停止本机 Agent；
- 保存本机 Agent 的连接配置；
- 菜单栏、系统通知和快捷操作；
- 将桌面生命周期事件传给 Web 前端。

release 构建会先把 Agent 打包为 `dist/agent.cjs`，并把它作为 Tauri resource。生产壳启动时由 Rust 进程启动该 Agent，退出时回收子进程；开发模式仍由 `beforeDevCommand` 启动 Agent，便于热重载。

生产模式的可变配置和 SQLite 数据位于 Tauri 的 app data 目录，其中服务清单文件名为 `services.yaml`。开发模式直接读取仓库里的 `config/services.yaml`。

业务逻辑、服务动作和状态订阅全部留在 Agent/API，避免桌面端和浏览器端出现两套控制逻辑。

当前已安装 Rust 1.99.1（Apple Silicon）和 Tauri CLI，并验证 `npm run build` 可以产出 `src-tauri/target/release/studioops-desktop`。后续在这里加入菜单栏、通知和 Agent 生命周期管理。

```bash
cd apps/desktop
npm install
npm run build
```
