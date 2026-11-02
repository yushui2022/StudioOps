import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const LABEL_PREFIX = "com.studioops.project.";

export interface ProjectPlist {
  label: string;
  target: string;
  plistPath: string;
  logFile: string;
  content: string;
}

/**
 * Turn a project process into a user LaunchAgent. This is intentionally
 * separate from the process adapter: after installation the project should be
 * managed through launchctl (survives App exits and reboot).
 */
export async function buildProjectPlist(
  definition: ServiceDefinition,
  dataDir: string,
): Promise<ProjectPlist> {
  if (!definition.command)
    throw new Error("Project service needs a command before it can persist");
  const command = await resolveCommand(definition.command);
  const cwd = resolveWorkingDirectory(definition);
  const label = `${LABEL_PREFIX}${definition.id}`;
  const plistPath = join(
    os.homedir(),
    "Library/LaunchAgents",
    `${label}.plist`,
  );
  const logFile =
    definition.logFile ?? join(dataDir, "logs", `${definition.id}.log`);
  const errorFile = `${logFile}.err`;
  const environment = {
    HOME: os.homedir(),
    PATH:
      process.env.PATH ??
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...(definition.env ?? {}),
  };
  const args = [command, ...(definition.args ?? [])];
  mkdirSync(dirname(logFile), { recursive: true });
  mkdirSync(dirname(errorFile), { recursive: true });

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
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
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errorFile)}</string>
  <key>RunAtLoad</key>
  <${definition.autostart === false ? "false" : "true"}/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
  return {
    label,
    target: `gui/${currentUid()}/${label}`,
    plistPath,
    logFile,
    content,
  };
}

export function writeProjectPlist(project: ProjectPlist): void {
  mkdirSync(dirname(project.plistPath), { recursive: true });
  const temporary = `${project.plistPath}.tmp-${process.pid}`;
  writeFileSync(temporary, project.content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, project.plistPath);
}

export async function installProjectPlist(
  project: ProjectPlist,
): Promise<void> {
  writeProjectPlist(project);

  await launchctl(["bootout", project.target], true);
  await launchctl(["enable", project.target], true);
  try {
    await launchctl(["bootstrap", `gui/${currentUid()}`, project.plistPath]);
  } catch (error) {
    rmSync(project.plistPath, { force: true });
    throw error;
  }
}

export async function startProjectPlist(label: string): Promise<void> {
  await launchctl(["kickstart", "-k", `gui/${currentUid()}/${label}`]);
}

export async function removeProjectPlist(
  definition: ServiceDefinition,
): Promise<string> {
  const label =
    definition.persistenceLabel ??
    definition.target.split("/").filter(Boolean).at(-1);
  if (!label || !label.startsWith(LABEL_PREFIX))
    throw new Error("Service is not a StudioOps project LaunchAgent");
  const plistPath = join(
    os.homedir(),
    "Library/LaunchAgents",
    `${label}.plist`,
  );
  await launchctl(["bootout", `gui/${currentUid()}/${label}`], true);
  rmSync(plistPath, { force: true });
  return label;
}

async function resolveCommand(command: string): Promise<string> {
  if (isAbsolute(command)) {
    if (existsSync(command)) return command;
    throw new Error(`Command not found: ${command}`);
  }
  try {
    const result = await execFileAsync("which", [command], {
      timeout: 3000,
    });
    const resolved = result.stdout.trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // Fall through to the clear error below.
  }
  throw new Error(`Command not found in PATH: ${command}`);
}

function resolveWorkingDirectory(definition: ServiceDefinition): string {
  if (definition.cwd) {
    if (!statSync(definition.cwd).isDirectory())
      throw new Error(`Working directory does not exist: ${definition.cwd}`);
    return definition.cwd;
  }
  if (definition.target.startsWith("/") && existsSync(definition.target))
    return definition.target;
  throw new Error("Project service needs a cwd before it can persist");
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
