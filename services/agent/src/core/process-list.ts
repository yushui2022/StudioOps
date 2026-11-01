import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type {
  ProcessListSnapshot,
  ProcessSnapshot,
} from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const protectedNames = new Set([
  "launchd",
  "kernel_task",
  "WindowServer",
  "loginwindow",
  "securityd",
  "tccd",
  "opendirectoryd",
]);

export interface Killability {
  killable: boolean;
  protectedReason?: string;
}

export function evaluateKillability(
  processInfo: ProcessSnapshot,
  currentUser = os.userInfo().username,
  protectedPids: Iterable<number> = [process.pid, process.ppid],
): Killability {
  const protectedSet = new Set([
    process.pid,
    process.ppid,
    1,
    ...protectedPids,
  ]);
  if (processInfo.pid <= 1)
    return { killable: false, protectedReason: "系统进程" };
  if (protectedSet.has(processInfo.pid))
    return { killable: false, protectedReason: "StudioOps 进程链" };
  if (processInfo.user !== currentUser)
    return { killable: false, protectedReason: "非当前用户进程" };
  const name = processInfo.command.split("/").pop() ?? processInfo.command;
  if (protectedNames.has(name))
    return { killable: false, protectedReason: "系统关键进程" };
  return { killable: true };
}

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
    const currentUser = os.userInfo().username;
    const protectedPids = await listAncestorPids(process.pid);
    const processes = result.stdout
      .split(/\r?\n/)
      .map(parseLine)
      .filter((process): process is ProcessSnapshot => process !== null)
      .map((processInfo) => ({
        ...processInfo,
        ...evaluateKillability(processInfo, currentUser, protectedPids),
      }));
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

export async function listAncestorPids(pid: number): Promise<number[]> {
  const result = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < 24; depth += 1) {
    try {
      const parent = await execFileAsync("ps", [
        "-p",
        String(current),
        "-o",
        "ppid=",
      ]);
      const ppid = Number(parent.stdout.trim());
      if (!Number.isInteger(ppid) || ppid <= 1 || result.has(ppid)) break;
      result.add(ppid);
      current = ppid;
    } catch {
      break;
    }
  }
  return [...result];
}

export async function findProcess(
  pid: number,
): Promise<ProcessSnapshot | undefined> {
  try {
    const result = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "pid=,ppid=,user=,%cpu=,%mem=,rss=,comm="],
      { timeout: 3000, maxBuffer: 256 * 1024 },
    );
    return parseLine(result.stdout.trim()) ?? undefined;
  } catch {
    return undefined;
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
