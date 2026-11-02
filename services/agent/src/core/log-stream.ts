import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { WebSocket } from "ws";

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 4000;
const MAX_TAIL_LINES = 1000;

export interface LogChunk {
  lines: string[];
  source: string;
  reset: boolean;
  truncated: boolean;
  error?: string;
}

export function readLogTail(filePath: string, tail: number): LogChunk {
  const resolved = resolve(filePath);
  try {
    const stats = statSync(resolved);
    const length = Math.min(stats.size, MAX_TAIL_BYTES);
    const start = Math.max(0, stats.size - length);
    const lines = readSlice(resolved, start, length)
      .toString("utf8")
      .split(/\r?\n/);
    if (start > 0 && lines.length > 0) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    return {
      lines: lines
        .slice(-clampTail(tail))
        .map((line) => line.slice(0, MAX_LINE_LENGTH)),
      source: resolved,
      reset: true,
      truncated: stats.size > length,
    };
  } catch (error) {
    return {
      lines: [],
      source: resolved,
      reset: true,
      truncated: false,
      error: error instanceof Error ? error.message : "Unable to read log",
    };
  }
}

/**
 * Offset-based log follower. It never reads the whole file: the initial
 * snapshot is capped at 256 KiB and every later poll reads at most 256 KiB.
 * Truncation or inode replacement is treated as rotation and emits a reset.
 */
export class LogFileTailer {
  private offset = 0;
  private inode: number | undefined;
  private remainder = "";

  constructor(
    readonly filePath: string,
    private readonly tail = 300,
  ) {}

  initial(): LogChunk {
    const snapshot = readLogTail(this.filePath, this.tail);
    try {
      const stats = statSync(this.filePath);
      this.offset = stats.size;
      this.inode = stats.ino;
      this.remainder = "";
    } catch {
      this.offset = 0;
      this.inode = undefined;
      this.remainder = "";
    }
    return snapshot;
  }

  poll(): LogChunk | undefined {
    try {
      if (!existsSync(this.filePath)) {
        return {
          lines: [],
          source: this.filePath,
          reset: false,
          truncated: false,
          error: "日志文件不存在",
        };
      }
      const stats = statSync(this.filePath);
      if (
        this.inode !== undefined &&
        (stats.ino !== this.inode || stats.size < this.offset)
      )
        return this.initial();
      if (stats.size === this.offset) return undefined;
      const length = Math.min(stats.size - this.offset, MAX_CHUNK_BYTES);
      const text =
        this.remainder +
        readSlice(this.filePath, this.offset, length).toString("utf8");
      this.offset += length;
      this.inode = stats.ino;
      const endsWithNewline = /\r?\n$/.test(text);
      const parts = text.split(/\r?\n/);
      this.remainder = endsWithNewline ? "" : (parts.pop() ?? "");
      if (this.remainder.length > MAX_LINE_LENGTH) {
        parts.push(this.remainder.slice(0, MAX_LINE_LENGTH));
        this.remainder = "";
      }
      const lines = parts
        .filter((line) => line.length > 0)
        .map((line) => line.slice(0, MAX_LINE_LENGTH));
      if (!lines.length) return undefined;
      return {
        lines,
        source: this.filePath,
        reset: false,
        truncated: stats.size > this.offset,
      };
    } catch (error) {
      return {
        lines: [],
        source: this.filePath,
        reset: false,
        truncated: false,
        error: error instanceof Error ? error.message : "Unable to read log",
      };
    }
  }
}

interface LogSession {
  tailer: LogFileTailer;
  clients: Set<WebSocket>;
  timer: NodeJS.Timeout;
  lastError?: string;
}

export class LogStreamer {
  private readonly sessions = new Map<string, LogSession>();

  constructor(
    private readonly getLogFile: (serviceId: string) => string | undefined,
    private readonly intervalMs = 1000,
  ) {}

  subscribe(client: WebSocket, serviceId: string, tail = 300): void {
    const requestedTail = clampTail(tail);
    let filePath: string | undefined;
    try {
      filePath = this.getLogFile(serviceId);
    } catch (error) {
      this.send(client, serviceId, {
        lines: [],
        source: "",
        reset: true,
        truncated: false,
        error: error instanceof Error ? error.message : "Unknown log service",
      });
      return;
    }
    if (!filePath) {
      this.send(client, serviceId, {
        lines: [],
        source: "",
        reset: true,
        truncated: false,
        error: "该服务没有配置 logFile，无法实时流式读取",
      });
      return;
    }

    const existing = this.sessions.get(serviceId);
    if (existing) {
      existing.clients.add(client);
      this.send(client, serviceId, readLogTail(filePath, requestedTail));
      return;
    }

    const tailer = new LogFileTailer(filePath, requestedTail);
    const session: LogSession = {
      tailer,
      clients: new Set([client]),
      timer: setInterval(() => this.poll(serviceId, session), this.intervalMs),
    };
    this.sessions.set(serviceId, session);
    const initial = tailer.initial();
    session.lastError = initial.error;
    this.send(client, serviceId, initial);
  }

  unsubscribe(client: WebSocket, serviceId: string): void {
    const session = this.sessions.get(serviceId);
    if (!session) return;
    session.clients.delete(client);
    if (!session.clients.size) this.stopSession(serviceId, session);
  }

  removeClient(client: WebSocket): void {
    for (const [serviceId, session] of this.sessions) {
      session.clients.delete(client);
      if (!session.clients.size) this.stopSession(serviceId, session);
    }
  }

  close(): void {
    for (const [serviceId, session] of this.sessions)
      this.stopSession(serviceId, session);
  }

  private poll(serviceId: string, session: LogSession): void {
    const chunk = session.tailer.poll();
    if (!chunk) return;
    if (chunk.error && chunk.error === session.lastError) return;
    session.lastError = chunk.error;
    for (const client of session.clients) this.send(client, serviceId, chunk);
  }

  private stopSession(serviceId: string, session: LogSession): void {
    clearInterval(session.timer);
    this.sessions.delete(serviceId);
  }

  private send(client: WebSocket, serviceId: string, chunk: LogChunk): void {
    if (client.readyState !== 1) return;
    client.send(
      JSON.stringify({
        type: "log",
        topic: "logs",
        data: {
          serviceId,
          lines: chunk.lines,
          source: chunk.source,
          reset: chunk.reset,
          truncated: chunk.truncated,
          error: chunk.error,
          at: new Date().toISOString(),
        },
      }),
    );
  }
}

function readSlice(filePath: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, bytesRead);
}

function clampTail(tail: number): number {
  return Math.max(
    1,
    Math.min(Number.isFinite(tail) ? tail : 300, MAX_TAIL_LINES),
  );
}
