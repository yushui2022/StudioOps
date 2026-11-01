import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type {
  InferenceProcess,
  InferenceSnapshot,
  ServiceDefinition,
} from "../../../../packages/contracts/src/index.js";
import { evaluateKillability, listAncestorPids } from "./process-list.js";

const execFileAsync = promisify(execFile);
type InferenceRole = "ollama" | "comfyui";

interface RawProcess {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  command: string;
}

/**
 * Find Ollama/ComfyUI processes and their descendants. Model runners are often
 * child processes without the service name in their path, so the process tree
 * matters more than a single command match.
 */
export async function listInferenceProcesses(
  definitions: ServiceDefinition[],
): Promise<InferenceSnapshot> {
  const capturedAt = new Date().toISOString();
  const empty: InferenceSnapshot = {
    processes: [],
    totalMemoryBytes: 0,
    systemMemoryBytes: os.totalmem(),
    capturedAt,
  };
  let processes: RawProcess[];
  try {
    const result = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,user=,%cpu=,%mem=,rss=,args="],
      { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
    );
    processes = result.stdout
      .split(/\r?\n/)
      .map(parseLine)
      .filter((processInfo): processInfo is RawProcess => processInfo !== null);
  } catch {
    return empty;
  }

  const included = new Map<number, InferenceRole>();
  for (const processInfo of processes) {
    const role = detectRole(processInfo.command);
    if (role) included.set(processInfo.pid, role);
  }
  // Pull in child processes (model runners, workers) of any matched process.
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (included.has(processInfo.pid)) continue;
      const parentRole = included.get(processInfo.ppid);
      if (!parentRole) continue;
      included.set(processInfo.pid, parentRole);
      changed = true;
    }
  }
  if (!included.size) return empty;

  const protectedPids = await listAncestorPids(process.pid);
  const serviceByRole = new Map<InferenceRole, string>();
  for (const definition of definitions) {
    if (definition.kind === "ollama")
      serviceByRole.set("ollama", definition.id);
    if (definition.kind === "comfyui")
      serviceByRole.set("comfyui", definition.id);
  }

  const list: InferenceProcess[] = [];
  for (const processInfo of processes) {
    const role = included.get(processInfo.pid);
    if (!role) continue;
    const isRoot = !included.has(processInfo.ppid);
    const guard = evaluateKillability(
      processInfo,
      os.userInfo().username,
      protectedPids,
    );
    list.push({
      serviceRoot: isServiceRoot(role, processInfo.command, isRoot),
      pid: processInfo.pid,
      ppid: processInfo.ppid,
      user: processInfo.user,
      command: processInfo.command,
      name: displayName(role, processInfo.command, isRoot),
      role,
      serviceId: serviceByRole.get(role),
      cpuPercent: processInfo.cpuPercent,
      memoryPercent: processInfo.memoryPercent,
      memoryBytes: processInfo.memoryBytes,
      isRoot,
      killable: guard.killable,
      protectedReason: guard.protectedReason,
    });
  }
  list.sort((left, right) => right.memoryBytes - left.memoryBytes);
  return {
    processes: list,
    totalMemoryBytes: list.reduce(
      (sum, processInfo) => sum + processInfo.memoryBytes,
      0,
    ),
    systemMemoryBytes: os.totalmem(),
    capturedAt,
  };
}

function isServiceRoot(
  role: InferenceRole,
  command: string,
  isRoot: boolean,
): boolean {
  if (!isRoot) return false;
  if (role === "ollama")
    return (
      /\/Ollama\.app\//i.test(command) || /\bollama\s+serve\b/i.test(command)
    );
  return /(?:^|\s)main\.py\b.*--port\s+8188/i.test(command);
}

export function detectRole(command: string): InferenceRole | undefined {
  if (
    /\/Ollama\.app\//i.test(command) ||
    /\bollama\s+(serve|runner)\b/i.test(command) ||
    /(^|\s)\/ollama(\s|$)/i.test(command)
  )
    return "ollama";
  if (
    /\/ComfyUI\//i.test(command) ||
    /comfy_openai_bridge/i.test(command) ||
    /(?:^|\s)main\.py\b.*--port\s+8188/i.test(command)
  )
    return "comfyui";
  return undefined;
}

function displayName(
  role: InferenceRole,
  command: string,
  isRoot: boolean,
): string {
  if (role === "ollama")
    return /runner/i.test(command)
      ? "Ollama Runner"
      : isRoot
        ? "Ollama"
        : "Ollama Helper";
  if (/comfy_openai_bridge/i.test(command)) return "ComfyUI Bridge";
  return isRoot ? "ComfyUI" : "ComfyUI Worker";
}

function parseLine(line: string): RawProcess | null {
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
