# 卸载与恢复

StudioOps 的卸载分成两层：先清理后台服务，再决定是否删除 App 和数据。默认只清理后台，保留配置，方便重装后继续使用。

## 设置页卸载（推荐）

1. 打开“设置 → 卸载与恢复”。
2. 点“导出配置与数据”。归档默认写入 `~/Downloads/StudioOps-backup-<时间>.tar.gz`，包含：
   - `services.yaml`
   - `studioops.sqlite`（操作历史）
   - `backups/`（配置备份）
   - `logs/`、`pids/`、`icons/`
3. 点“停止服务并退出”。StudioOps 会：
   - 停止由 Agent 启动的 process 服务；
   - `launchctl bootout` 并删除所有 `~/Library/LaunchAgents/com.studioops.*.plist`；
   - 把常驻项目配置恢复成普通 process 服务；
   - 备份当前配置后退出桌面端。
4. 如需彻底删除，退出后把 `/Applications/StudioOps.app` 和 `~/Library/Application Support/com.studioops.desktop` 移到废纸篓。

清理后检查没有残留：

```bash
ls ~/Library/LaunchAgents/com.studioops.* 2>/dev/null
pgrep -fl 'StudioOps.app/Contents/(MacOS/studioops-desktop|Resources/agent.cjs)'
```

两条命令都应该没有输出。

## 终端脚本

仓库内的脚本也会在打包时放进 App 的 `Contents/Resources`：

```bash
# 停止 App/Agent，移除 LaunchAgent，保留配置和数据（先自动导出）
bash scripts/uninstall-studioops.sh

# 导出后删除数据目录
bash scripts/uninstall-studioops.sh --purge-data --yes

# 连同 /Applications/StudioOps.app 一起删除
bash scripts/uninstall-studioops.sh --purge-data --remove-app --yes
```

`--yes` 只用于自动化；交互执行时会先确认。脚本只处理 `com.studioops.*`，不会碰其他 LaunchAgent。

## 重装后恢复

先重新安装并启动一次 StudioOps，让它创建数据目录，然后退出 App，再恢复归档：

```bash
# 归档中包含 com.studioops.desktop 目录时
tar -xzf ~/Downloads/StudioOps-backup-<时间>.tar.gz \
  -C "$HOME/Library/Application Support"

# 如果归档中的 services.yaml 在单独目录，按归档清单复制回数据目录：
cp services.yaml "$HOME/Library/Application Support/com.studioops.desktop/services.yaml"
```

重新打开 StudioOps 后，服务清单、配置备份、操作历史和日志会恢复。之前设为常驻的项目已恢复为 process 配置，需要时在项目页重新点“设为常驻”。

## 数据位置

| 内容             | 路径                                                           |
| ---------------- | -------------------------------------------------------------- |
| 配置和 SQLite    | `~/Library/Application Support/com.studioops.desktop/`         |
| 配置备份         | `~/Library/Application Support/com.studioops.desktop/backups/` |
| 项目 LaunchAgent | `~/Library/LaunchAgents/com.studioops.project.<id>.plist`      |
| 导出归档         | `~/Downloads/StudioOps-backup-*.tar.gz`                        |
| App              | `/Applications/StudioOps.app`                                  |
