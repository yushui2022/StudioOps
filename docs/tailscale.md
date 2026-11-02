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

## 安全边界

- 只对 tailnet 开放，公网无法直接访问
- 不启用 Tailscale Funnel
- Agent 继续监听 `127.0.0.1:7227`
- Tailscale Serve 只代理 7227，不暴露 Ollama 11434 或其他项目端口
- 本机回环和 Tauri 桌面端不要求 Token；通过 Tailscale Serve 进入的请求必须携带 Token
- 访问 Token 作为 tailnet 之外的第二层保护
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
