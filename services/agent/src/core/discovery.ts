import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type {
  DiscoveredProcess,
  DiscoveredSnapshot,
  ServiceDefinition,
} from "../../../../packages/contracts/src/index.js";
import { evaluateKillability, listAncestorPids } from "./process-list.js";

const execFileAsync = promisify(execFile);
const ignoredPorts = new Set([7227, 11434, 8188]);

interface Listener {
  pid: number;
  command: string;
  ports: number[];
}

/**
 * Discover local development servers from listening TCP sockets. A process is
 * only surfaced when it belongs to the current user and its working directory
 * is inside the user's home folder, which filters out system daemons and app
 * bundles while keeping Node/Python/Go/Rust projects visible.
 */
export async function listDiscoveredProcesses(
  definitions: ServiceDefinition[],
): Promise<DiscoveredSnapshot> {
  const capturedAt = new Date().toISOString();
  const empty: DiscoveredSnapshot = {
    processes: [],
    capturedAt,
  };
  let listeners: Listener[];
  try {
    listeners = await readListeners();
  } catch {
    return empty;
  }
  if (!listeners.length) return empty;

  const configuredPorts = new Set(
    definitions
      .map((definition) => definition.port)
      .filter((port): port is number => Number.isFinite(port)),
  );
  const currentUser = os.userInfo().username;
  const home = os.homedir();
  const ancestors = await listAncestorPids(process.pid);
  const processes: DiscoveredProcess[] = [];

  for (const listener of listeners.slice(0, 60)) {
    if (listener.pid <= 1 || ancestors.includes(listener.pid)) continue;
    const port = listener.ports.find(
      (candidate) =>
        candidate >= 1024 &&
        !ignoredPorts.has(candidate) &&
        !configuredPorts.has(candidate),
    );
    if (!port) continue;
    const details = await readProcessDetails(listener.pid);
    if (!details) continue;
    if (details.user !== currentUser) continue;
    const cwd = await readWorkingDirectory(listener.pid);
    if (!cwd || !isUserProjectPath(cwd, home)) continue;
    if (looksLikeAppBundle(details.args)) continue;
    const guard = evaluateKillability(
      { ...details, command: details.args },
      currentUser,
      ancestors,
    );
    const argv = splitCommand(details.args);
    const projectName = cwd.split("/").filter(Boolean).at(-1) ?? "project";
    processes.push({
      pid: listener.pid,
      ppid: details.ppid,
      user: details.user,
      name: projectName,
      command: argv[0] ?? listener.command,
      args: argv.slice(1),
      cwd,
      port,
      cpuPercent: details.cpuPercent,
      memoryPercent: details.memoryPercent,
      memoryBytes: details.memoryBytes,
      suggestedId: slug(`${projectName}-${port}`),
      killable: guard.killable,
      protectedReason: guard.protectedReason,
    });
  }

  processes.sort((left, right) => left.port - right.port);
  return { processes, capturedAt };
}

async function readListeners(): Promise<Listener[]> {
  const result = await execFileAsync(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
    { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  const listeners = new Map<number, Listener>();
  let current: Listener | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const type = line[0];
    const value = line.slice(1);
    if (type === "p") {
      const pid = Number(value);
      if (!Number.isInteger(pid)) {
        current = undefined;
        continue;
      }
      current = listeners.get(pid) ?? {
        pid,
        command: "",
        ports: [],
      };
      listeners.set(pid, current);
    } else if (type === "c" && current) {
      current.command = value;
    } else if (type === "n" && current) {
      const match = value.match(/:(\d+)$/);
      if (match) current.ports.push(Number(match[1]));
    }
  }
  return [...listeners.values()];
}

async function readProcessDetails(pid: number): Promise<{
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  args: string;
} | null> {
  try {
    const result = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "pid=,ppid=,user=,%cpu=,%mem=,rss=,args="],
      { timeout: 2000, maxBuffer: 512 * 1024 },
    );
    const line = result.stdout.trim();
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/,
    );
    if (!match) return null;
    const [, processId, ppid, user, cpu, memoryPercent, rss, args] = match;
    return {
      pid: Number(processId),
      ppid: Number(ppid),
      user: user ?? "",
      cpuPercent: Number(cpu),
      memoryPercent: Number(memoryPercent),
      memoryBytes: Number(rss) * 1024,
      args: (args ?? "").trim(),
    };
  } catch {
    return null;
  }
}

async function readWorkingDirectory(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { timeout: 2000, maxBuffer: 256 * 1024 },
    );
    return result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n"))
      ?.slice(1);
  } catch {
    return undefined;
  }
}

function isUserProjectPath(path: string, home: string): boolean {
  if (!path.startsWith(`${home}/`)) return false;
  if (path.startsWith(`${home}/Library/`)) return false;
  if (path.startsWith(`${home}/.`)) return false;
  if (path.startsWith(`${home}/Applications/`)) return false;
  return true;
}

function looksLikeAppBundle(args: string): boolean {
  return /\/Applications\/|\.app\/Contents\/|\/System\/|\/usr\/libexec\//.test(
    args,
  );
}

function splitCommand(args: string): string[] {
  return (
    args
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
