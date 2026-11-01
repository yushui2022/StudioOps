import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ProcessListSnapshot,
  ProcessSnapshot,
} from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);

/**
 * Read the process table with ps instead of shelling out to a user supplied
 * command. The output format is fixed here; callers may only choose the sort
 * order and the number of rows.
 */
export async function listProcesses(
  sort: "cpu" | "memory" = "cpu",
  limit = 50,
): Promise<ProcessListSnapshot> {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), 200)
    : 50;
  try {
    const result = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,user=,%cpu=,%mem=,rss=,comm="],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
    );
    const processes = result.stdout
      .split(/\r?\n/)
      .map(parseLine)
      .filter((process): process is ProcessSnapshot => process !== null);
    processes.sort((left, right) =>
      sort === "memory"
        ? right.memoryBytes - left.memoryBytes
        : right.cpuPercent - left.cpuPercent,
    );
    return {
      processes: processes.slice(0, safeLimit),
      total: processes.length,
      sort,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return {
      processes: [],
      total: 0,
      sort,
      capturedAt: new Date().toISOString(),
    };
  }
}

function parseLine(line: string): ProcessSnapshot | null {
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/,
  );
  if (!match) return null;
  const [, pid, ppid, user, cpu, memoryPercent, rss, command] = match;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    user: user ?? "",
    cpuPercent: Number(cpu),
    memoryPercent: Number(memoryPercent),
    memoryBytes: Number(rss) * 1024,
    command: (command ?? "").trim(),
  };
}
