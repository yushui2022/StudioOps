import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);

export const STUDIOOPS_LAUNCH_AGENT_PREFIX = "com.studioops.";

export interface StudioOpsLaunchAgent {
  label: string;
  plistPath: string;
}

export interface BackupArchive {
  path: string;
  sizeBytes: number;
  createdAt: string;
  includes: string[];
}

type Runner = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface RemoveLaunchAgentOptions {
  home?: string;
  uid?: number;
  run?: Runner;
}

/**
 * Return only LaunchAgent plists owned by StudioOps. Other launch agents in the
 * user's Library directory are deliberately left untouched.
 */
export function listStudioOpsLaunchAgents(
  home = os.homedir(),
): StudioOpsLaunchAgent[] {
  const launchAgentsDir = join(home, "Library/LaunchAgents");
  if (!existsSync(launchAgentsDir)) return [];
  return readdirSync(launchAgentsDir)
    .filter(
      (name) =>
        name.startsWith(STUDIOOPS_LAUNCH_AGENT_PREFIX) &&
        name.endsWith(".plist"),
    )
    .sort()
    .map((name) => ({
      label: name.slice(0, -".plist".length),
      plistPath: join(launchAgentsDir, name),
    }));
}

/**
 * Boot out and delete every StudioOps LaunchAgent. Failures are collected so a
 * stale plist cannot prevent the rest of the uninstall from completing.
 */
export async function removeStudioOpsLaunchAgents(
  options: RemoveLaunchAgentOptions = {},
): Promise<{ removed: StudioOpsLaunchAgent[]; errors: string[] }> {
  const home = options.home ?? os.homedir();
  const uid = options.uid ?? currentUid();
  const run = options.run ?? execFileAsync;
  const removed: StudioOpsLaunchAgent[] = [];
  const errors: string[] = [];

  for (const agent of listStudioOpsLaunchAgents(home)) {
    try {
      await run("launchctl", ["bootout", `gui/${uid}/${agent.label}`], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // The agent may not be loaded; removing the plist is still required.
    }
    try {
      rmSync(agent.plistPath, { force: true });
      removed.push(agent);
    } catch (error) {
      errors.push(
        `${agent.label}: ${error instanceof Error ? error.message : "remove failed"}`,
      );
    }
  }

  return { removed, errors };
}

/**
 * Export services.yaml, SQLite, backups, PID metadata and logs before the App
 * is removed. The archive is written outside the data directory so it can be
 * safely kept while the original data is deleted.
 */
export async function createBackupArchive(options: {
  configPath: string;
  dataDir: string;
  destinationDir?: string;
  now?: Date;
  run?: Runner;
}): Promise<BackupArchive> {
  const home = os.homedir();
  const destinationDir = options.destinationDir ?? join(home, "Downloads");
  const now = options.now ?? new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const archivePath = join(destinationDir, `StudioOps-backup-${stamp}.tar.gz`);
  const includes: string[] = [];

  const configPath = resolve(options.configPath);
  const dataDir = resolve(options.dataDir);
  const args = [
    "-czf",
    archivePath,
    "--exclude",
    `${basename(dataDir)}/api-token`,
  ];
  if (pathInside(dataDir, archivePath))
    throw new Error(
      "Backup destination must be outside the StudioOps data directory",
    );

  if (existsSync(configPath) && !pathInside(dataDir, configPath)) {
    args.push("-C", dirname(configPath), basename(configPath));
    includes.push(configPath);
  }
  if (existsSync(dataDir)) {
    args.push("-C", dirname(dataDir), basename(dataDir));
    includes.push(dataDir);
  }
  if (includes.length === 0)
    throw new Error("No StudioOps configuration or data was found to export");

  mkdirSync(destinationDir, { recursive: true });
  const run = options.run ?? execFileAsync;
  try {
    await run("tar", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    rmSync(archivePath, { force: true });
    const message =
      error instanceof Error
        ? error.message
        : "Unable to create backup archive";
    throw new Error(`导出失败: ${message}`);
  }

  return {
    path: archivePath,
    sizeBytes: statSync(archivePath).size,
    createdAt: now.toISOString(),
    includes,
  };
}

/** Convert a persisted project back into a normal process definition. */
export function resetPersistedProject(
  definition: ServiceDefinition,
): ServiceDefinition {
  return {
    ...definition,
    adapter: "process",
    target: definition.cwd ?? definition.command ?? definition.id,
    plistFile: undefined,
    persisted: undefined,
    persistenceLabel: undefined,
    autostart: undefined,
    allowedActions: ["start", "stop", "restart", "pause", "resume"],
  };
}

export function isStudioOpsProject(definition: ServiceDefinition): boolean {
  return (
    definition.category === "project" ||
    definition.persisted === true ||
    definition.persistenceLabel?.startsWith(
      `${STUDIOOPS_LAUNCH_AGENT_PREFIX}project.`,
    ) === true
  );
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}
