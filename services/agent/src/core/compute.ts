import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import {
  readTailscaleInfo,
  readTailscaleSshStatus,
  setTailscaleSsh,
  type TailscaleSshStatus,
} from "./tailscale.js";

const execFileAsync = promisify(execFile);
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface ComputeAccount {
  username: string;
  exists: boolean;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
  admin: boolean;
  homeMode?: string;
  homeProtected?: boolean;
}

export interface ComputeSession {
  user: string;
  tty: string;
  from?: string;
  loginAt: string;
  raw: string;
}

export interface ComputeProcess {
  user: string;
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  elapsed: string;
  command: string;
  killable: boolean;
}

export interface ComputeSshStatus {
  port22: boolean;
  remoteLogin: "enabled" | "disabled";
  tailscale: {
    online: boolean;
    sshEnabled: boolean;
    sshSupported: boolean;
    ip?: string;
    dnsName?: string;
    sshError?: string;
  };
}

export interface ComputeOwnerHome {
  path: string;
  mode?: string;
  protected?: boolean;
}

export interface ComputeSnapshot {
  username: string;
  account: ComputeAccount;
  ownerHome: ComputeOwnerHome;
  sessions: ComputeSession[];
  loginHistory: string[];
  processes: ComputeProcess[];
  processCount: number;
  totalCpuPercent: number;
  totalMemoryBytes: number;
  diskBytes?: number;
  ssh: ComputeSshStatus;
  warnings: string[];
  capturedAt: string;
}

let diskCache:
  { username: string; home: string; bytes?: number; at: number } | undefined;

export async function getComputeSnapshot(
  username = "compute",
): Promise<ComputeSnapshot> {
  if (!USERNAME_PATTERN.test(username)) throw new Error("非法 compute 用户名");
  const account = await readComputeAccount(username);
  const [sessions, loginHistory, processes, diskBytes, ssh, ownerHome] =
    await Promise.all([
      readSessions(username),
      readLoginHistory(username),
      readComputeProcesses(username),
      account.home ? readDiskUsage(username, account.home) : undefined,
      readSshStatus(),
      readHomeProtection(os.homedir()),
    ]);
  const totalCpuPercent = processes.reduce(
    (sum, processInfo) => sum + processInfo.cpuPercent,
    0,
  );
  const totalMemoryBytes = processes.reduce(
    (sum, processInfo) => sum + processInfo.memoryBytes,
    0,
  );
  const warnings: string[] = [];
  if (!account.exists) warnings.push(`用户 ${username} 不存在`);
  if (account.admin) warnings.push(`${username} 在 admin 组，不建议给外部用户`);
  if (ownerHome.protected === false)
    warnings.push(
      `主账号主目录权限为 ${ownerHome.mode ?? "未知"}，${username} 可能读取部分目录`,
    );
  if (ssh.remoteLogin === "disabled")
    warnings.push("macOS Remote Login 未开启");
  if (ssh.tailscale.sshError)
    warnings.push(`Tailscale SSH 状态读取失败：${ssh.tailscale.sshError}`);
  return {
    username,
    account,
    ownerHome,
    sessions,
    loginHistory,
    processes,
    processCount: processes.length,
    totalCpuPercent,
    totalMemoryBytes,
    diskBytes,
    ssh,
    warnings,
    capturedAt: new Date().toISOString(),
  };
}

export async function setComputeTailscaleSsh(
  enabled: boolean,
): Promise<TailscaleSshStatus> {
  return setTailscaleSsh(enabled);
}

async function readHomeProtection(path: string): Promise<ComputeOwnerHome> {
  try {
    const stat = await execFileAsync("stat", ["-f", "%Sp", path], {
      timeout: 2000,
    });
    const mode = stat.stdout.trim();
    return { path, mode, protected: mode.slice(4) === "------" };
  } catch {
    return { path };
  }
}

async function readComputeAccount(username: string): Promise<ComputeAccount> {
  const base: ComputeAccount = {
    username,
    exists: false,
    admin: false,
  };
  try {
    const result = await execFileAsync(
      "dscl",
      [".", "-read", `/Users/${username}`],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    const values = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) values.set(match[1].trim(), match[2].trim());
    }
    const uid = Number(values.get("UniqueID"));
    const gid = Number(values.get("PrimaryGroupID"));
    const home = values.get("NFSHomeDirectory");
    const admin = await isAdminMember(username);
    let homeMode: string | undefined;
    let homeProtected: boolean | undefined;
    if (home) {
      try {
        const stat = await execFileAsync("stat", ["-f", "%Sp", home], {
          timeout: 2000,
        });
        homeMode = stat.stdout.trim();
        homeProtected = homeMode.slice(4) === "------";
      } catch {
        // The account may have no readable home directory.
      }
    }
    return {
      ...base,
      exists: true,
      uid: Number.isInteger(uid) ? uid : undefined,
      gid: Number.isInteger(gid) ? gid : undefined,
      home,
      shell: values.get("UserShell"),
      admin,
      homeMode,
      homeProtected,
    };
  } catch {
    return base;
  }
}

async function isAdminMember(username: string): Promise<boolean> {
  try {
    const result = await execFileAsync(
      "dscl",
      [".", "-read", "/Groups/admin", "GroupMembership"],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    return result.stdout
      .replace(/^GroupMembership:\s*/, "")
      .split(/\s+/)
      .includes(username);
  } catch {
    return false;
  }
}

export async function readSessions(
  username: string,
): Promise<ComputeSession[]> {
  try {
    const result = await execFileAsync("who", [], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    return parseWho(result.stdout, username);
  } catch {
    return [];
  }
}

export function parseWho(raw: string, username: string): ComputeSession[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): ComputeSession | undefined => {
      const hostMatch = line.match(/\(([^)]*)\)\s*$/);
      const from = hostMatch?.[1]?.trim();
      const body = hostMatch
        ? line.slice(0, hostMatch.index ?? line.length).trim()
        : line;
      const parts = body.split(/\s+/);
      if (parts.length < 3) return undefined;
      const user = parts[0];
      if (user !== username) return undefined;
      return {
        user,
        tty: parts[1],
        from,
        loginAt: parts.slice(2).join(" "),
        raw: line,
      };
    })
    .filter((session): session is ComputeSession => Boolean(session));
}

async function readLoginHistory(username: string): Promise<string[]> {
  try {
    const result = await execFileAsync("last", ["-n", "20", username], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    return parseLastHistory(result.stdout, username);
  } catch {
    return [];
  }
}

export function parseLastHistory(raw: string, username: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^wtmp begins/i.test(line) &&
        /^(\S+)\s+/.test(line) &&
        line.split(/\s+/)[0] === username,
    );
}

async function readComputeProcesses(
  username: string,
): Promise<ComputeProcess[]> {
  try {
    const result = await execFileAsync(
      "ps",
      ["-axo", "user=,pid=,ppid=,%cpu=,%mem=,rss=,etime=,command="],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseComputeProcesses(result.stdout, username);
  } catch {
    return [];
  }
}

export function parseComputeProcesses(
  raw: string,
  username: string,
): ComputeProcess[] {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(
        /^(\S+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/,
      );
      if (!match) return undefined;
      const user = match[1];
      if (user !== username) return undefined;
      const pid = Number(match[2]);
      if (!Number.isInteger(pid) || pid <= 1) return undefined;
      const command = match[8];
      return {
        user,
        pid,
        ppid: Number(match[3]),
        cpuPercent: Number(match[4]),
        memoryPercent: Number(match[5]),
        memoryBytes: Number(match[6]) * 1024,
        elapsed: match[7],
        command,
        killable: !/^(sshd|launchd|loginwindow)$/.test(
          command.split(/\s+/)[0] ?? "",
        ),
      };
    })
    .filter((processInfo): processInfo is ComputeProcess =>
      Boolean(processInfo),
    )
    .sort((left, right) => right.cpuPercent - left.cpuPercent)
    .slice(0, 100);
}

async function readDiskUsage(
  username: string,
  home: string,
): Promise<number | undefined> {
  const now = Date.now();
  if (
    diskCache &&
    diskCache.username === username &&
    diskCache.home === home &&
    now - diskCache.at < 60_000
  )
    return diskCache.bytes;
  try {
    const result = await execFileAsync("du", ["-sk", home], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const kilobytes = Number(result.stdout.trim().split(/\s+/)[0]);
    const bytes = Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined;
    diskCache = { username, home, bytes, at: now };
    return bytes;
  } catch {
    diskCache = { username, home, bytes: undefined, at: now };
    return undefined;
  }
}

async function readSshStatus(): Promise<ComputeSshStatus> {
  const [port22, tailscale, ssh] = await Promise.all([
    isPortListening(22),
    readTailscaleInfo(),
    readTailscaleSshStatus(),
  ]);
  return {
    port22,
    remoteLogin: port22 ? "enabled" : "disabled",
    tailscale: {
      online: tailscale.online,
      sshEnabled: ssh.enabled,
      sshSupported: ssh.supported,
      ip: tailscale.ips?.[0],
      dnsName: tailscale.dnsName,
      sshError: ssh.error,
    },
  };
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
