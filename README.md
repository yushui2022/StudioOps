<div align="center">

<img src="apps/web/assets/studioops-logo.svg" width="76" alt="StudioOps logo" />

# StudioOps

**A local-first control plane for macOS AI servers.**

把 Ollama、ComfyUI、MiniMax H3 视频、launchd 常驻服务、请求队列和内存保护放进一个本地控制台；可选 VPS 中转，让 Mac 不直接暴露公网。

[![macOS](https://img.shields.io/badge/platform-macOS%2014%2B-black)](https://www.apple.com/macos/)
[![Node](https://img.shields.io/badge/Node.js-22.5%2B-339933)](https://nodejs.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)](https://tauri.app/)
[![Tests](https://img.shields.io/badge/tests-79%20passing-brightgreen)](tests/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

</div>

![StudioOps 总览](docs/assets/overview.png)

<p align="center">
  <img src="docs/assets/history.png" width="72%" alt="历史指标" />
</p>

<p align="center"><sub>历史：24 小时趋势、最低/平均/最高、时间轴、系统指标与服务运行状态</sub></p>

## 界面截图

<p align="center">
  <img src="docs/assets/gateway.png" width="49%" alt="推理网关" />
  <img src="docs/assets/services.png" width="49%" alt="服务列表" />
</p>

<p align="center"><sub>推理网关：Ollama / ComfyUI / 视频 H3 三个队列与模型调用记录 · 服务：launchd、Bridge 和健康状态</sub></p>

<p align="center">
  <img src="docs/assets/compute.png" width="72%" alt="算力用户审计" />
</p>

<p align="center"><sub>算力用户：独立 compute 标准用户的会话、进程、磁盘、登录历史、SSH 状态和审计</sub></p>

<p align="center">
  <img src="docs/assets/warpgate.png" width="72%" alt="Warpgate SSH 网关状态" />
</p>

<p align="center"><sub>SSH 网关：VPS 2222 入口、目标、连接命令和 macOS 直连 22 状态</sub></p>

> StudioOps 目前是 pre-1.0 项目。它优先解决一台 Mac 上“AI 服务能稳定跑、不会把内存打爆、外部请求能排队”的问题，而不是做一个聊天客户端。

## 项目定位

StudioOps 是给「一台 Mac + 少量用户」用的本地 AI 服务器控制面。

它优先解决运维问题，而不是模型能力：

- 服务是否活着、能否开机自启、崩溃后是否恢复
- 模型请求是否排队、并发是否受控、统一内存会不会被打爆
- 谁能远程登录、做了什么、什么时候调用了哪个模型
- 出问题时能不能看到日志、指标、进程和审计

它不是什么：

- 不是聊天客户端，不提供对话 UI
- 不是模型运行时，Ollama / ComfyUI / H3 仍然由它们自己跑
- 不是云 GPU 平台，模型始终在 Mac 上
- 不是多租户 SaaS
- 不替代公网模型 API；公网入口可以用 VPS + Nginx / Sub2API

适合：

- 一台 Apple Silicon Mac，自己和几个朋友 / CI 用
- 本地跑 Ollama、ComfyUI、MiniMax H3
- 希望 Mac 不直接暴露公网，通过 VPS 做 SSH 和模型 API 中转

## 部署形态

### 形态一：只在本机

Mac 上跑 Agent + Gateway + 模型，全部监听 `127.0.0.1`。  
适合自己用，不需要 VPS。

### 形态二：Mac + VPS 中转（推荐）

VPS 做公网门面，Mac 通过 SSH 反向隧道主动连出去。

```text
朋友 / CI
  │
  ├─ SSH
  │   → VPS:2222
  │   → Warpgate 认证 + 会话录像
  │   → VPS 127.0.0.1:22022
  │   → SSH 反向隧道
  │   → Mac 127.0.0.1:22
  │   → compute
  │
  └─ 模型 API（可选）
      → VPS:443 / Nginx / Sub2API
      → VPS 127.0.0.1:11434 / 8190（H3 需另加 8192）
      → SSH 反向隧道
      → Mac Inference Gateway
      → Ollama / ComfyUI / H3
```

这个形态下：

- Mac 不开放任何入站端口
- VPS 只负责认证、TLS、限流和转发，不跑模型
- 朋友只需要知道 VPS 地址，不需要你的 Mac IP 或 Tailscale
- 吊销访问：在 StudioOps 删除公钥，或在 VPS 撤销 API Key

## 你需要什么

### Mac

| 项目    | 最低                   | 推荐                              |
| ------- | ---------------------- | --------------------------------- |
| 芯片    | Apple Silicon（arm64） | M2 Pro / M3 / M4 / M5             |
| 系统    | macOS 14 Sonoma        | macOS 15+                         |
| 内存    | 32 GB                  | 64 GB 或更高（H3 视频建议 64GB+） |
| 磁盘    | 100 GB 可用            | 300 GB+ 可用                      |
| Node.js | 22.5+（开发/源码运行） | 22 LTS                            |
| 运行时  | Ollama                 | Ollama + ComfyUI + H3             |
| 容器    | 可选                   | Docker Desktop（管理 Compose）    |

还需要：

- 一个标准用户 `compute`，给朋友 / CI 用；不要给管理员权限
- 可选：Tailscale，用于私网访问
- 可选：Docker Desktop，用于容器化服务

### VPS

VPS 只做中转，不需要 GPU，也不需要大内存。

| 项目   | 最低                     | 推荐           | 说明                 |
| ------ | ------------------------ | -------------- | -------------------- |
| CPU    | 1 vCPU                   | 2 vCPU         | Warpgate + Nginx     |
| 内存   | 1 GB                     | 2 GB           | 不跑模型             |
| 磁盘   | 10 GB                    | 20 GB          | 镜像、日志、会话录像 |
| 系统   | Debian 12 / Ubuntu 22.04 | Debian 12      | x86_64 或 arm64      |
| Docker | 24+                      | 29+            | Warpgate 容器        |
| 公网   | IPv4                     | IPv4 + 域名    | 朋友连接             |
| 防火墙 | UFW                      | UFW            | 只放行必要端口       |
| 带宽   | 按需                     | 视频建议大流量 | H3 视频文件较大      |

补充：

- 位置：建议选离朋友较近、到 Mac 上行稳定的节点；模型仍在 Mac 上跑，VPS 只增加网络延迟
- 域名：SSH 不需要域名；如果要用 HTTPS 暴露模型 API，建议一个子域名 + Let's Encrypt
- Warpgate 需要先做一次初始化（数据目录、监听地址、管理台密码），完整命令见 [SSH 网关](docs/ssh-gateway.md)

端口规划：

| 端口                    | 位置     | 用途                        | 是否公网 |
| ----------------------- | -------- | --------------------------- | -------- |
| `2222/tcp`              | VPS      | Warpgate SSH 入口           | 是       |
| `443/tcp`               | VPS      | 模型 API / 现有站点（可选） | 可选     |
| `22/tcp`                | VPS      | 管理员 SSH                  | 建议限制 |
| `8888`                  | VPS 回环 | Warpgate 管理台             | 否       |
| `22022`                 | VPS 回环 | 反向隧道到 Mac 22           | 否       |
| `11434`                 | VPS 回环 | 反向隧道到 Ollama Gateway   | 否       |
| `8190`                  | VPS 回环 | 反向隧道到 ComfyUI Gateway  | 否       |
| `8192`                  | VPS 回环 | H3 视频（需另加隧道）       | 否       |
| `7227`                  | Mac 回环 | StudioOps Agent             | 否       |
| `11435/8191/8192/11436` | Mac 回环 | Inference Gateway           | 否       |
| `22`                    | Mac 回环 | sshd（只给反向隧道）        | 否       |

VPS 上建议安装：

- Docker（Warpgate）
- 可选：Nginx / Caddy（模型 API 反向代理、TLS）
- 可选：Sub2API（如果已经有用户 / Key / 配额体系）
- UFW（只放行 2222、443 和管理 SSH）

VPS 不需要：

- GPU
- 模型文件
- 大内存
- 把 Mac 的 `22`、`7227`、`11434`、`8190`、`8192` 直接映射到公网

### 组件放在哪里

| 组件                  | 位置      | 作用                            |
| --------------------- | --------- | ------------------------------- |
| Warpgate              | VPS       | SSH 认证、会话录像、目标转发    |
| Nginx / Sub2API       | VPS       | 模型 API 公网入口、TLS、API Key |
| SSH 反向隧道          | Mac → VPS | 把 VPS 回环端口映射到 Mac       |
| StudioOps Agent       | Mac       | 控制面：服务、审计、配置        |
| Inference Gateway     | Mac       | 队列、并发、超时、内存准入      |
| Ollama / ComfyUI / H3 | Mac       | 真正的模型推理                  |

## 为什么做 StudioOps

在 Mac 上跑本地 AI，常见状态是：

- Ollama、ComfyUI、Compose 项目和各种脚本散落在多个终端里
- 服务没有统一的开机启动、崩溃恢复、日志和健康检查
- 外部请求直接打模型端口，没有队列、并发限制和超时
- Ollama 和 ComfyUI 同时加载大模型，把统一内存和 swap 打满
- 远程访问靠临时 SSH 隧道，缺少审计和安全边界
- 出问题只能看进程列表，不知道是谁、什么时候、调用了哪个模型

StudioOps 把这些事情收进一个 macOS 原生控制台：

```text
服务生命周期 + AI 运行时 + 请求网关 + 内存准入 + 可观测性 + 私网访问
```

## 主要能力

### 服务控制面

- 统一管理 `launchd`、普通进程、Docker Compose、cloudflared
- 启动 / 停止 / 重启 / 暂停 / 恢复，动作白名单约束
- 开机启动、KeepAlive、崩溃恢复、日志和健康检查
- 项目服务可生成独立 LaunchAgent
- 进程身份持久化，Agent 重启后仍能识别原进程
- 配置写入前校验、自动备份、热加载和回滚

### AI 运行时与内存保护

- Ollama 模型列表、加载/卸载、VRAM、内存占用和到期时间
- ComfyUI 队列、历史、MPS VRAM、中断和取消
- 读取 macOS `vm_stat`，按推理预算和系统保留线做准入
- Ollama 模型槽位限制，空闲模型自动卸载
- ComfyUI 图片和 H3 视频分别设置可用内存门槛
- 内存紧张时拒绝新任务，而不是让系统进入 OOM

### Inference Gateway

外部请求不再直接访问模型端口：

```text
Ollama:       11435 → 11434
ComfyUI 图片: 8191  → 8190
H3 视频:      8192  → 8193 → 8188
管理 API:     11436
```

- 每个后端独立的并发、队列上限、排队超时和请求超时
- 队列满返回 `429`，内存不足返回 `503`
- 客户端断开时取消排队或中止上游
- 支持流式响应，不缓冲完整模型输出
- 持久化模型调用记录：模型、后端、状态、耗时、来源
- 默认不记录 prompt、请求体或 Authorization

### 可观测性

- 2 秒系统指标、5 秒服务状态 WebSocket 推送
- SQLite 指标历史：5 分钟 / 1 小时 / 24 小时
- 服务掉线、操作失败、内存、磁盘、温度告警
- 实时日志流、搜索、错误高亮和轮转重置
- 操作审计，记录 actor 和 Tailscale 远程身份
- 公网入站/出站连接世界地图，不抓包

### 远程访问与安全

- 所有服务默认只监听 `127.0.0.1`
- 非回环访问默认要求 Bearer Token；不要把 Agent 端口暴露到公网
- Tailscale Serve 只对 tailnet 开放，不启用 Funnel
- 项目可以单独开放 Tailnet 入口
- 安全审计检查敏感端口、Funnel、Token 和 ACL 风险
- 服务目标来自受控 YAML，不接受网页提交任意 shell 或路径
- 算力用户：独立 `compute` 标准用户的会话、进程、磁盘、登录历史、Tailscale SSH 状态和审计
- SSH 网关：Warpgate 在 VPS 2222，Mac sshd 仅回环；StudioOps 可直接添加/删除 `compute-guest` 公钥，并生成可复制的使用说明

### 桌面体验

- Tauri 2 原生窗口，关闭后保留菜单栏
- Agent 异常退出自动重启
- 单实例、启动错误弹窗、配置错误横幅
- 终端风格面板，`1–8` 切视图、`r` 刷新、`/` 搜索、`Esc` 关闭
- 一张面板里同时看服务、模型、队列、日志、指标和历史

## 本机组件

```text
┌──────────────────────┐      ┌──────────────────────┐
│ Tauri 2 desktop      │      │ Browser / Tailnet    │
│ 主入口 / 菜单栏       │      │ Web companion        │
└──────────┬───────────┘      └──────────┬───────────┘
           └──────────────┬──────────────┘
                          ▼
              ┌────────────────────────┐
              │ Local Agent            │
              │ Hono API + WebSocket   │
              │ auth / audit / registry│
              └────────────┬───────────┘
                           ▼
       ┌────────────┬────────────┬────────────┬────────────┐
       │ launchd    │ Docker     │ AI         │ Tunnel     │
       │ adapter    │ adapter    │ runtime    │ adapter    │
       └────────────┴────────────┴────────────┴────────────┘
```

外部推理流量：

```text
朋友 / Sub2API
  → VPS（可选）
  → SSH 反向隧道 / Tailscale
  → Inference Gateway（队列、并发、超时、内存准入）
  → Ollama 11434 / ComfyUI 8188 / H3 Video Bridge 8193
```

Agent 和 Gateway 都只监听 `127.0.0.1`；远程访问由 VPS 中转，不在 Mac 上开公网端口。

## 快速开始

### 环境要求

- 一台 Apple Silicon Mac（macOS 14+），配置建议见「你需要什么 → Mac」
- Node.js **22.5+** 和 npm（源码运行；Agent 使用内置 `node:sqlite`）
- 可选：Rust / Tauri 2 工具链（构建桌面 App）
- 可选：Ollama、ComfyUI、Docker Desktop
- 可选：一台 Linux VPS（远程 SSH / 模型 API 中转），配置见「你需要什么 → VPS」

### 启动 Web 控制台

```bash
npm install
cp config/services.example.yaml config/services.yaml
npm run dev
```

打开 <http://127.0.0.1:7227>。

`config/services.yaml` 是本机私有配置，已经被 `.gitignore` 忽略。不要提交真实路径、Token 或账号信息。

### 构建桌面 App

```bash
npm --prefix apps/desktop install
npm run desktop:dev
# 或
npm run desktop:build
```

构建产物默认在：

```text
apps/desktop/src-tauri/target/release/bundle/macos/StudioOps.app
```

构建前会同时打包 Agent 和 Gateway：

```bash
npm run build:services
```

### 加 VPS 远程访问（可选）

最小步骤：

1. VPS 安装 Docker，运行 Warpgate：
   - SSH 监听 `0.0.0.0:2222`
   - 管理台监听 `127.0.0.1:8888`
   - 数据目录持久化
   - 开启会话录像
2. 在 Warpgate 里创建目标 `mac-compute`：
   - host `127.0.0.1`
   - port `22022`
   - username `compute`
   - auth `PublicKey`
3. 在 Mac 上建立反向隧道（`scripts/ollama-tunnel` 已包含这些默认转发；默认读取 `~/.ssh/config` 的 `Host vps`，没有就设置 `TUNNEL_HOST=user@server`）：

   ```bash
   ssh -N \
     -R 127.0.0.1:22022:127.0.0.1:22 \
     -R 127.0.0.1:11434:127.0.0.1:11435 \
     -R 127.0.0.1:8190:127.0.0.1:8191 \
     -L 127.0.0.1:18888:127.0.0.1:8888 \
     vps
   ```

4. 把 Mac 的 sshd 收紧到回环：

   ```bash
   sudo bash scripts/ssh-loopback-mode.sh gateway
   ```

5. 在 StudioOps「算力 → SSH 网关 → 访问公钥」添加朋友的公钥。
6. 测试：

   ```bash
   ssh -p 2222 compute-guest:mac-compute@VPS_IP
   ```

详细说明和回滚方式见 [SSH 网关](docs/ssh-gateway.md)。

### 模型 API 对外（可选）

如果朋友需要调用 Ollama / ComfyUI / H3，不要让 Mac 直接开公网端口。推荐：

```text
朋友 → VPS:443 → Nginx / Sub2API → VPS 127.0.0.1:11434/8190
  → SSH 反向隧道 → Mac Gateway → Ollama/ComfyUI/H3
```

- VPS 只做 TLS、API Key、限流和转发
- Mac Gateway 继续做队列、并发和内存准入
- 不要把 `11434`、`8190`、`8192`、`7227`、`8888` 直接暴露到公网
- H3 视频当前只监听本机，尚未自动映射到 VPS；需要时再加 `8192` 隧道

## 配置示例

```yaml
services:
  - id: ollama
    name: Ollama
    kind: ollama
    adapter: launchd
    target: gui/501/ai.local.ollama
    allowedActions: [start, stop, restart]
    health:
      type: http
      endpoint: http://127.0.0.1:11434/api/tags

  - id: comfyui
    name: ComfyUI
    kind: comfyui
    adapter: launchd
    target: gui/501/ai.local.comfyui
    allowedActions: [start, stop, restart]
    health:
      type: http
      endpoint: http://127.0.0.1:8188/system_stats
```

支持的适配器：

```text
launchd / process / docker-compose / cloudflared
```

支持的 `kind`：

```text
ollama / comfyui / process / launchd / docker-compose / tunnel / generic
```

完整字段和模板见 `config/services.example.yaml`。

## Inference Gateway

Gateway 是独立 LaunchAgent，不依赖桌面 App 是否打开。

### 默认策略

| 后端         |  端口 | 并发 | 队列 | 排队超时 | 请求超时 | 请求体 |
| ------------ | ----: | ---: | ---: | -------: | -------: | -----: |
| Ollama       | 11435 |    2 |    8 |      60s |    10min |    4MB |
| ComfyUI 图片 |  8191 |    1 |    8 |    30min |    30min |   32MB |
| H3 视频      |  8192 |    1 |    8 |    30min |    60min |    2MB |

### 状态与记录

```bash
curl http://127.0.0.1:11436/health
curl http://127.0.0.1:11436/status
curl 'http://127.0.0.1:11436/records?limit=50'
```

模型调用记录默认写入：

```text
~/Library/Application Support/com.studioops.desktop/gateway/model-calls.jsonl
```

记录字段：

```text
模型 / 后端 / 状态 / 方法 / 路径 / 来源
状态码 / 等待时间 / 执行耗时 / 错误
```

不会写入 prompt、messages、图片、请求体或 Authorization。

### 内存准入

Gateway 会读取：

- macOS `vm_stat` 的 active + wired + compressed
- Ollama `/api/ps` 当前已加载模型
- 当前 Gateway 活跃任务

默认策略：

```text
推理预算：总内存 - 12GB
硬性安全线：至少 2GB 可用
Ollama：最多 1 个已加载模型
ComfyUI：至少 24GB 可用
H3 视频：至少 30GB 可用
```

内存不够时，新任务返回 `503`，不会先加载模型再失败。

## ComfyUI 与 H3 视频（可选）

StudioOps 可以只做服务器控制，不要求安装 ComfyUI/H3。需要图片或视频时再接入。

- ComfyUI 图片桥：`scripts/comfy_openai_bridge.py`
- H3 视频桥：`scripts/comfy_video_bridge.py`
- H3 验证和实测数据：`docs/minimax-h3.md`

H3 模型文件不随仓库分发。64GB M5 Max 实测：

```text
864×480 / 5 秒 / 4 步:     225 秒
864×480 / 10 秒 / 4 步:    505 秒
1344×768 / 5 秒 / 4 步:    681 秒
```

视频入口目前只监听本机，不会自动暴露到公网。

## 安全模型

- Agent、Gateway 和模型端口默认全部绑定 `127.0.0.1`
- 非回环访问默认要求 Bearer Token；Token 文件权限 `0600`
- StudioOps 相关入口只公开 `2222` 和可选的 `443`；管理台 `8888`、隧道 `22022/11434/8190/8192` 只绑回环
- Mac 的 sshd 只监听 `127.0.0.1:22`；远程 SSH 必须先过 Warpgate
- Warpgate 做公钥认证和会话录像；删除公钥即吊销
- Tailscale Serve 只开放给 tailnet，不启用 Funnel
- 所有服务动作经过适配器和白名单
- 客户端不能提交任意 shell、路径或 launchd label
- Gateway 只保存请求元数据，不保存 prompt
- 证书、私钥、`.env`、SQLite、日志和本机 `services.yaml` 不进入 Git

> 不要把 Agent 的 `7227` 暴露到公网。Agent 的远程鉴权正在从 Host 头判断迁移到真实 socket 来源；完成前只通过本机或 VPS 回环访问。

> 如果你发现安全问题，请不要开公开 issue，先通过仓库维护者私下联系。详见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm run typecheck
npm test
npm run format:check

# Rust 测试
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

当前测试：**79 个 TypeScript 测试**，覆盖配置、适配器、鉴权、告警、指标、网络地图和 Gateway 队列/内存准入。

### 目录

```text
services/agent      本机控制层：HTTP API、WebSocket、适配器、服务注册表
services/gateway    Inference Gateway：代理、队列、内存准入、模型调用记录
packages/contracts  Agent / Web / Desktop 共用契约
apps/web            终端风格 Web 控制台
apps/desktop        Tauri 2 桌面壳
docs                架构、网关、H3、Tailscale、卸载和交接文档
scripts             安装/卸载、隧道、ComfyUI/H3 桥
tests               TypeScript 测试
```

### 提交前检查

```bash
npm run typecheck
npm test
npm run format:check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 当前限制

- 仅支持 macOS；Linux/Windows 不在当前范围内
- macOS 没有 cgroup 式硬内存限制，内存保护是应用层准入
- H3 视频模型需要数十 GB 内存和数分钟到数十分钟生成时间
- Gateway 的按用户 API Key、配额和限流还未完成
- VPS 模型 API 入口需要自行配置 Nginx / Sub2API；仓库不包含公网用户体系
- H3 视频入口尚未映射到 VPS
- Agent 远程鉴权仍在加固，不要把 `7227` 暴露到公网
- CI 目前只构建 DMG，没有自动跑测试；代码签名、公证和自动更新未完成
- 模型文件、真实 `services.yaml`、证书和日志都不在仓库中
- pre-1.0，配置和 API 仍可能变化

## Roadmap

- [ ] Gateway API Key、配额和每用户限流
- [ ] VPS 模型 API 入口（Nginx/Sub2API + Key/配额）
- [ ] 按模型大小做加载前内存预估
- [ ] Gateway / SSH 隧道健康告警
- [x] SSH 网关（Warpgate）：VPS 2222 认证和会话录制，Mac 仅回环 sshd
- [ ] H3 视频对外映射
- [ ] Agent 鉴权改为真实 socket 来源 + `timingSafeEqual`
- [ ] CI 自动跑测试、签名、公证和自动更新
- [ ] 数据与配置统一备份

## 贡献

欢迎 issue 和 PR。

- 修改前先看 `docs/architecture.md` 和 `docs/agent-handoff.md`
- 不要提交真实 Token、证书、私钥、模型路径或本机日志
- 新增服务动作必须经过适配器和白名单
- 新增 UI 面板保持终端风格：等宽字体、细线边框、`data-title` 边框标题
- 提交前跑完上面的检查命令

## License

[MIT](LICENSE) © 2026 StudioOps contributors

## 文档

- [技术架构](docs/architecture.md)
- [Inference Gateway](docs/inference-gateway.md)
- [MiniMax H3 本地验证](docs/minimax-h3.md)
- [Tailscale 私网访问](docs/tailscale.md)
- [cloudflared](docs/cloudflared.md)
- [网络地图与隐私边界](docs/network-map.md)
- [卸载与恢复](docs/uninstall.md)
- [算力用户与审计](docs/compute-user.md)
- [SSH 网关（Warpgate / VPS 中转）](docs/ssh-gateway.md)
- [开发交接](docs/agent-handoff.md)

## Acknowledgements

StudioOps 的架构和取舍受这些项目和社区工作影响：

- [mac-dash](https://github.com/talhaorak/mac-dash)：macOS 系统面板和 launchd 管理
- [macmon](https://github.com/vladkens/macmon)：Apple Silicon GPU/ANE/功耗/温度
- [Ollama](https://ollama.com/) 与 [ComfyUI](https://www.comfy.org/)：本地模型运行时
- [MiniMax H3](https://github.com/MiniMax-AI/MiniMax-H3)：开源全模态视频模型
- [llama-swap](https://github.com/mostlygeek/llama-swap) / [LiteLLM](https://www.litellm.ai/)：本地模型切换和 AI Gateway 的参考
- [Off Grid AI Desktop](https://github.com/off-grid-ai/OGAD)：本地 AI Gateway 和团队 Key 的参考

StudioOps 自身是一个独立项目，不隶属于上述项目。
