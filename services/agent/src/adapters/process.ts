import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
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
  readProcessMetrics,
} from "../core/process-metrics.js";

type ManagedProcess = { child: ChildProcess; startedAt: number };

export class ProcessAdapter implements ServiceAdapter {
  readonly id = "process";
  private readonly children = new Map<string, ManagedProcess>();

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const managed = this.children.get(definition.id);
    const pid =
      managed?.child.pid ??
      this.readPid(definition) ??
      (definition.port ? await findPidByPort(definition.port) : undefined);
    if (!pid || !isProcessAlive(pid)) {
      this.children.delete(definition.id);
      return {
        ...definition,
        state: "stopped",
        updatedAt: new Date().toISOString(),
      };
    }
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
    const lines = readFileSync(resolve(logFile), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    return {
      serviceId: definition.id,
      lines: lines.slice(-tail),
      source: resolve(logFile),
      truncated: lines.length > tail,
      fetchedAt: new Date().toISOString(),
    };
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
      writeFileSync(logFile, "", { flag: "a" });
      const stream = createWriteStream(logFile, { flags: "a" });
      const child = spawn(definition.command, definition.args ?? [], {
        cwd: definition.cwd ? resolve(definition.cwd) : undefined,
        env: { ...process.env, ...(definition.env ?? {}) },
        stdio: ["ignore", stream, stream],
      });
      return this.track(definition, child);
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
    child.once("exit", () => {
      const current = this.children.get(definition.id);
      if (current?.child === child) this.children.delete(definition.id);
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
    }
    this.children.delete(definition.id);
    if (definition.logFile && existsSync(resolve(definition.logFile)))
      appendFileSync(resolve(definition.logFile), "");
    return {
      ...definition,
      state: "stopped",
      updatedAt: new Date().toISOString(),
    };
  }

  private readPid(definition: ServiceDefinition): number | undefined {
    const pidFile = definition.pidFile;
    if (!pidFile || !existsSync(resolve(pidFile))) return undefined;
    const pid = Number(readFileSync(resolve(pidFile), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
}
