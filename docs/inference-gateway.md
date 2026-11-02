# 推理网关与内存准入

StudioOps Inference Gateway 是 Ollama / ComfyUI 前面的本机反向代理。外部请求不再直接访问模型端口，而是先经过网关队列、并发限制和内存准入，再由网关转发到真实服务。

## 链路

```text
朋友 / Sub2API
  → 香港 VPS 127.0.0.1:11434（Ollama）或 :8190（ComfyUI 桥）
  → SSH 反向隧道
  → 上海 Mac 127.0.0.1:11435 / 127.0.0.1:8191
  → StudioOps Inference Gateway
       ├─ 队列 / 并发
       ├─ 排队超时 / 请求超时 / 取消
       ├─ 内存准入 / 模型槽位
       └─ 请求元数据审计（不记录 prompt）
  → 127.0.0.1:11434 Ollama / 127.0.0.1:8190 ComfyUI 桥
```

模型端口 `11434` 和 `8190` 仍然只监听回环，不暴露到公网。SSH 隧道只映射到网关端口。

## 端口

| 端口    | 用途                                           | 监听        |
| ------- | ---------------------------------------------- | ----------- |
| `11435` | Ollama 外部入口                                | `127.0.0.1` |
| `8191`  | ComfyUI 外部入口                               | `127.0.0.1` |
| `11436` | 网关管理 API（`/health`、`/status`、取消排队） | `127.0.0.1` |
| `11434` | Ollama 真实上游                                | `127.0.0.1` |
| `8190`  | ComfyUI 桥真实上游                             | `127.0.0.1` |

## 默认策略

| 项目       | Ollama  | ComfyUI |
| ---------- | ------- | ------- |
| 并发       | `2`     | `1`     |
| 队列上限   | `8`     | `8`     |
| 排队超时   | `60s`   | `60s`   |
| 请求超时   | `10min` | `10min` |
| 请求体上限 | `4MB`   | `4MB`   |

队列满返回 `429` + `Retry-After: 15`。排队超时、内存准入失败返回 `503` + `Retry-After: 30`。客户端断开时，排队中的请求会移除，执行中的上游请求会中止。

## 内存准入

macOS 没有 Linux cgroup 那样的硬内存限制，所以网关在应用层做准入：

- 每 2 秒用 `vm_stat` 读取系统已用内存（active + wired + compressed）。
- 默认给推理预留 `52GB`，给系统保留 `12GB`；已用内存达到预算时拒绝新的模型请求。
- 每 5 秒读取 Ollama `/api/ps`，默认最多加载 `1` 个模型。
- 请求新模型而槽位已满时，网关会尝试卸载没有正在执行请求的空闲模型；卸载失败才拒绝。
- 只对会分配模型的请求做准入：Ollama 的 `POST /api/generate|chat|embed|embeddings|pull|create|copy` 和 OpenAI 兼容路径 `POST /v1/chat/completions|completions|embeddings`，ComfyUI 的 `POST /prompt|api/prompt|queue|v1/images/generations`。`/api/tags`、`/api/ps`、状态查询始终放行。

## 模型调用记录

网关把每次模型调用写入 append-only JSONL：

```text
~/Library/Application Support/com.studioops.desktop/gateway/model-calls.jsonl
```

记录字段：

```text
时间、模型、后端、状态、方法、路径、来源、状态码、等待、耗时、错误
```

- 只记录有 `model` 的请求，以及 ComfyUI 的 `/prompt`、`/api/prompt`、`/v1/images/generations`。
- 不记录 prompt、消息内容、图片、请求体或 Authorization。
- 文件超过 5MB 时轮转为 `model-calls.jsonl.1`，只保留一份历史。
- 网关管理 API：`GET http://127.0.0.1:11436/records?limit=200`。
- StudioOps API：`GET /api/gateway/records?limit=200`。
- 推理网关视图会显示最近 200 条记录，可按模型、路径、来源或状态筛选，并给出成功/异常/平均耗时。

## 环境变量

| 变量                                     | 默认值                  |
| ---------------------------------------- | ----------------------- |
| `STUDIOOPS_GATEWAY_OLLAMA_PORT`          | `11435`                 |
| `STUDIOOPS_GATEWAY_COMFY_PORT`           | `8191`                  |
| `STUDIOOPS_GATEWAY_ADMIN_PORT`           | `11436`                 |
| `STUDIOOPS_GATEWAY_OLLAMA_CONCURRENCY`   | `2`                     |
| `STUDIOOPS_GATEWAY_COMFY_CONCURRENCY`    | `1`                     |
| `STUDIOOPS_GATEWAY_OLLAMA_QUEUE`         | `8`                     |
| `STUDIOOPS_GATEWAY_COMFY_QUEUE`          | `8`                     |
| `STUDIOOPS_GATEWAY_QUEUE_TIMEOUT_MS`     | `60000`                 |
| `STUDIOOPS_GATEWAY_REQUEST_TIMEOUT_MS`   | `600000`                |
| `STUDIOOPS_GATEWAY_MAX_BODY_BYTES`       | `4194304`               |
| `STUDIOOPS_GATEWAY_MEMORY_BUDGET_BYTES`  | 总内存 − 保留           |
| `STUDIOOPS_GATEWAY_MEMORY_RESERVE_BYTES` | `12884901888`（12 GiB） |
| `STUDIOOPS_GATEWAY_MAX_LOADED_MODELS`    | `1`                     |

## 常驻与更新

网关由独立 LaunchAgent 守护：

```text
~/Library/LaunchAgents/com.studioops.inference-gateway.plist
~/Library/Application Support/com.studioops.desktop/gateway/gateway.cjs
~/Library/Application Support/com.studioops.desktop/logs/gateway.log
~/Library/Application Support/com.studioops.desktop/logs/gateway.err
```

`KeepAlive` 和 `RunAtLoad` 都开启，App 退出后网关仍然运行。桌面 App 启动时会把 bundle 内的 `gateway.cjs` 与数据目录中的副本比较，内容变化时自动重装并重启 LaunchAgent。

设置页之外也可以在“推理网关”视图查看运行状态、队列、最近请求和内存准入，并执行安装、重启、卸载和取消排队请求。

## SSH 隧道

```bash
# ~/.local/bin/ollama-tunnel
FORWARDS="11434:11435 8190:8191"
```

VPS 侧仍使用原来的 `127.0.0.1:11434` 和 `127.0.0.1:8190`，Sub2API 不需要改地址。VPS 上的 `ollama-docker-bridge.py` 把 Docker 网桥 `172.20.0.1` 转发到宿主机回环，因此容器也会经过网关。

## 验证

```bash
curl -s http://127.0.0.1:11436/health
curl -s http://127.0.0.1:11436/status
curl -s http://127.0.0.1:11435/api/tags
```

VPS 侧：

```bash
ssh vps 'curl -s http://172.20.0.1:11434/api/tags'
```

真实环境已用 Sub2API 的 `/v1/chat/completions` 验证：请求经过 VPS、SSH 隧道、网关后由 Ollama 返回，网关记录 `POST /v1/chat/completions` 和耗时，不记录 prompt。
