import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const STUDIOOPS_PREFIX = "com.studioops.";

export interface LaunchdAgent {
  label: string;
  plistPath: string;
  target: string;
  program?: string;
  args: string[];
  cwd?: string;
  stdoutPath?: string;
  stderrPath?: string;
  runAtLoad: boolean;
  keepAlive: boolean;
  loaded: boolean;
  pid?: number;
  lastExitStatus?: number;
  configuredServiceId?: string;
  suggestedId: string;
  suggestedName: string;
}

export interface LaunchdAgentOptions {
  home?: string;
  uid?: number;
  services?: ServiceDefinition[];
  run?: typeof execFileAsync;
}

export async function listLaunchdAgents(
  options: LaunchdAgentOptions = {},
): Promise<LaunchdAgent[]> {
  const home = options.home ?? homedir();
  const uid = options.uid ?? currentUid();
  const run = options.run ?? execFileAsync;
  const agentsDir = join(home, "Library/LaunchAgents");
  if (!existsSync(agentsDir)) return [];

  const loaded = await readLaunchctlList(run);
  const services = options.services ?? [];
  const existingIds = new Set(services.map((service) => service.id));
  const configured = new Map<string, string>();
  for (const service of services) {
    if (service.adapter !== "launchd") continue;
    const label = service.target.split("/").filter(Boolean).at(-1);
    if (label) configured.set(label, service.id);
  }

  const agents: LaunchdAgent[] = [];
  for (const name of readdirSync(agentsDir)) {
    if (!name.endsWith(".plist")) continue;
    const plistPath = join(agentsDir, name);
    const fallbackLabel = name.slice(0, -".plist".length);
    if (fallbackLabel.startsWith(STUDIOOPS_PREFIX)) continue;
    const parsed = await readLaunchdPlist(plistPath, run);
    const label = parsed?.Label ? String(parsed.Label) : fallbackLabel;
    if (label.startsWith(STUDIOOPS_PREFIX)) continue;
    const programArguments = Array.isArray(parsed?.ProgramArguments)
      ? parsed.ProgramArguments.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const program =
      typeof parsed?.Program === "string"
        ? parsed.Program
        : programArguments[0];
    const args =
      typeof parsed?.Program === "string"
        ? programArguments
        : programArguments.slice(1);
    const status = loaded.get(label);
    const configuredServiceId = configured.get(label);
    const suggestedId = uniqueId(suggestServiceId(label), existingIds);
    agents.push({
      label,
      plistPath,
      target: `gui/${uid}/${label}`,
      program,
      args,
      cwd:
        typeof parsed?.WorkingDirectory === "string"
          ? parsed.WorkingDirectory
          : undefined,
      stdoutPath:
        typeof parsed?.StandardOutPath === "string"
          ? parsed.StandardOutPath
          : undefined,
      stderrPath:
        typeof parsed?.StandardErrorPath === "string"
          ? parsed.StandardErrorPath
          : undefined,
      runAtLoad: parsed?.RunAtLoad === true,
      keepAlive: Boolean(parsed?.KeepAlive),
      loaded: Boolean(status),
      pid: status?.pid,
      lastExitStatus: status?.status,
      configuredServiceId,
      suggestedId,
      suggestedName: label,
    });
  }

  return agents.sort((left, right) => {
    if (left.loaded !== right.loaded) return left.loaded ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

export function parseLaunchctlList(
  stdout: string,
): Map<string, { pid?: number; status?: number }> {
  const result = new Map<string, { pid?: number; status?: number }>();
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3 || columns[0] === "PID") continue;
    const label = columns.slice(2).join(" ");
    if (!label) continue;
    const pid = Number(columns[0]);
    const status = Number(columns[1]);
    result.set(label, {
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      status: Number.isInteger(status) ? status : undefined,
    });
  }
  return result;
}

export function suggestServiceId(label: string): string {
  const stripped = label
    .replace(/^ai\.local\./, "")
    .replace(/^homebrew\.mxcl\./, "")
    .replace(/^com\./, "");
  const id = stripped
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 64);
  return id || "launchd-service";
}

export function parseLaunchdPlist(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readLaunchdPlist(
  plistPath: string,
  run: typeof execFileAsync,
): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await run(
      "plutil",
      ["-convert", "json", "-o", "-", plistPath],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    return parseLaunchdPlist(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

async function readLaunchctlList(
  run: typeof execFileAsync,
): Promise<Map<string, { pid?: number; status?: number }>> {
  try {
    const result = await run("launchctl", ["list"], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseLaunchctlList(result.stdout);
  } catch {
    return new Map();
  }
}

function uniqueId(base: string, existing: Set<string>): string {
  let id = base;
  let counter = 2;
  while (existing.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  existing.add(id);
  return id;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}
