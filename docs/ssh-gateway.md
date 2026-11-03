# SSH 网关与短期凭证规划

更新时间：2026-11-02  
状态：Warpgate 已迁移到香港 VPS；Mac sshd 仅监听回环，直连 22 已关闭

## 背景

当前允许外部用户以 `compute` 标准用户 SSH 登录这台 Mac。访问路径是：

```text
朋友 / CI
  → Tailscale
  → macOS Remote Login / sshd
  → compute 用户
```

问题是：

- SSH 不经过 StudioOps
- StudioOps 只能事后看到登录历史和进程
- 没有会话录制、短期凭证、统一吊销
- macOS Remote Login 一旦开启，sshd 可能监听所有网卡
- `compute` 的密码或公钥一旦泄露，无法在 StudioOps 里吊销

所以后续考虑增加 SSH 网关，让所有 SSH 先经过认证和审计。

## 目标架构

```text
朋友 / CI
  → VPS 156.239.2.231:2222
  → Warpgate 认证、授权、会话录制
  → VPS 127.0.0.1:22022
  → SSH 反向隧道（Mac 主动连出 VPS）
  → Mac 127.0.0.1:22（仅回环 sshd）
  → compute 用户
```

目标：

- Mac 的 22 端口只监听 `127.0.0.1`，不直接对 LAN/Tailnet 开放
- 所有 SSH 用户先经过网关
- `compute` 只是目标账号，不直接持有长期密钥
- StudioOps 只展示网关健康、会话数、最近认证事件
- 不在 StudioOps 里实现 SSH 协议或任意命令执行

## 方案 A：Warpgate（优先候选）

Warpgate 是轻量开源堡垒机：

- SSH / HTTPS / MySQL / PostgreSQL / RDP / VNC
- 单二进制
- Web 管理台
- 会话录制
- 标准 SSH 客户端即可
- 不需要在目标机器安装专用 Agent

推荐拓扑（已采用）：

```text
Warpgate（香港 VPS，公网 2222）
  → SSH 反向隧道
  → Mac 127.0.0.1:22
  → compute
```

Mac 本机 PoC 保留数据作为回退，但不再是主路径。

建议先在本机或 VPS 做 PoC，确认：

- 能用标准 `ssh` 连接
- 只允许 `compute`
- 有会话录制
- 不开放公网 22
- StudioOps 可以读取健康状态

## 方案 B：Teleport Community

Teleport 更完整：

- 短期证书
- RBAC
- 审计
- 会话录制
- SSH / Kubernetes / 数据库 / Web 应用

代价：

- 组件更多
- 部署和证书管理更复杂
- 对单台 Mac 来说偏重

适合以后有多用户、多机器、需要企业级审计时再上。

## 方案 C：Tailscale ACL + 短期凭证

不引入完整堡垒机，使用：

- Tailscale ACL 限制谁能访问 `compute`
- SSH CA（如 Smallstep / step-ca）签发短期 SSH 证书
- macOS sshd 只监听回环或 Tailscale IP
- StudioOps 只展示 Tailscale/SSH 状态

优点：

- 组件少
- 和现有 Tailscale 结合好

限制：

- macOS GUI 版 Tailscale 不支持 Tailscale SSH 服务器
- 需要自己管理 SSH CA 和证书签发
- 没有开箱即用的会话录制

## 分阶段计划

### P0：收紧当前直连

- `chmod 700 /Users/orlando`
- `compute` 保持标准用户
- macOS Remote Login 只允许 `compute`
- 不把 22 端口映射到公网
- 评估 sshd 是否只监听回环
- StudioOps 继续显示 compute 会话/进程/登录历史

### P1：Warpgate PoC

- 在本机或 VPS 部署 Warpgate
- 目标设为 `127.0.0.1:22` 的 `compute`
- 使用标准 SSH 客户端验证
- 开启会话录制
- 关闭直接 SSH 入口
- StudioOps 增加「SSH 网关」状态卡

### P2：接入 StudioOps

新增只读网关状态：

```text
网关运行状态
版本
监听地址
活跃会话数
最近认证成功/失败
最近会话录制
证书/密钥过期提醒
```

不在 StudioOps 内实现：

- SSH 协议
- 任意命令执行
- 会话内容解析
- 用户密码管理

### P3：多用户和短期凭证

- 每个用户独立身份
- 网关签发短期 SSH 证书
- 到期自动失效
- 支持吊销
- StudioOps 展示身份和审计，不保存私钥

## 验收标准

- 外部用户无法直接连接 Mac:22
- 所有 SSH 先经过网关
- 只能登录 `compute`
- 网关有认证、授权和会话录制
- StudioOps 能看网关健康、活跃会话和最近事件
- 关闭 StudioOps 不影响网关本身
- 吊销用户后无法继续登录
- 不在 StudioOps 中保存 SSH 私钥或密码

## 当前部署状态

Warpgate 已迁移到香港 VPS。Mac sshd 仅监听回环，直连 22 已关闭。

```text
VPS:        156.239.2.231（Debian 12 / Docker 29.7.2）
容器:       studioops-warpgate
镜像:       ghcr.io/warp-tech/warpgate:0.30.2
SSH 入口:   156.239.2.231:2222
管理台:     VPS 127.0.0.1:8888（HTTPS，自签证书）
本地转发:   127.0.0.1:18888 → VPS 127.0.0.1:8888
数据目录:   /opt/studioops/warpgate
管理员密码: /opt/studioops/secrets/warpgate-admin-password
外部用户:   compute-guest
目标:       mac-compute → 127.0.0.1:22022 / compute
访问角色:   compute-access
```

Mac 侧：

```text
反向隧道:   VPS 127.0.0.1:22022 → Mac 127.0.0.1:22
sshd:       仅监听 127.0.0.1:22
macOS:      系统 Remote Login 已卸载，仅保留回环 LaunchDaemon
```

已执行 `sudo bash scripts/ssh-loopback-mode.sh gateway`，系统 sshd 被
`launchctl` 卸载并禁用，换成仅回环的 LaunchDaemon
`ai.local.studioops.sshd`。macOS Remote Login 的 `com.apple.access_ssh`
ACL 仍然生效，`compute` 在允许列表中。

### 验证命令

在任意能访问 VPS 的机器上：

```bash
ssh -p 2222 compute-guest:mac-compute@156.239.2.231
```

实测结果：

```text
CONNECTED
compute
/Users/compute
```

Warpgate 日志确认：

- `UserAuthenticated1` 公钥认证成功
- `TargetSessionStarted1` 建立到 `mac-compute`
- `Recording session ...` 生成会话录制
- 录制文件位于 `/opt/studioops/warpgate/recordings/`

确认直连 22 已关闭：

```bash
nc -vz -w 3 100.115.137.62 22   # 应失败
nc -vz -w 3 156.239.2.231 22    # VPS 自己的 sshd，不是 Mac
```

### 管理台访问

管理台只绑定 VPS 回环。通过隧道脚本的本地转发访问：

```bash
curl -k https://127.0.0.1:18888/@warpgate/admin
```

浏览器打开 `https://127.0.0.1:18888/@warpgate/admin`。
管理员密码在 VPS 的 `/opt/studioops/secrets/warpgate-admin-password`，
不要提交到 Git 或发到公开聊天。

### 隧道与常驻

`~/.local/bin/ollama-tunnel` 现在包含：

```text
-R 127.0.0.1:11434:127.0.0.1:11435   推理网关 Ollama
-R 127.0.0.1:8190:127.0.0.1:8191     推理网关 ComfyUI
-R 127.0.0.1:22022:127.0.0.1:22      供 VPS Warpgate 连接 Mac sshd
-L 127.0.0.1:18888:127.0.0.1:8888    本机访问 VPS Warpgate 管理台
```

由系统 LaunchDaemon `ai.local.studioops.tunnel` 常驻（开机自启，不依赖用户登录）。旧的用户级 LaunchAgent 已重命名为 `ai.local.ollama-tunnel.plist.disabled`。

### 回滚

恢复 macOS 直接 SSH：

```bash
sudo bash scripts/ssh-loopback-mode.sh direct
```

这会停止仅回环 sshd、删除 LaunchDaemon，并重新打开 Remote Login。
之后 `100.115.137.62:22` 会再次可直连。

如果只是临时排查，先看状态：

```bash
sudo bash scripts/ssh-loopback-mode.sh status
```

### 给朋友添加公钥

朋友只需要一行公钥，不需要下载 Warpgate 或安装客户端。

1. 朋友生成密钥：`ssh-keygen -t ed25519`
2. 把 `~/.ssh/id_ed25519.pub` 发给你（公钥可以公开，私钥不要发）
3. 在 StudioOps「算力 → SSH 网关 → 访问公钥」：
   - 备注填 `朋友的 MacBook`
   - 粘贴整行 `ssh-ed25519 ...`
   - 点「添加公钥」
4. 朋友连接：

```bash
ssh -i ~/.ssh/id_ed25519 -p 2222 compute-guest:mac-compute@156.239.2.231
```

删除公钥会立即吊销该设备的登录能力。也可以在 Warpgate 管理台
`Config → Users → compute-guest → Public keys` 操作。

不要共享本机测试私钥
`~/Library/Application Support/com.studioops.desktop/warpgate-test-key`。

### StudioOps 如何管理公钥

StudioOps 通过本机 `127.0.0.1:18888` 的转发调用 VPS Warpgate 管理 API，
使用只保存在本机的 API Token：

```text
$STUDIOOPS_DATA_DIR/warpgate-api-token   (mode 600)
```

- 不把 Warpgate 管理员密码写进前端
- Token 通过 Warpgate `/profile/api-tokens` 创建
- 当前 token 标签 `studioops`，有效期 1 年
- 到期或泄露时，在 Warpgate 重新创建 token，替换该文件即可
- Token 拥有管理 API 权限，不要提交到 Git 或发给朋友

StudioOps 只调用用户和公钥相关接口，不实现 SSH 协议，也不保存私钥。

### StudioOps 状态

StudioOps 读取 `$STUDIOOPS_DATA_DIR/warpgate.json`：

```json
{
  "host": "156.239.2.231",
  "sshPort": 2222,
  "adminPort": 18888,
  "container": "studioops-warpgate",
  "target": "mac-compute",
  "user": "compute-guest"
}
```

「算力」页显示 VPS 网关、SSH 入口、管理台、目标、登录用户和连接命令，
并提示 macOS 直连 22 是否仍然开放。

## 当前决定

- 主路径：VPS Warpgate + SSH 反向隧道 + Mac 回环 sshd
- Mac 本机 Warpgate PoC 保留数据作为回退，不再作为主路径
- 不默认开放公网 22；VPS 只放行 2222
- StudioOps 只展示 Warpgate 状态，不实现 SSH 协议
- 如果以后多用户、多机器，再评估 Teleport 或短期 SSH 证书

## 相关文档

- `docs/compute-user.md`
- `docs/tailscale.md`
- `README.md`
- Obsidian：`远程访问与 compute 用户.md`
