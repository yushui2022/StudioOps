import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ServiceSnapshot,
  SystemSnapshot,
} from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const MAX_EVENTS = 5000;

export type AlertRule =
  | "service-down"
  | "action-failure"
  | "memory-high"
  | "disk-low"
  | "temperature-high";

export type AlertSeverity = "warning" | "critical";
export type AlertStatus = "pending" | "firing" | "resolved";

export interface AlertSettings {
  enabled: boolean;
  desktopNotifications: boolean;
  serviceDownSeconds: number;
  sustainSeconds: number;
  repeatMinutes: number;
  memoryPercent: number;
  diskFreePercent: number;
  temperatureC: number;
}

export interface AlertSettingsInput {
  enabled?: boolean;
  desktopNotifications?: boolean;
  serviceDownSeconds?: number;
  sustainSeconds?: number;
  repeatMinutes?: number;
  memoryPercent?: number;
  diskFreePercent?: number;
  temperatureC?: number;
}

export interface AlertEvent {
  id?: number;
  key: string;
  rule: AlertRule;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  detail: string;
  at: string;
}

export interface ActiveAlert {
  key: string;
  rule: AlertRule;
  severity: AlertSeverity;
  status: "pending" | "firing";
  title: string;
  detail: string;
  since: string;
  lastNotifiedAt?: string;
}

export interface AlertsStatus {
  settings: AlertSettings;
  active: ActiveAlert[];
  events: AlertEvent[];
  notificationError?: string;
}

interface RuntimeAlert {
  key: string;
  rule: AlertRule;
  severity: AlertSeverity;
  status: "pending" | "firing";
  title: string;
  detail: string;
  since: number;
  lastNotifiedAt?: number;
}

type Notifier = (title: string, body: string) => Promise<void>;

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  desktopNotifications: true,
  serviceDownSeconds: 30,
  sustainSeconds: 60,
  repeatMinutes: 30,
  memoryPercent: 90,
  diskFreePercent: 10,
  temperatureC: 85,
};

export class AlertStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const filePath = resolve(dataDir, "studioops.sqlite");
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    chmodSync(filePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;

      CREATE TABLE IF NOT EXISTS alert_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_key TEXT NOT NULL,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alert_events_at ON alert_events(at DESC);
    `);
  }

  getSettings(): AlertSettings {
    const settings = { ...DEFAULT_ALERT_SETTINGS };
    const rows = this.db
      .prepare("SELECT key, value FROM alert_settings")
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      if (row.key === "enabled" || row.key === "desktopNotifications") {
        (settings as unknown as Record<string, boolean>)[row.key] =
          row.value === "true";
      } else if (row.key in settings) {
        const value = Number(row.value);
        if (Number.isFinite(value))
          (settings as unknown as Record<string, number>)[row.key] = value;
      }
    }
    return settings;
  }

  updateSettings(input: AlertSettingsInput): AlertSettings {
    const current = this.getSettings();
    const next: AlertSettings = {
      enabled: input.enabled ?? current.enabled,
      desktopNotifications:
        input.desktopNotifications ?? current.desktopNotifications,
      serviceDownSeconds: validateInt(
        "serviceDownSeconds",
        input.serviceDownSeconds ?? current.serviceDownSeconds,
        5,
        600,
      ),
      sustainSeconds: validateInt(
        "sustainSeconds",
        input.sustainSeconds ?? current.sustainSeconds,
        5,
        600,
      ),
      repeatMinutes: validateInt(
        "repeatMinutes",
        input.repeatMinutes ?? current.repeatMinutes,
        1,
        1440,
      ),
      memoryPercent: validateInt(
        "memoryPercent",
        input.memoryPercent ?? current.memoryPercent,
        50,
        100,
      ),
      diskFreePercent: validateInt(
        "diskFreePercent",
        input.diskFreePercent ?? current.diskFreePercent,
        1,
        50,
      ),
      temperatureC: validateInt(
        "temperatureC",
        input.temperatureC ?? current.temperatureC,
        50,
        120,
      ),
    };
    const statement = this.db.prepare(
      "INSERT INTO alert_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(next))
      statement.run(key, String(value));
    return next;
  }

  record(event: AlertEvent): AlertEvent {
    const result = this.db
      .prepare(
        "INSERT INTO alert_events (alert_key, rule, severity, status, title, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.key,
        event.rule,
        event.severity,
        event.status,
        event.title,
        event.detail,
        event.at,
      );
    this.prune();
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  recent(limit = 30): AlertEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, alert_key AS key, rule, severity, status, title, detail, at FROM alert_events ORDER BY id DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      key: String(row.key),
      rule: row.rule as AlertRule,
      severity: row.severity as AlertSeverity,
      status: row.status as AlertStatus,
      title: String(row.title),
      detail: String(row.detail),
      at: String(row.at),
    }));
  }

  close(): void {
    this.db.close();
  }

  private prune(): void {
    this.db
      .prepare(
        "DELETE FROM alert_events WHERE id NOT IN (SELECT id FROM alert_events ORDER BY id DESC LIMIT ?)",
      )
      .run(MAX_EVENTS);
  }
}

/**
 * Small local alert engine inspired by Alertmanager's deduplication and
 * Netdata's hysteresis/delay model. It deliberately keeps only one active
 * state per rule target so a flapping value cannot create alert storms.
 */
export class AlertEngine {
  private readonly active = new Map<string, RuntimeAlert>();
  private readonly serviceStates = new Map<string, "up" | "down">();
  private readonly suppressed = new Set<string>();
  private notificationError: string | undefined;

  constructor(
    private readonly store: AlertStore,
    private readonly notifier: Notifier,
  ) {}

  getSettings(): AlertSettings {
    return this.store.getSettings();
  }

  updateSettings(input: AlertSettingsInput): AlertSettings {
    const settings = this.store.updateSettings(input);
    if (!settings.enabled) {
      this.active.clear();
      this.serviceStates.clear();
    }
    return settings;
  }

  status(): AlertsStatus {
    return {
      settings: this.store.getSettings(),
      active: [...this.active.values()]
        .map((alert) => ({
          key: alert.key,
          rule: alert.rule,
          severity: alert.severity,
          status: alert.status,
          title: alert.title,
          detail: alert.detail,
          since: new Date(alert.since).toISOString(),
          lastNotifiedAt: alert.lastNotifiedAt
            ? new Date(alert.lastNotifiedAt).toISOString()
            : undefined,
        }))
        .sort((left, right) => left.since.localeCompare(right.since)),
      events: this.store.recent(30),
      notificationError: this.notificationError,
    };
  }

  async testNotification(): Promise<void> {
    await this.notifier(
      "StudioOps 测试通知",
      "如果你看到这条通知，桌面告警通道正常。",
    );
  }

  recordActionSuccess(serviceId: string, action: string): void {
    if (action === "stop") {
      this.suppressed.add(serviceId);
      this.cancel(`service-down:${serviceId}`);
      return;
    }
    if (action === "start" || action === "restart") {
      this.suppressed.delete(serviceId);
      this.cancel(`action-failure:${serviceId}`);
    }
  }

  recordActionFailure(
    serviceId: string,
    serviceName: string,
    action: string,
    message: string,
    now = Date.now(),
  ): void {
    const event: AlertEvent = {
      key: `action-failure:${serviceId}`,
      rule: "action-failure",
      severity: "warning",
      status: "firing",
      title: `操作失败：${serviceName}`,
      detail: `${action} 失败：${message}`,
      at: new Date(now).toISOString(),
    };
    this.store.record(event);
    void this.deliver(event.title, event.detail);
  }

  evaluate(
    system: SystemSnapshot,
    services: ServiceSnapshot[],
    now = Date.now(),
  ): void {
    const settings = this.store.getSettings();
    if (!settings.enabled) {
      this.active.clear();
      this.serviceStates.clear();
      return;
    }

    for (const service of services) {
      const key = `service-down:${service.id}`;
      const isUp = service.state === "running" || service.state === "paused";
      const previous = this.serviceStates.get(service.id);
      this.serviceStates.set(service.id, isUp ? "up" : "down");
      if (isUp) {
        this.resolve(key, now);
        continue;
      }
      if (this.suppressed.has(service.id)) {
        this.cancel(key);
        continue;
      }
      if (previous !== "up" && !this.active.has(key)) continue;
      const current = this.active.get(key);
      if (current) {
        current.detail = `状态 ${service.state}，已持续超过 ${settings.serviceDownSeconds} 秒。`;
        if (current.status === "pending") {
          if (now - current.since >= settings.serviceDownSeconds * 1000)
            this.fire(current, now);
        } else if (
          current.lastNotifiedAt &&
          now - current.lastNotifiedAt >= settings.repeatMinutes * 60_000
        ) {
          current.lastNotifiedAt = now;
          this.emit(current, "firing", now);
        }
        continue;
      }
      this.active.set(key, {
        key,
        rule: "service-down",
        severity: "critical",
        status: "pending",
        title: `服务掉线：${service.name}`,
        detail: `状态 ${service.state}，等待 ${settings.serviceDownSeconds} 秒确认。`,
        since: now,
      });
    }

    const memoryPercent =
      system.memory.totalBytes > 0
        ? ((system.memory.usedBytes ??
            system.memory.totalBytes - system.memory.freeBytes) /
            system.memory.totalBytes) *
          100
        : undefined;
    this.evaluateThreshold(
      "memory-high",
      memoryPercent,
      {
        rule: "memory-high",
        severity: "warning",
        title: "内存使用率过高",
        detail: `当前 ${memoryPercent?.toFixed(1) ?? "—"}%，阈值 ${settings.memoryPercent}%。`,
        forMs: settings.sustainSeconds * 1000,
        trigger: settings.memoryPercent,
        clear: Math.max(0, settings.memoryPercent - 10),
        above: true,
      },
      now,
      settings,
    );

    const diskFreePercent =
      system.disk && system.disk.totalBytes > 0
        ? (system.disk.freeBytes / system.disk.totalBytes) * 100
        : undefined;
    this.evaluateThreshold(
      "disk-low",
      diskFreePercent,
      {
        rule: "disk-low",
        severity: "critical",
        title: "磁盘剩余空间不足",
        detail: `当前剩余 ${diskFreePercent?.toFixed(1) ?? "—"}%，阈值 ${settings.diskFreePercent}%。`,
        forMs: settings.sustainSeconds * 1000,
        trigger: settings.diskFreePercent,
        clear: Math.min(100, settings.diskFreePercent + 5),
        above: false,
      },
      now,
      settings,
    );

    const temps = [
      system.silicon?.cpuTemperatureC,
      system.silicon?.gpuTemperatureC,
    ].filter((value): value is number => Number.isFinite(value));
    const temperature = temps.length ? Math.max(...temps) : undefined;
    this.evaluateThreshold(
      "temperature-high",
      temperature,
      {
        rule: "temperature-high",
        severity: "warning",
        title: "温度过高",
        detail: `当前 ${temperature?.toFixed(1) ?? "—"}°C，阈值 ${settings.temperatureC}°C。`,
        forMs: settings.sustainSeconds * 1000,
        trigger: settings.temperatureC,
        clear: Math.max(0, settings.temperatureC - 10),
        above: true,
      },
      now,
      settings,
    );
  }

  private evaluateThreshold(
    key: string,
    value: number | undefined,
    options: {
      rule: AlertRule;
      severity: AlertSeverity;
      title: string;
      detail: string;
      forMs: number;
      trigger: number;
      clear: number;
      above: boolean;
    },
    now: number,
    settings: AlertSettings,
  ): void {
    if (value === undefined || !Number.isFinite(value)) return;
    const crossed = options.above
      ? value >= options.trigger
      : value <= options.trigger;
    const cleared = options.above
      ? value <= options.clear
      : value >= options.clear;
    const current = this.active.get(key);
    if (current) {
      current.detail = options.detail;
      if (current.status === "firing") {
        if (cleared) {
          this.resolve(key, now);
          return;
        }
        if (
          current.lastNotifiedAt &&
          now - current.lastNotifiedAt >= settings.repeatMinutes * 60_000
        ) {
          current.lastNotifiedAt = now;
          this.emit(current, "firing", now);
        }
        return;
      }
      if (!crossed) {
        this.active.delete(key);
        return;
      }
      if (now - current.since >= options.forMs) this.fire(current, now);
      return;
    }
    if (!crossed) return;
    this.active.set(key, {
      key,
      rule: options.rule,
      severity: options.severity,
      status: "pending",
      title: options.title,
      detail: options.detail,
      since: now,
    });
  }

  private fire(alert: RuntimeAlert, now: number): void {
    alert.status = "firing";
    alert.lastNotifiedAt = now;
    this.emit(alert, "firing", now);
  }

  private resolve(key: string, now: number): void {
    const alert = this.active.get(key);
    if (!alert) return;
    this.active.delete(key);
    if (alert.status === "firing") {
      this.emit(alert, "resolved", now, "已恢复。");
    }
  }

  private cancel(key: string): void {
    this.active.delete(key);
  }

  private emit(
    alert: RuntimeAlert,
    status: "firing" | "resolved",
    now: number,
    detail = alert.detail,
  ): void {
    const event: AlertEvent = {
      key: alert.key,
      rule: alert.rule,
      severity: alert.severity,
      status,
      title: alert.title,
      detail,
      at: new Date(now).toISOString(),
    };
    this.store.record(event);
    if (status === "firing") void this.deliver(alert.title, alert.detail);
    else void this.deliver(`已恢复：${alert.title}`, detail);
  }

  private async deliver(title: string, body: string): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.enabled || !settings.desktopNotifications) return;
    try {
      await this.notifier(title, body);
      this.notificationError = undefined;
    } catch (error) {
      this.notificationError =
        error instanceof Error ? error.message : "Desktop notification failed";
    }
  }
}

export async function sendMacNotification(
  title: string,
  body: string,
): Promise<void> {
  const escape = (value: string): string =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, " ")
      .slice(0, 500);
  const script = `display notification "${escape(body)}" with title "StudioOps" subtitle "${escape(title)}" sound name "Glass"`;
  await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
}

function validateInt(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} 必须在 ${min}-${max} 之间`);
  return Math.round(value);
}
