import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type {
  ServiceAction,
  ServiceDefinition,
  ServiceLog,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "./adapter.js";
import { readProcessMetrics } from "../core/process-metrics.js";

const execFileAsync = promisify(execFile);

/**
 * Map a StudioOps action to explicit launchctl arguments. Kept separate from
 * execute() so the command shape is unit-testable.
 */
export function launchctlArgsFor(
  action: ServiceAction,
  target: string,
): string[] | null {
  if (action === "start" || action === "restart")
    return ["kickstart", "-k", target];
  if (action === "stop") return ["bootout", target];
  return null;
}

function domainOf(target: string): string {
  const separator = target.lastIndexOf("/");
  return separator > 0 ? target.slice(0, separator) : "gui/501";
}

function labelOf(target: string): string {
  const separator = target.lastIndexOf("/");
  return separator >= 0 ? target.slice(separator + 1) : target;
}

/**
 * launchd adapter boundary. The target is a configured label, never a client supplied path
 * or shell fragment. The command mapping mirrors mac-dash's explicit action whitelist.
 */
export class LaunchdAdapter implements ServiceAdapter {
  readonly id = "launchd";
  private readonly plistPaths = new Map<string, string>();

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    try {
      const result = await execFileAsync(
        "launchctl",
        ["print", definition.target],
        { timeout: 3000, maxBuffer: 1024 * 1024 },
      );
      const pathMatch = result.stdout.match(/^\s*path = (.+)$/m);
      if (pathMatch?.[1]) this.plistPaths.set(definition.target, pathMatch[1]);
      const pidMatch = result.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
      const pid = pidMatch ? Number(pidMatch[1]) : undefined;
      return {
        ...definition,
        state: "running",
        pid,
        ...(pid ? await readProcessMetrics(pid) : {}),
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return {
        ...definition,
        state: "stopped",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot> {
    if (!definition.allowedActions.includes(action)) {
      throw new Error(`Action ${action} is not allowed for ${definition.id}`);
    }

    const args = launchctlArgsFor(action, definition.target);
    if (!args) {
      throw new Error(
        `launchd does not support ${action} in the first adapter version`,
      );
    }

    if (action === "stop") {
      try {
        await execFileAsync("launchctl", args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/could not find service|no such process/i.test(message))
          throw error;
      }
      return this.inspect(definition);
    }

    try {
      await execFileAsync("launchctl", args);
    } catch (error) {
      // A booted-out job cannot be kickstarted; bootstrap its plist first.
      const plistFile = this.resolvePlistFile(definition);
      if (!plistFile)
        throw new Error(
          `Cannot start ${definition.id}: launchctl kickstart failed and no plist file is configured`,
        );
      await execFileAsync("launchctl", [
        "bootstrap",
        domainOf(definition.target),
        plistFile,
      ]);
      await execFileAsync("launchctl", args);
    }
    return this.inspect(definition);
  }

  private resolvePlistFile(definition: ServiceDefinition): string | undefined {
    if (definition.plistFile && existsSync(definition.plistFile))
      return definition.plistFile;
    const cached = this.plistPaths.get(definition.target);
    if (cached && existsSync(cached)) return cached;
    const label = labelOf(definition.target);
    const candidates = [
      resolve(homedir(), "Library/LaunchAgents", `${label}.plist`),
      `/Library/LaunchAgents/${label}.plist`,
      `/Library/LaunchDaemons/${label}.plist`,
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  async logs(definition: ServiceDefinition, tail: number): Promise<ServiceLog> {
    if (!definition.logFile || !existsSync(resolve(definition.logFile))) {
      try {
        const result = await execFileAsync(
          "launchctl",
          ["print", definition.target],
          { timeout: 3000, maxBuffer: 1024 * 1024 },
        );
        const lines = result.stdout.split(/\r?\n/).filter(Boolean);
        return {
          serviceId: definition.id,
          lines: lines.slice(-tail),
          source: `launchctl print ${definition.target}`,
          truncated: lines.length > tail,
          fetchedAt: new Date().toISOString(),
        };
      } catch {
        // Fall through to a clear message when the job is not loaded.
      }
      return {
        serviceId: definition.id,
        lines: ["No logFile configured for this launchd service."],
        source: definition.logFile ?? "none",
        truncated: false,
        fetchedAt: new Date().toISOString(),
      };
    }
    const lines = readFileSync(resolve(definition.logFile), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    return {
      serviceId: definition.id,
      lines: lines.slice(-tail),
      source: resolve(definition.logFile),
      truncated: lines.length > tail,
      fetchedAt: new Date().toISOString(),
    };
  }
}
