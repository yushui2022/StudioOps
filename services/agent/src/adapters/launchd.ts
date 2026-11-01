import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type {
  ServiceAction,
  ServiceDefinition,
  ServiceLog,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "./adapter.js";

const execFileAsync = promisify(execFile);

/**
 * launchd adapter boundary. The target is a configured label, never a client supplied path
 * or shell fragment. The command mapping mirrors mac-dash's explicit action whitelist.
 */
export class LaunchdAdapter implements ServiceAdapter {
  readonly id = "launchd";

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    try {
      await execFileAsync("launchctl", ["print", definition.target]);
      return {
        ...definition,
        state: "running",
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

    const command =
      action === "start" || action === "restart"
        ? "kickstart"
        : action === "stop"
          ? "kill"
          : null;
    if (!command) {
      throw new Error(
        `launchd does not support ${action} in the first adapter version`,
      );
    }

    const args =
      command === "kickstart"
        ? ["-k", definition.target]
        : ["SIGTERM", definition.target];
    await execFileAsync("launchctl", args);
    return this.inspect(definition);
  }

  async logs(definition: ServiceDefinition, tail: number): Promise<ServiceLog> {
    if (!definition.logFile || !existsSync(resolve(definition.logFile))) {
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
