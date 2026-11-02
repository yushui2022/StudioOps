import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findPidByPort(port: number): Promise<number | undefined> {
  try {
    const result = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 1500 },
    );
    const pid = Number(result.stdout.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function readProcessMetrics(pid: number): Promise<{
  cpuPercent?: number;
  memoryBytes?: number;
  memoryPercent?: number;
}> {
  try {
    const result = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "%cpu=,%mem=,rss="],
      { timeout: 1500 },
    );
    const [cpu, memoryPercent, rssKb] = result.stdout
      .trim()
      .split(/\s+/)
      .map(Number);
    return {
      cpuPercent: Number.isFinite(cpu) ? cpu : undefined,
      memoryPercent: Number.isFinite(memoryPercent) ? memoryPercent : undefined,
      memoryBytes: Number.isFinite(rssKb)
        ? Math.round(rssKb * 1024)
        : undefined,
    };
  } catch {
    return {};
  }
}

export async function readProcessIdentity(pid: number): Promise<{
  startedAt?: string;
  args?: string;
}> {
  try {
    const [started, args] = await Promise.all([
      execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: 1500,
      }),
      execFileAsync("ps", ["-p", String(pid), "-o", "args="], {
        timeout: 1500,
      }),
    ]);
    return {
      startedAt: started.stdout.trim() || undefined,
      args: args.stdout.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
