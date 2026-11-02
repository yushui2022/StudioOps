import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type {
  ServiceAction,
  ServiceDefinition,
  ServiceLog,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "./adapter.js";
import {
  findPidByPort,
  isProcessAlive,
  readProcessIdentity,
  readProcessMetrics,
} from "../core/process-metrics.js";

type ManagedProcess = { child: ChildProcess; startedAt: number };
type PidRecord = {
  pid: number;
  startedAt?: string;
  args?: string;
};

export class ProcessAdapter implements ServiceAdapter {
  readonly id = "process";
  private readonly children = new Map<string, ManagedProcess>();

  constructor(private readonly dataDir?: string) {}

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const managed = this.children.get(definition.id);
    const pid =
      managed?.child.pid ??
      (await this.readPid(definition)) ??
      (definition.port ? await findPidByPort(definition.port) : undefined);
    if (!pid || !isProcessAlive(pid)) {
      this.children.delete(definition.id);
      return {
        ...definition,
        state: "stopped",
        updatedAt: new Date().toISOString(),
      };
    }
    if (!managed) await this.rememberManagedPid(definition, pid);
    return {
      ...definition,
      state: "running",
      pid,
      ...(await readProcessMetrics(pid)),
      uptimeSeconds: managed
        ? Math.floor((Date.now() - managed.startedAt) / 1000)
        : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  async execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot> {
    if (!definition.allowedActions.includes(action))
      throw new Error(`Action ${action} is not allowed for ${definition.id}`);
    if (action === "start") return this.start(definition);
    if (action === "stop") return this.stop(definition);
    if (action === "restart") {
      await this.stop(definition);
      return this.start(definition);
    }
    const current = await this.inspect(definition);
    if (!current.pid) return current;
    process.kill(current.pid, action === "pause" ? "SIGSTOP" : "SIGCONT");
    return {
      ...current,
      state: action === "pause" ? "paused" : "running",
      updatedAt: new Date().toISOString(),
    };
  }

  async logs(definition: ServiceDefinition, tail: number): Promise<ServiceLog> {
    const logFile = definition.logFile;
    if (!logFile || !existsSync(resolve(logFile))) {
      return {
        serviceId: definition.id,
        lines: ["No logFile configured for this process."],
        source: logFile ?? "none",
        truncated: false,
        fetchedAt: new Date().toISOString(),
      };
    }
    try {
      const { lines, truncated } = readLogTail(resolve(logFile), tail);
      return {
        serviceId: definition.id,
        lines,
        source: resolve(logFile),
        truncated,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        serviceId: definition.id,
        lines: [
          error instanceof Error ? error.message : "Unable to read log file",
        ],
        source: resolve(logFile),
        truncated: false,
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  private async start(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const current = await this.inspect(definition);
    if (current.state === "running" || current.state === "paused")
      return current;
    if (!definition.command)
      throw new Error(`No command configured for process ${definition.id}`);
    const logFile = definition.logFile
      ? resolve(definition.logFile)
      : undefined;
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      const fd = openSync(logFile, "a");
      try {
        const child = spawn(definition.command, definition.args ?? [], {
          cwd: definition.cwd ? resolve(definition.cwd) : undefined,
          env: { ...process.env, ...(definition.env ?? {}) },
          stdio: ["ignore", fd, fd],
        });
        return this.track(definition, child);
      } finally {
        closeSync(fd);
      }
    }
    const child = spawn(definition.command, definition.args ?? [], {
      cwd: definition.cwd ? resolve(definition.cwd) : undefined,
      env: { ...process.env, ...(definition.env ?? {}) },
      stdio: "ignore",
    });
    return this.track(definition, child);
  }

  private async track(
    definition: ServiceDefinition,
    child: ChildProcess,
  ): Promise<ServiceSnapshot> {
    if (!child.pid) throw new Error(`Failed to start ${definition.id}`);
    const managed = { child, startedAt: Date.now() };
    this.children.set(definition.id, managed);
    await this.writeManagedPid(definition, child.pid);
    child.once("exit", () => {
      const current = this.children.get(definition.id);
      if (current?.child === child) {
        this.children.delete(definition.id);
        this.removeManagedPid(definition);
      }
    });
    return this.inspect(definition);
  }

  private async stop(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const current = await this.inspect(definition);
    if (current.pid) {
      try {
        process.kill(current.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      if (!(await waitForExit(current.pid, 3000)))
        throw new Error(
          `Process ${current.pid} did not exit after SIGTERM; use the process panel to force terminate it`,
        );
    }
    this.children.delete(definition.id);
    this.removeManagedPid(definition);
    if (definition.logFile && existsSync(resolve(definition.logFile)))
      appendFileSync(resolve(definition.logFile), "");
    return {
      ...definition,
      state: "stopped",
      updatedAt: new Date().toISOString(),
    };
  }

  private managedPidFile(definition: ServiceDefinition): string | undefined {
    if (definition.pidFile) return undefined;
    if (!this.dataDir) return undefined;
    return join(this.dataDir, "pids", `${definition.id}.pid`);
  }

  private readPidFile(definition: ServiceDefinition): string | undefined {
    if (definition.pidFile) return resolve(definition.pidFile);
    return this.managedPidFile(definition);
  }

  private async readPid(
    definition: ServiceDefinition,
  ): Promise<number | undefined> {
    const pidFile = this.readPidFile(definition);
    if (!pidFile || !existsSync(pidFile)) return undefined;
    let record: PidRecord | undefined;
    try {
      const raw = readFileSync(pidFile, "utf8").trim();
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw) as Partial<PidRecord>;
        if (Number.isInteger(parsed.pid))
          record = {
            pid: Number(parsed.pid),
            startedAt:
              typeof parsed.startedAt === "string"
                ? parsed.startedAt
                : undefined,
            args: typeof parsed.args === "string" ? parsed.args : undefined,
          };
      } else {
        const pid = Number(raw);
        if (Number.isInteger(pid)) record = { pid };
      }
    } catch {
      record = undefined;
    }
    if (!record?.pid || !isProcessAlive(record.pid)) {
      rmSync(pidFile, { force: true });
      return undefined;
    }
    if (record.startedAt || record.args) {
      const identity = await readProcessIdentity(record.pid);
      if (
        record.startedAt &&
        identity.startedAt &&
        record.startedAt !== identity.startedAt
      ) {
        rmSync(pidFile, { force: true });
        return undefined;
      }
      if (
        !record.startedAt &&
        record.args &&
        identity.args &&
        !this.commandMatches(definition, identity.args)
      ) {
        rmSync(pidFile, { force: true });
        return undefined;
      }
    }
    return record.pid;
  }

  private async rememberManagedPid(
    definition: ServiceDefinition,
    pid: number,
  ): Promise<void> {
    if (definition.pidFile || !this.dataDir) return;
    const pidFile = this.managedPidFile(definition);
    if (!pidFile || existsSync(pidFile)) return;
    await this.writeManagedPid(definition, pid);
  }

  private async writeManagedPid(
    definition: ServiceDefinition,
    pid: number,
  ): Promise<void> {
    const pidFile = this.managedPidFile(definition);
    if (!pidFile) return;
    const identity = await readProcessIdentity(pid);
    const record: PidRecord = {
      pid,
      startedAt: identity.startedAt,
      args: identity.args,
    };
    mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
    const temporary = `${pidFile}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, pidFile);
  }

  private removeManagedPid(definition: ServiceDefinition): void {
    const pidFile = this.managedPidFile(definition);
    if (pidFile) rmSync(pidFile, { force: true });
  }

  private commandMatches(
    definition: ServiceDefinition,
    actualArgs: string,
  ): boolean {
    const command = definition.command;
    if (!command) return true;
    const expected = command.split("/").at(-1)?.toLowerCase();
    return !expected || actualArgs.toLowerCase().includes(expected);
  }
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function readLogTail(
  filePath: string,
  tail: number,
): { lines: string[]; truncated: boolean } {
  const stats = statSync(filePath);
  const start = Math.max(0, stats.size - MAX_LOG_BYTES);
  const length = stats.size - start;
  if (length <= 0) return { lines: [], truncated: false };
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const newline = text.indexOf("\n");
    if (newline >= 0) text = text.slice(newline + 1);
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  return {
    lines: lines.slice(-tail),
    truncated: start > 0 || lines.length > tail,
  };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}
