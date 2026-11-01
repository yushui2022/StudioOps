import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OperationEvent } from "../../../../packages/contracts/src/index.js";

const MAX_EVENTS = 10000;

export class EventStore {
  private readonly db: DatabaseSync;
  private writes = 0;

  constructor(dataDir: string) {
    const filePath = resolve(dataDir, "studioops.sqlite");
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    chmodSync(filePath, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        action TEXT NOT NULL,
        state TEXT NOT NULL,
        success INTEGER NOT NULL,
        actor TEXT NOT NULL,
        error TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_events_at ON operation_events(at DESC);
    `);
    this.prune();
  }

  record(event: OperationEvent): OperationEvent {
    const result = this.db
      .prepare(
        "INSERT INTO operation_events (service_id, action, state, success, actor, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.serviceId,
        event.action,
        event.state,
        event.success ? 1 : 0,
        event.actor,
        event.error ?? null,
        event.at,
      );
    this.writes += 1;
    if (this.writes % 100 === 0) this.prune();
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  recent(limit = 50): OperationEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, service_id as serviceId, action, state, success, actor, error, at FROM operation_events ORDER BY id DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      success: Boolean(row.success),
      serviceId: String(row.serviceId),
      action: row.action as OperationEvent["action"],
      state: row.state as OperationEvent["state"],
      actor: row.actor as OperationEvent["actor"],
      error: row.error ? String(row.error) : undefined,
      at: String(row.at),
    }));
  }

  private prune(): void {
    this.db
      .prepare(
        "DELETE FROM operation_events WHERE id NOT IN (SELECT id FROM operation_events ORDER BY id DESC LIMIT ?)",
      )
      .run(MAX_EVENTS);
  }

  close(): void {
    this.db.close();
  }
}
