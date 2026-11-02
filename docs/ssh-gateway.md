# SSH 网关与短期凭证规划

更新时间：2026-11-02  
状态：待选型，不改变当前直连 SSH 的行为

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
  → Tailscale 私网
  → SSH 网关（Warpgate / Teleport / SSH CA）
       ├─ 身份认证
       ├─ 用户到 compute 的授权
       ├─ 会话审计/录制
       └─ 吊销和过期
  → Mac 回环 sshd
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

推荐拓扑：

```text
Warpgate（Mac 本机，监听 tailnet/回环）
  → 127.0.0.1:22
  → compute
```

或者：

```text
Warpgate（VPS）
  → SSH 反向隧道
  → Mac 127.0.0.1:22
```

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

## 当前决定

- 暂不改变现有直连 SSH
- 先记录方案，等 `compute` 用户和训练流程稳定后再实施
- 优先评估 Warpgate，Teleport 作为后续企业级选项
- 如果只使用少量可信设备，Tailscale ACL + SSH CA 也足够

## 相关文档

- `docs/compute-user.md`
- `docs/tailscale.md`
- `README.md`
- Obsidian：`远程访问与 compute 用户.md`
