# cloudflared 公网隧道

cloudflared 用来把本机项目暴露到公网。StudioOps 支持三种模式：

| 模式     | 公网地址                       | 适合                       |
| -------- | ------------------------------ | -------------------------- |
| `quick`  | 随机 `trycloudflare.com`       | 临时演示，无身份验证       |
| `config` | Cloudflare 配置的固定域名      | 长期使用，推荐             |
| `token`  | 由 Tunnel token 管理的命名隧道 | 高级配置，需要注入环境变量 |

## quick 模式

```yaml
- id: public-demo
  name: Public Demo
  kind: tunnel
  category: network
  adapter: cloudflared
  target: quick
  port: 3000
  tunnelMode: quick
  logFile: data/logs/public-demo.log
  allowedActions: [start, stop, restart]
```

启动后 StudioOps 会从日志里提取：

```text
https://随机名字.trycloudflare.com
```

注意：

- quick tunnel 是公网可访问的，没有身份验证
- 地址随机且不保证稳定
- 只能用于临时演示，用完立即停止
- 安全审计会把它标记为高风险

## config 模式（推荐）

先在 Cloudflare 创建命名隧道：

```bash
cloudflared tunnel login
cloudflared tunnel create studioops-demo
cloudflared tunnel route dns studioops-demo demo.example.com
```

配置文件示例：

```yaml
tunnel: studioops-demo
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: demo.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

StudioOps 配置：

```yaml
- id: public-demo
  name: Public Demo
  kind: tunnel
  category: network
  adapter: cloudflared
  target: demo
  port: 3000
  tunnelMode: config
  tunnelConfig: ~/.cloudflared/config.yml
  tunnelName: studioops-demo
  publicUrl: https://demo.example.com
  logFile: data/logs/public-demo.log
  allowedActions: [start, stop, restart]
```

named tunnel 不会把 token 写进 `services.yaml`；凭据文件由 cloudflared 自己读取。

## token 模式

```yaml
- id: public-demo
  name: Public Demo
  kind: tunnel
  category: network
  adapter: cloudflared
  target: demo
  tunnelMode: token
  tokenEnv: TUNNEL_TOKEN
  publicUrl: https://demo.example.com
  logFile: data/logs/public-demo.log
  allowedActions: [start, stop, restart]
```

StudioOps 会把环境变量 `TUNNEL_TOKEN` 注入 cloudflared 进程，不把 token 放到命令行或日志里。桌面 App 通常不会继承 Shell 环境变量，因此日常使用更推荐 `config` 模式。

## 安全要求

公网入口必须再加一层身份验证：

- Cloudflare Access：只允许指定邮箱登录
- 或项目自身有登录、Basic Auth、Token
- 不要暴露 StudioOps 管理面板 7227
- 不要暴露 Ollama 11434
- quick tunnel 只用于临时演示
- 固定公网入口优先使用 named tunnel + Cloudflare Access

StudioOps 安全审计会检查：

- cloudflared quick tunnel 是否正在运行
- 公网隧道是否运行
- 已配置但未运行的隧道
- Tailscale Funnel 是否开启

## 查看状态和日志

服务页会显示：

- `running / stopped / error`
- 公网地址
- 最后错误
- 最近 cloudflared 日志

停止服务会回收 cloudflared 子进程和 PID 文件。
