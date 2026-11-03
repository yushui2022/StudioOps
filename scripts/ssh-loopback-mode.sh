#!/bin/bash
# 切换 macOS SSH 的暴露方式。
#
#   sudo bash scripts/ssh-loopback-mode.sh gateway
#     关闭系统 Remote Login，只监听 127.0.0.1:22，
#     供 VPS 上的 Warpgate 通过 SSH 反向隧道访问。
#
#   sudo bash scripts/ssh-loopback-mode.sh direct
#     停止仅回环 sshd，恢复系统 Remote Login（所有网卡）。
#
#   sudo bash scripts/ssh-loopback-mode.sh status
#     查看当前模式和监听状态。
set -euo pipefail

LABEL="ai.local.studioops.sshd"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
MODE="${1:-gateway}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash scripts/ssh-loopback-mode.sh $MODE" >&2
  exit 1
fi

install_loopback_sshd() {
  cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.local.studioops.sshd</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/sbin/sshd</string>
        <string>-D</string>
        <string>-f</string>
        <string>/etc/ssh/sshd_config</string>
        <string>-o</string>
        <string>ListenAddress=127.0.0.1</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/var/log/studioops-sshd.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/studioops-sshd.log</string>
</dict>
</plist>
PLIST
  chown root:wheel "$PLIST"
  chmod 644 "$PLIST"
}

case "$MODE" in
  gateway)
    # 系统 sshd 由 launchd socket 激活，会监听所有网卡；先卸载并禁用。
    launchctl bootout system/com.openssh.sshd >/dev/null 2>&1 || true
    launchctl disable system/com.openssh.sshd >/dev/null 2>&1 || true
    install_loopback_sshd
    launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap system "$PLIST"
    sleep 2
    launchctl print "system/${LABEL}" | grep -E "state =|pid =" | head -2
    if /usr/bin/nc -z 127.0.0.1 22; then
      echo "gateway mode: sshd is listening on 127.0.0.1:22 only"
    else
      echo "gateway mode failed: 127.0.0.1:22 is not reachable" >&2
      exit 1
    fi
    ;;
  direct)
    launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    launchctl enable system/com.openssh.sshd >/dev/null 2>&1 || true
    launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist >/dev/null 2>&1 || true
    echo "direct mode: macOS Remote Login restored on all interfaces"
    ;;
  status)
    launchctl print "system/${LABEL}" 2>/dev/null | grep -E "state =|pid =" | head -2 || true
    launchctl print system/com.openssh.sshd 2>/dev/null | grep -E "state =" | head -2 || echo "system sshd: not loaded"
    /usr/sbin/netstat -an -p tcp | grep '\.22 ' || true
    ;;
  *)
    echo "Usage: sudo bash scripts/ssh-loopback-mode.sh {gateway|direct|status}" >&2
    exit 2
    ;;
esac
