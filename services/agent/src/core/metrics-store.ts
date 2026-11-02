import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type MetricScope = "system" | "service";
export type MetricRange = "5m" | "1h" | "24h";

export interface MetricSample {
  ts: number;
  scope: MetricScope;
  scopeId: string;
  metric: string;
  value: number;
  unit?: string;
}

export interface MetricPoint {
  ts: number;
  value: number;
}

export interface MetricSeries {
  scope: MetricScope;
  scopeId: string;
  metric: string;
  unit?: string;
  points: MetricPoint[];
}

export interface MetricsHistory {
  range: MetricRange;
  from: number;
  to: number;
  resolutionMs: number;
  series: MetricSeries[];
}

export interface MetricsSettings {
  intervalMs: number;
  rawRetentionMs: number;
  minuteRetentionMs: number;
  hourRetentionMs: number;
}

export interface MetricsSettingsInput {
  intervalMs?: number;
  rawRetentionDays?: number;
  minuteRetentionDays?: number;
  hourRetentionDays?: number;
}

export const DEFAULT_METRICS_SETTINGS: MetricsSettings = {
  intervalMs: 10_000,
  rawRetentionMs: 7 * DAY_MS,
  minuteRetentionMs: 30 * DAY_MS,
  hourRetentionMs: 365 * DAY_MS,
};

const RANGE_MS: Record<MetricRange, number> = {
  "5m": 5 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "24h": 24 * HOUR_MS,
};

/**
 * SQLite-backed metric history. Raw samples are kept for short queries and
 * rolled up to 1m/1h buckets so 24h charts never scan every 10s point.
 */
export class MetricsStore {
  private readonly db: DatabaseSync;
  private writes = 0;

  constructor(
    dataDir: string,
    private settings: MetricsSettings = { ...DEFAULT_METRICS_SETTINGS },
  ) {
    const filePath = resolve(dataDir, "studioops.sqlite");
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    chmodSync(filePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;

      CREATE TABLE IF NOT EXISTS metric_samples (
        ts INTEGER NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        value REAL NOT NULL,
        PRIMARY KEY (ts, scope, scope_id, metric)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_metric_samples_series
        ON metric_samples(scope, scope_id, metric, ts);

      CREATE TABLE IF NOT EXISTS metric_rollups (
        resolution INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        avg_value REAL NOT NULL,
        samples INTEGER NOT NULL,
        PRIMARY KEY (resolution, bucket, scope, scope_id, metric)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_metric_rollups_series
        ON metric_rollups(scope, scope_id, metric, resolution, bucket);

      CREATE TABLE IF NOT EXISTS metric_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    this.loadSettings();
    this.prune();
  }

  getSettings(): MetricsSettings {
    return { ...this.settings };
  }

  updateSettings(input: MetricsSettingsInput): MetricsSettings {
    const next = {
      intervalMs: validateInterval(
        input.intervalMs ?? this.settings.intervalMs,
      ),
      rawRetentionMs:
        validateDays(
          "rawRetentionDays",
          input.rawRetentionDays ?? this.settings.rawRetentionMs / DAY_MS,
          1,
          90,
        ) * DAY_MS,
      minuteRetentionMs:
        validateDays(
          "minuteRetentionDays",
          input.minuteRetentionDays ?? this.settings.minuteRetentionMs / DAY_MS,
          1,
          365,
        ) * DAY_MS,
      hourRetentionMs:
        validateDays(
          "hourRetentionDays",
          input.hourRetentionDays ?? this.settings.hourRetentionMs / DAY_MS,
          1,
          3650,
        ) * DAY_MS,
    };
    const statement = this.db.prepare(
      "INSERT INTO metric_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(next))
      statement.run(key, String(value));
    this.settings = next;
    this.prune();
    return this.getSettings();
  }

  insert(samples: MetricSample[]): void {
    if (!samples.length) return;
    const raw = this.db.prepare(
      "INSERT OR REPLACE INTO metric_samples (ts, scope, scope_id, metric, unit, value) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const rollup = this.db.prepare(`
      INSERT INTO metric_rollups
        (resolution, bucket, scope, scope_id, metric, unit, min_value, max_value, avg_value, samples)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(resolution, bucket, scope, scope_id, metric) DO UPDATE SET
        unit = excluded.unit,
        min_value = MIN(metric_rollups.min_value, excluded.min_value),
        max_value = MAX(metric_rollups.max_value, excluded.max_value),
        avg_value = ((metric_rollups.avg_value * metric_rollups.samples) + excluded.avg_value) / (metric_rollups.samples + 1),
        samples = metric_rollups.samples + 1
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of samples) {
        if (!Number.isFinite(sample.ts) || !Number.isFinite(sample.value))
          continue;
        raw.run(
          sample.ts,
          sample.scope,
          sample.scopeId,
          sample.metric,
          sample.unit ?? "",
          sample.value,
        );
        for (const resolution of [MINUTE_MS, HOUR_MS]) {
          const bucket = Math.floor(sample.ts / resolution) * resolution;
          rollup.run(
            resolution,
            bucket,
            sample.scope,
            sample.scopeId,
            sample.metric,
            sample.unit ?? "",
            sample.value,
            sample.value,
            sample.value,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.writes += 1;
    if (this.writes % 100 === 0) this.prune();
  }

  history(
    range: MetricRange,
    options: { scope?: MetricScope; scopeId?: string; now?: number } = {},
  ): MetricsHistory {
    const to = options.now ?? Date.now();
    const from = to - RANGE_MS[range];
    const filter = options.scope ? "AND scope = ?" : "";
    const filterArgs: Array<MetricScope | string> = options.scope
      ? [options.scope]
      : [];
    if (options.scopeId) {
      filterArgs.push(options.scopeId);
    }
    const scopeIdFilter = options.scopeId ? "AND scope_id = ?" : "";
    const series = new Map<string, MetricSeries>();
    let rows: Array<Record<string, unknown>>;
    let resolutionMs: number;

    if (range === "5m") {
      resolutionMs = 10_000;
      rows = this.db
        .prepare(
          `SELECT ts, scope, scope_id AS scopeId, metric, unit, value
           FROM metric_samples
           WHERE ts >= ? ${filter} ${scopeIdFilter}
           ORDER BY ts`,
        )
        .all(from, ...filterArgs) as Array<Record<string, unknown>>;
    } else if (range === "1h") {
      resolutionMs = MINUTE_MS;
      rows = this.db
        .prepare(
          `SELECT bucket AS ts, scope, scope_id AS scopeId, metric, unit, avg_value AS value
           FROM metric_rollups
           WHERE resolution = ? AND bucket >= ? ${filter} ${scopeIdFilter}
           ORDER BY bucket`,
        )
        .all(MINUTE_MS, from, ...filterArgs) as Array<Record<string, unknown>>;
    } else {
      resolutionMs = 5 * MINUTE_MS;
      rows = this.db
        .prepare(
          `SELECT (bucket / ${resolutionMs}) * ${resolutionMs} AS ts,
                  scope, scope_id AS scopeId, metric, unit, AVG(avg_value) AS value
           FROM metric_rollups
           WHERE resolution = ? AND bucket >= ? ${filter} ${scopeIdFilter}
           GROUP BY scope, scope_id, metric, ts
           ORDER BY ts`,
        )
        .all(MINUTE_MS, from, ...filterArgs) as Array<Record<string, unknown>>;
    }

    for (const row of rows) {
      const scope = row.scope as MetricScope;
      const scopeId = String(row.scopeId);
      const metric = String(row.metric);
      const key = `${scope}\u0000${scopeId}\u0000${metric}`;
      let item = series.get(key);
      if (!item) {
        item = {
          scope,
          scopeId,
          metric,
          unit: row.unit ? String(row.unit) : undefined,
          points: [],
        };
        series.set(key, item);
      }
      item.points.push({
        ts: Number(row.ts),
        value: Number(row.value),
      });
    }

    return {
      range,
      from,
      to,
      resolutionMs,
      series: [...series.values()].sort((left, right) =>
        `${left.scope}:${left.scopeId}:${left.metric}`.localeCompare(
          `${right.scope}:${right.scopeId}:${right.metric}`,
        ),
      ),
    };
  }

  prune(now = Date.now()): void {
    this.db
      .prepare("DELETE FROM metric_samples WHERE ts < ?")
      .run(now - this.settings.rawRetentionMs);
    this.db
      .prepare("DELETE FROM metric_rollups WHERE resolution = ? AND bucket < ?")
      .run(MINUTE_MS, now - this.settings.minuteRetentionMs);
    this.db
      .prepare("DELETE FROM metric_rollups WHERE resolution = ? AND bucket < ?")
      .run(HOUR_MS, now - this.settings.hourRetentionMs);
  }

  count(): { raw: number; minute: number; hour: number } {
    const raw = this.db
      .prepare("SELECT COUNT(*) AS count FROM metric_samples")
      .get() as { count?: number };
    const minute = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM metric_rollups WHERE resolution = ?",
      )
      .get(MINUTE_MS) as { count?: number };
    const hour = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM metric_rollups WHERE resolution = ?",
      )
      .get(HOUR_MS) as { count?: number };
    return {
      raw: Number(raw.count ?? 0),
      minute: Number(minute.count ?? 0),
      hour: Number(hour.count ?? 0),
    };
  }

  close(): void {
    this.db.close();
  }

  private loadSettings(): void {
    const rows = this.db
      .prepare("SELECT key, value FROM metric_settings")
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;
      if (row.key in this.settings)
        (this.settings as unknown as Record<string, number>)[row.key] = value;
    }
  }
}

function validateInterval(value: number): number {
  if (!Number.isFinite(value) || value < 5000 || value > 60_000)
    throw new Error("采样间隔必须在 5000-60000 毫秒之间");
  return Math.round(value);
}

function validateDays(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} 必须在 ${min}-${max} 天之间`);
  return Math.round(value);
}
