import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelCallRecord {
  id: string;
  backend: string;
  model?: string;
  state: string;
  method: string;
  path: string;
  client?: string;
  statusCode?: number;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  waitMs?: number;
  durationMs?: number;
  bytes: number;
  error?: string;
}

/**
 * Append-only JSONL log for model calls. It stores request metadata only:
 * model name, backend, route, client, status and timing. Request bodies and
 * prompts are never written.
 */
export class ModelCallLog {
  private pending: Promise<void> = Promise.resolve();
  private lastError?: string;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  append(record: ModelCallRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        try {
          const info = await stat(this.file);
          if (info.size + Buffer.byteLength(line) > this.maxBytes) {
            await rename(this.file, `${this.file}.1`);
          }
        } catch {
          // The file does not exist yet.
        }
        await appendFile(this.file, line, "utf8");
        this.lastError = undefined;
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
  }

  async read(limit = 200): Promise<ModelCallRecord[]> {
    await this.pending;
    try {
      const content = await readFile(this.file, "utf8");
      return content
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map(parseRecord)
        .filter((record): record is ModelCallRecord => Boolean(record))
        .reverse();
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.pending;
  }

  status(): { file: string; error?: string } {
    return { file: this.file, error: this.lastError };
  }
}

function parseRecord(line: string): ModelCallRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<ModelCallRecord>;
    if (
      typeof value.id !== "string" ||
      typeof value.backend !== "string" ||
      typeof value.state !== "string" ||
      typeof value.method !== "string" ||
      typeof value.path !== "string" ||
      typeof value.enqueuedAt !== "string"
    )
      return undefined;
    return value as ModelCallRecord;
  } catch {
    return undefined;
  }
}
