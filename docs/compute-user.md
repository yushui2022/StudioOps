# Compute 用户：隔离、审计与训练

StudioOps 的「算力」视图用于管理一个独立的标准用户（默认 `compute`），让朋友或 CI 任务使用这台 Mac 的计算资源，但不共享主账号。

## 目标

```text
不给主账号
不给管理员权限
不默认开放公网 SSH
文件隔离
登录和进程可审计
训练任务在 macOS 宿主上运行
```

## 先创建标准用户

系统设置 → 用户与群组 → 添加用户：

```text
账号类型: 标准
用户名:   compute
密码:     强密码
不要勾选: 允许用户管理这台电脑
```

不要使用「客人用户」：客人用户退出后会清空主目录，不能作为长期训练账号。

## 收紧主账号主目录

```bash
chmod 700 /Users/orlando
```

否则 `compute` 可能能读取主账号下权限为 `755` 的配置、模型和开发目录。

如果确实需要共享数据，单独建目录：

```bash
mkdir -p /Users/Shared/ai-compute
chmod 755 /Users/Shared/ai-compute
```

只共享这个目录，不共享整个主目录。

## 远程登录方式

### 方式 A：Tailscale SSH（推荐）

不开放公网 22，只允许 tailnet 设备：

```bash
tailscale set --ssh
```

然后在 Tailscale ACL 中允许指定用户登录到 `compute`。例如：

```json
{
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:macstudio"],
      "users": ["compute"]
    }
  ]
}
```

实际 ACL 需要按你的 tailnet 标签和用户调整。StudioOps 只能切换 Tailscale SSH 开关，不能代替你配置 Tailscale ACL。

### 方式 B：macOS Remote Login

系统设置 → 通用 → 共享 → 远程登录：

```text
允许访问: 仅这些用户
选择:     compute
```

如果要通过 Tailscale 访问，仍然应该只让 tailnet 访问，不要把 22 端口映射到公网。

### 方式 C：堡垒机

如果需要会话录制和完整审计，可以接：

- Warpgate
- Teleport Community
- ShellHub

StudioOps 不应该自己实现一个任意命令 SSH 服务。

## StudioOps「算力」视图

当前版本提供：

- compute 用户是否存在
- 是否在 admin 组
- 主目录和权限
- 主账号主目录是否已保护
- 当前登录会话
- 最近登录历史
- compute 进程、CPU、内存、运行时长
- compute 主目录磁盘占用
- macOS Remote Login 状态
- Tailscale SSH 状态
- Tailscale SSH 开关
- 管理操作审计

当前不做：

- 任意命令执行
- 文件级访问审计
- 每条命令记录
- 完整 SSH 会话录制
- 每进程 GPU 占用

## 训练和微调

### 可以在 macOS 宿主上跑

- MLX / MLX-LM
- llama.cpp 微调/转换
- PyTorch MPS
- ComfyUI / MiniMax H3

用 `compute` 登录：

```bash
ssh compute@100.115.137.62
```

然后自己创建虚拟环境、下载模型、运行训练脚本。

### 不建议放进 Linux 容器

Mac 上的 Docker/Colima/Lima 是 Linux 虚拟机，没有 Apple GPU/MPS 透传。因此：

```text
CPU 训练 / CI → 可以放容器或 Linux VM
MLX / MPS 微调 → 必须在 macOS 宿主
```

### 资源限制

macOS 没有 cgroup。给 shell 之后，`compute` 仍然可能占满 CPU/GPU。当前 StudioOps 能做的是展示和告警，不是硬限制。

如果需要强限制：

- CPU/CI：Lima/Colima，限制 VM CPU/内存
- GPU/微调：独立 Mac 或独立 GPU 机器
- 不可信代码：不要给宿主机 shell

## 典型工作流

```text
朋友/CI
  → Tailscale SSH（或 tailnet 内 Remote Login）
  → compute 用户
  → /Users/compute 或 /Users/Shared/ai-compute
  → 运行训练/构建
  → StudioOps 查看会话、进程、CPU/内存、登录历史
```

## 安全边界

- `compute` 不能是管理员
- 不开放公网 22
- 主账号主目录建议 `700`
- 不在面板里执行任意 shell
- Tailscale SSH 开启后仍然需要 ACL 放行
- 训练代码和模型由使用者负责，不要执行不可信脚本
- 需要完整会话录制时用 Warpgate/Teleport，不要自己造
