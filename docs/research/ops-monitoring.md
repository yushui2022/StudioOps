# 运维模块调研：指标、告警、日志和备份

更新时间：2026-11-02

本文是第三阶段 P0 的前置调研。P0-3.1 已按本文方案实现：SQLite 原始采样 + 1m/1h rollup、5m/1h/24h 查询、历史视图和可配置保留策略。目标是确定哪些成熟项目值得借鉴、哪些不应该直接嵌入，避免 StudioOps 变成一套过重的监控平台。

## 约束

- 单机 macOS，单用户，本地优先
- 已有 `macmon` 读取 Apple Silicon GPU/ANE/功耗/温度
- 已有 `node:sqlite` 和 `EventStore`
- 桌面端是 Tauri，Web 页面和 Agent 都可以复用
- 指标采样不能阻塞实时 WebSocket，也不能无限增长
- 告警不能每 2 秒弹一次，必须有去重、延迟和恢复通知
- 不引入需要长期维护的额外服务进程

## 调研项目

| 项目                                                                     | 可学习的内容                                         | 不直接复用的原因                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| [Stats](https://github.com/exelban/stats)                                | macOS 原生指标采集、模块拆分、菜单栏轻量展示         | Swift 应用，和 StudioOps 的 Agent/Web 架构不同；不复制代码 |
| [macmon](https://github.com/vladkens/macmon)                             | Apple Silicon GPU/ANE/功耗/温度；已经在用            | 只作为采集器，不做存储和告警                               |
| [Prometheus](https://prometheus.io/)                                     | 时间序列模型、保留策略、规则评估、`for` 持续时间     | 单机桌面 App 嵌入完整 TSDB/PromQL 过重                     |
| [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/) | 去重、分组、抑制、静默、恢复通知                     | 没有多实例和多接收端的复杂度，不需要独立服务               |
| [Netdata](https://github.com/netdata/netdata)                            | 每秒采集、健康引擎、滞后阈值、动态延迟、重复通知间隔 | Agent 很重，GPL 代码不适合直接拷贝进 StudioOps             |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma)                   | 单机 SQLite、心跳/重试、通知渠道、状态页             | 独立 Web 服务和监控模型，和现有服务注册表重复              |
| [VictoriaMetrics](https://github.com/VictoriaMetrics/VictoriaMetrics)    | 单二进制、压缩、保留期、rollup/downsample 思路       | 当前数据量远小于需要专用 TSDB 的规模                       |
| [Litestream](https://github.com/benbjohnson/litestream)                  | SQLite WAL、快照 + 增量、恢复路径                    | 不引入常驻复制进程；先使用 SQLite 一致性快照               |
| [Loki](https://grafana.com/oss/loki/)                                    | 低基数标签、日志流、按流限流、不索引全文             | 单机日志量不需要独立日志聚合服务                           |
| [uPlot](https://github.com/leeoniya/uPlot)                               | 轻量时间序列图、Canvas 绘制、客户端抽稀              | 当前 UI 已有 SVG 分块图；先不新增前端依赖，必要时再引入    |

## 结论

### 1. 指标存储用 SQLite，不嵌入 Prometheus/VictoriaMetrics

系统指标约 6 条，服务指标约 10 个服务 × 3-4 条。按 10 秒采样：

- 每天约 10-30 万行
- 30 天原始数据在 SQLite 中仍然可控
- 需要 rollup 和保留策略，但不需要专用 TSDB

建议两级存储：

```text
metric_samples       原始采样，默认 10 秒，保留 7 天
metric_rollups_1m    1 分钟聚合，保留 30 天
metric_rollups_1h    1 小时聚合，保留 365 天
```

查询时按时间范围选择数据源，并限制返回点数：

- 5 分钟：原始点或 10 秒桶，约 30-60 点
- 1 小时：1 分钟桶，约 60 点
- 24 小时：5 分钟或 15 分钟桶，约 96-288 点

前端永远不接收超过约 300 个点，避免 24 小时曲线卡顿。

### 2. 采样循环要和 UI 请求分离

- Agent 内部独立定时器，默认 10 秒
- 单次采样批量写入一个事务
- 写入失败只记录错误，不阻塞 WebSocket
- 采样任务使用递归 `setTimeout`，避免 `setInterval` 堆叠
- 系统样本来自 `getSystemSnapshot()`
- 服务样本来自注册表快照，不额外起 `ps` 扫描

### 3. 告警借鉴 Alertmanager + Netdata，而不是只做阈值判断

最小状态机：

```text
inactive -> pending -> firing -> resolved -> inactive
```

必须有：

- `for` 持续时间：连续 N 秒异常才通知
- 滞后阈值：触发阈值和恢复阈值分离，避免 80%-79% 抖动
- 冷却/重复间隔：同一规则在冷却期内不重复通知
- 去重键：`ruleId + serviceId/target`
- 恢复通知：恢复时只发一次
- 静默：维护期间可以临时关闭某条规则
- 告警历史写入 SQLite，不只保存在内存

P0 先做：

- 服务掉线
- 服务重启失败
- 内存使用率
- 磁盘剩余空间
- GPU/温度阈值（有 macmon 数据时）

通知先做 macOS 桌面通知，后续再考虑 ntfy/Telegram。浏览器页面不能代替系统通知。

### 4. 日志流借鉴 Loki 的边界，不引入 Loki

- 每个服务一个日志流
- 标签只用 `serviceId`、`stream(stdout/stderr)`，不要把每行内容做标签
- Agent 端做有界 ring buffer，WebSocket 只推送增量
- 前端只保留最近 N 行，支持搜索、暂停、清空视图
- 关闭页面后取消订阅，不继续推送
- 文件轮转和大小上限放到 P1-3.3

### 5. SQLite 备份借鉴 Litestream 的快照思路

不引入 Litestream 常驻进程，先做：

- `VACUUM INTO` 生成一致性快照
- `services.yaml`、`studioops.sqlite`、日志元数据、配置备份一起打包
- 默认排除 `api-token`
- 设置页可手动导出
- 自动定时备份放到 P2-3.10

## 建议的 P0-3.1 实现顺序

1. `MetricsStore`：schema、批量写入、查询、rollup、保留和清理
2. Agent 采样循环：系统指标 + 服务指标
3. `/api/metrics/history`：按范围返回有限点数
4. 总览页历史卡片：5 分钟 / 1 小时 / 24 小时
5. 测试：时间桶、rollup、保留、查询点数上限、SQLite 重启恢复

## 建议的 P0-3.2 实现顺序

1. `AlertEngine`：规则、状态机、`for`、滞后、冷却
2. 规则存 SQLite，设置页可开关和调整阈值
3. Tauri notification 插件和桌面通知
4. 告警历史和恢复记录
5. 测试：不重复通知、恢复通知、抖动抑制、静默

## 不做的事

- 不引入 PromQL
- 不做多租户
- 不做集群和高可用
- 不把 Netdata/Uptime Kuma 当作 StudioOps 的运行时依赖
- 不在 P0 做远程指标上报
- 不在 P0 做复杂通知路由

## 待确认

- 默认采样间隔：建议 10 秒
- 原始数据保留：建议 7 天
- 1 分钟 rollup 保留：建议 30 天
- 1 小时 rollup 保留：建议 365 天
- 桌面通知是否默认开启：建议默认开启，阈值可在设置页关闭
