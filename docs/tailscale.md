# Tailscale 私网访问

Tailscale 把 Mac、手机和笔记本放进同一个加密的私有网络（tailnet）。它不会生成公开 URL；只有登录同一 tailnet、并被 ACL 允许的设备才能访问。

StudioOps 使用 **Tailscale Serve** 把本机回环服务开放给 tailnet：

```text
手机 / 笔记本
    │ Tailscale 加密连接
    ▼
Mac 上的 Tailscale
    │ Serve 反向代理
    ▼
StudioOps 127.0.0.1:7227
```

不会使用 Tailscale Funnel，也不会把 Agent 绑定到公网地址。

## 安装和登录

1. 从 <https://tailscale.com/download/mac> 安装 Tailscale，或从 Mac App Store 安装。
2. 在 Mac 上登录 Tailscale 账号。
3. 在手机/笔记本安装 Tailscale，并登录同一账号。
4. 在 Tailscale 管理后台确认：
   - MagicDNS 已启用
   - HTTPS 证书已启用
   - 设备在同一个 tailnet

安装登录后，在 StudioOps 的“设置 → 远程访问 · Tailscale”点“重新检查”。

## 开放 StudioOps

1. 点“生成访问 Token”。
2. Token 会保存在 StudioOps 数据目录的 `api-token` 文件（权限 `0600`），当前浏览器自动保存。
3. 点“仅 Tailnet 开放 StudioOps”。
4. 页面会显示类似地址：

```text
https://studio-mac.example-tailnet.ts.net/
```

其他设备首次打开时：

1. 在 StudioOps 的“设置 → 访问 Token”粘贴同一个 Token。
2. 保存后 HTTP 和 WebSocket 会携带它。
3. 之后就可以通过 tailnet 地址访问。

Token 文件不会进入导出的配置归档。

## 项目入口

项目页的每个项目卡片都可以单独开放 Tailnet 入口：

1. 项目必须有本地 `port`。
2. 点“开放 Tailnet”。
3. StudioOps 会自动选择一个空闲的 HTTPS 端口，从 8443 开始。
4. 项目卡片会显示类似：

```text
https://<your-mac>.<your-tailnet>.ts.net:8443/
```

5. 点“关闭 Tailnet”只移除这个 Serve 入口，本机端口和服务不受影响。

项目的 Tailnet 入口直接代理项目端口，不经过 StudioOps 的 Token 层。因此：

- 只有 tailnet 是网络边界
- 项目自身必须做登录或访问控制
- 不要给不受信任的 tailnet 用户开放项目
- 修改项目本地端口时会清理旧 Serve 入口，避免指向错误端口

## 安全审计

“设置 → 外部访问安全检查”会检查：

- Agent 是否只监听 `127.0.0.1`
- 访问 Token 是否启用
- Tailscale 是否运行
- Funnel 是否被开启
- StudioOps 管理入口是否只对 tailnet 开放
- Ollama `11434` 是否被 Serve/Funnel 暴露
- 项目 Tailnet 入口数量和 Token 绕过风险

高风险项包括：

- Agent 绑定非回环地址但没有 Token
- Tailscale Funnel 开启
- Ollama 11434 被 Tailscale Serve 暴露

Tailscale ACL 无法通过本机 CLI 验证，所以设置页会保留一条提醒：需要到 Tailscale 管理后台确认设备范围。

## 安全边界

- 只对 tailnet 开放，公网无法直接访问
- 不启用 Tailscale Funnel
- Agent 继续监听 `127.0.0.1:7227`
- Tailscale Serve 只代理 7227，不暴露 Ollama 11434 或其他项目端口
- 本机回环和 Tauri 桌面端不要求 Token；通过 Tailscale Serve 进入的请求必须携带 Token
- StudioOps 管理入口有 Token 保护；项目入口依赖项目自身鉴权和 Tailscale ACL
- Tailscale ACL 建议只允许自己的设备访问 Mac
- 不要把 Token 写进 `services.yaml` 或提交到仓库

## 常见问题

| 现象                        | 处理                                                     |
| --------------------------- | -------------------------------------------------------- |
| 显示“Tailscale 未安装”      | 安装 Tailscale 并重新检查                                |
| 显示“未运行”或 `NeedsLogin` | 打开 Tailscale 客户端登录                                |
| 提示 HTTPS 证书未启用       | 在 Tailscale 管理后台启用 HTTPS 证书和 MagicDNS          |
| 提示已有其他 Serve 入口     | 先运行 `tailscale serve status`，清理已有 443 入口后再试 |
| 远程设备 401                | 在远程设备的“设置 → 访问 Token”粘贴 Mac 上生成的 Token   |
| 关闭入口后本机仍可访问      | 预期行为；关闭只影响 Tailscale Serve，本机回环不受影响   |

## 相关命令

```bash
tailscale status
tailscale serve status
tailscale serve status --json
```
