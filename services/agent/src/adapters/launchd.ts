import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ServiceAction,
  ServiceDefinition,
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
}
