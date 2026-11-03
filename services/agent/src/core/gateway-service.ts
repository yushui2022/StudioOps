import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GATEWAY_LABEL = "com.studioops.inference-gateway";
export const GATEWAY_ADMIN_PORT = Number(
  process.env.STUDIOOPS_GATEWAY_ADMIN_PORT ?? 11436,
);

export interface GatewayPaths {
  label: string;
  target: string;
  plistPath: string;
  scriptPath: string;
  logFile: string;
  errorFile: string;
  recordsFile: string;
  workingDirectory: string;
}

export interface GatewayPlist extends GatewayPaths {
  content: string;
}

export interface GatewayStatus {
  installed: boolean;
  running: boolean;
  launchdState?: string;
  pid?: number;
  version?: string;
  startedAt?: string;
  adminPort: number;
  adminUrl: string;
  memory?: GatewayMemoryStatus;
  records?: { file: string; error?: string };
  recordsFile?: string;
  backends: GatewayBackendStatus[];
  recent: GatewayRecentEvent[];
  error?: string;
}

export interface GatewayMemoryStatus {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
  budgetBytes: number;
  reserveBytes: number;
  pressure: "normal" | "elevated" | "high";
  updatedAt?: string;
  error?: string;
  ollama: {
    loadedModels: string[];
    maxLoadedModels: number;
  };
}

export interface GatewayBackendStatus {
  backend: string;
  listenPort: number;
  upstream: string;
  concurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
  active: number;
  queued: number;
  stats: Record<string, number>;
  activeJobs: GatewayJob[];
  queuedJobs: GatewayJob[];
}

export interface GatewayJob {
  id: string;
  backend: string;
  model?: string;
  method: string;
  path: string;
  client?: string;
  enqueuedAt: string;
  startedAt?: string;
  waitMs?: number;
  bytes: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface GatewayRecentEvent {
  id: string;
  backend: string;
  model?: string;
  state: string;
  method: string;
  path: string;
  client?: string;
  statusCode?: number;
  enqueuedAt: string;
  finishedAt?: string;
  waitMs?: number;
  durationMs?: number;
  bytes: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
}

export function gatewayPaths(dataDir: string): GatewayPaths {
  const workingDirectory = join(dataDir, "gateway");
  return {
    label: GATEWAY_LABEL,
    target: `gui/${currentUid()}/${GATEWAY_LABEL}`,
    plistPath: join(
      os.homedir(),
      "Library/LaunchAgents",
      `${GATEWAY_LABEL}.plist`,
    ),
    scriptPath: join(workingDirectory, "gateway.cjs"),
    logFile: join(dataDir, "logs", "gateway.log"),
    errorFile: join(dataDir, "logs", "gateway.err"),
    recordsFile: join(workingDirectory, "model-calls.jsonl"),
    workingDirectory,
  };
}

/** Locate the bundled gateway entry point for packaged and dev runs. */
export function findGatewayScript(rootDir: string): string | undefined {
  const candidates = [
    join(rootDir, "gateway.cjs"),
    join(rootDir, "dist", "gateway.cjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function buildGatewayPlist(options: {
  dataDir: string;
  nodePath: string;
}): GatewayPlist {
  const paths = gatewayPaths(options.dataDir);
  mkdirSync(dirname(paths.logFile), { recursive: true });
  mkdirSync(paths.workingDirectory, { recursive: true });
  const nodeDir = dirname(options.nodePath);
  const environment: Record<string, string> = {
    HOME: os.homedir(),
    PATH: `${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  // Persist explicit ports so the tunnel mapping and the gateway stay in sync.
  environment.STUDIOOPS_GATEWAY_OLLAMA_PORT = String(
    process.env.STUDIOOPS_GATEWAY_OLLAMA_PORT ?? 11435,
  );
  environment.STUDIOOPS_GATEWAY_COMFY_PORT = String(
    process.env.STUDIOOPS_GATEWAY_COMFY_PORT ?? 8191,
  );
  environment.STUDIOOPS_GATEWAY_ADMIN_PORT = String(GATEWAY_ADMIN_PORT);
  environment.STUDIOOPS_GATEWAY_RECORDS_FILE = paths.recordsFile;

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(paths.scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(
    ([key, value]) =>
      `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
  )
  .join("\n")}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.errorFile)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
  return { ...paths, content };
}

/**
 * Copy the bundled gateway next to the agent data, then (re)install its
 * LaunchAgent. The copy keeps launchd independent from the App bundle path.
 */
export async function installGateway(options: {
  rootDir: string;
  dataDir: string;
  nodePath?: string;
}): Promise<GatewayPlist> {
  const source = findGatewayScript(options.rootDir);
  if (!source)
    throw new Error(
      `Gateway bundle not found under ${options.rootDir}; run npm run build:gateway`,
    );
  const plist = buildGatewayPlist({
    dataDir: options.dataDir,
    nodePath: options.nodePath ?? process.execPath,
  });
  mkdirSync(plist.workingDirectory, { recursive: true });
  const temporary = `${plist.scriptPath}.tmp-${process.pid}`;
  copyFileSync(source, temporary);
  renameSync(temporary, plist.scriptPath);
  writePlist(plist);
  await launchctl(["bootout", plist.target], true);
  await launchctl(["enable", plist.target], true);
  await launchctl(["bootstrap", `gui/${currentUid()}`, plist.plistPath]);
  await launchctl(["kickstart", "-k", plist.target]);
  return plist;
}

/** Install only when the bundled gateway differs from the deployed copy. */
export async function ensureGatewayInstalled(options: {
  rootDir: string;
  dataDir: string;
  nodePath?: string;
}): Promise<{ installed: boolean; changed: boolean; reason: string }> {
  const source = findGatewayScript(options.rootDir);
  if (!source)
    return {
      installed: false,
      changed: false,
      reason: "Gateway bundle not found",
    };
  const plist = buildGatewayPlist({
    dataDir: options.dataDir,
    nodePath: options.nodePath ?? process.execPath,
  });
  const sourceHash = hashFile(source);
  const deployedHash = existsSync(plist.scriptPath)
    ? hashFile(plist.scriptPath)
    : undefined;
  const plistCurrent =
    existsSync(plist.plistPath) &&
    readFileSync(plist.plistPath, "utf8") === plist.content;
  const status = await readGatewayStatus();
  if (deployedHash === sourceHash && plistCurrent && status.running) {
    return {
      installed: true,
      changed: false,
      reason: "Gateway already current",
    };
  }
  if (deployedHash === sourceHash && plistCurrent && status.installed) {
    await launchctl(["kickstart", "-k", plist.target]);
    return {
      installed: true,
      changed: false,
      reason: "Gateway restarted because it was not running",
    };
  }
  await installGateway(options);
  return {
    installed: true,
    changed: true,
    reason: "Gateway installed or updated",
  };
}

export async function uninstallGateway(dataDir: string): Promise<void> {
  const paths = gatewayPaths(dataDir);
  await launchctl(["bootout", paths.target], true);
  await launchctl(["disable", paths.target], true);
  rmSync(paths.plistPath, { force: true });
}

export async function restartGateway(dataDir: string): Promise<void> {
  const paths = gatewayPaths(dataDir);
  if (!existsSync(paths.plistPath))
    throw new Error("Gateway LaunchAgent is not installed");
  await launchctl(["kickstart", "-k", paths.target]);
}

export async function readGatewayStatus(): Promise<GatewayStatus> {
  const base: GatewayStatus = {
    installed: false,
    running: false,
    adminPort: GATEWAY_ADMIN_PORT,
    adminUrl: `http://127.0.0.1:${GATEWAY_ADMIN_PORT}`,
    backends: [],
    recent: [],
  };
  const launchd = await launchdStatus();
  base.installed = launchd.installed;
  base.running = launchd.running;
  base.launchdState = launchd.state;
  base.pid = launchd.pid;
  try {
    const response = await fetch(
      `http://127.0.0.1:${GATEWAY_ADMIN_PORT}/status`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (!response.ok) {
      base.error = `Gateway admin returned ${response.status}`;
      return base;
    }
    const payload = (await response.json()) as {
      version?: string;
      startedAt?: string;
      adminPort?: number;
      pid?: number;
      memory?: GatewayMemoryStatus;
      records?: { file: string; error?: string };
      backends?: GatewayBackendStatus[];
      recent?: GatewayRecentEvent[];
    };
    base.running = true;
    base.installed = true;
    base.version = payload.version;
    base.startedAt = payload.startedAt;
    base.pid = payload.pid ?? base.pid;
    base.adminPort = payload.adminPort ?? base.adminPort;
    base.memory = payload.memory;
    base.records = payload.records;
    base.recordsFile = payload.records?.file;
    base.backends = payload.backends ?? [];
    base.recent = payload.recent ?? [];
    return base;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    return base;
  }
}

export interface GatewayRecord {
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
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
}

export async function readGatewayRecords(
  limit = 200,
): Promise<GatewayRecord[]> {
  const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
  const response = await fetch(
    `http://127.0.0.1:${GATEWAY_ADMIN_PORT}/records?limit=${safeLimit}`,
    { signal: AbortSignal.timeout(2500) },
  );
  if (!response.ok)
    throw new Error(`Gateway records returned ${response.status}`);
  const payload = (await response.json()) as { records?: GatewayRecord[] };
  return payload.records ?? [];
}

export async function cancelGatewayJob(
  id: string,
): Promise<{ cancelled: boolean; state?: string }> {
  const response = await fetch(
    `http://127.0.0.1:${GATEWAY_ADMIN_PORT}/queue/${encodeURIComponent(id)}/cancel`,
    { method: "POST", signal: AbortSignal.timeout(1500) },
  );
  if (response.status === 404) return { cancelled: false };
  if (!response.ok)
    throw new Error(`Gateway cancel failed with ${response.status}`);
  return (await response.json()) as { cancelled: boolean; state?: string };
}

async function launchdStatus(): Promise<{
  installed: boolean;
  running: boolean;
  state?: string;
  pid?: number;
}> {
  const paths = gatewayPaths(
    process.env.STUDIOOPS_DATA_DIR ??
      join(os.homedir(), "Library/Application Support/com.studioops.desktop"),
  );
  try {
    const { stdout } = await execFileAsync(
      "launchctl",
      ["print", paths.target],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    const state = stdout.match(/^\s*state = (.+)$/m)?.[1];
    const pid = stdout.match(/^\s*pid = (\d+)$/m)?.[1];
    return {
      installed: true,
      running: state === "running",
      state,
      pid: pid ? Number(pid) : undefined,
    };
  } catch {
    return { installed: existsSync(paths.plistPath), running: false };
  }
}

function writePlist(plist: GatewayPlist): void {
  mkdirSync(dirname(plist.plistPath), { recursive: true });
  const temporary = `${plist.plistPath}.tmp-${process.pid}`;
  writeFileSync(temporary, plist.content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, plist.plistPath);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

async function launchctl(args: string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("launchctl", args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (ignoreFailure) return;
    throw error;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
