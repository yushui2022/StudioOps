import { execFile } from "node:child_process";
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

export class DockerComposeAdapter implements ServiceAdapter {
  readonly id = "docker-compose";

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    try {
      const result = await this.run(definition, ["ps", "--format", "json"]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }
      const containers = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
        State?: string;
      }>;
      const running = containers.some(
        (container) => container.State === "running",
      );
      return {
        ...definition,
        state: running ? "running" : "stopped",
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...definition,
        state: "error",
        lastError:
          error instanceof Error ? error.message : "Docker unavailable",
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot> {
    if (!definition.allowedActions.includes(action))
      throw new Error(`Action ${action} is not allowed for ${definition.id}`);
    const command =
      action === "start"
        ? ["up", "-d"]
        : action === "stop"
          ? ["down"]
          : action === "restart"
            ? ["restart"]
            : null;
    if (!command)
      throw new Error(
        `Docker Compose does not support ${action} in the first adapter version`,
      );
    await this.run(definition, command);
    return this.inspect(definition);
  }

  async logs(definition: ServiceDefinition, tail: number): Promise<ServiceLog> {
    const result = await this.run(definition, [
      "logs",
      "--no-color",
      "--tail",
      String(tail),
    ]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    return {
      serviceId: definition.id,
      lines,
      source: definition.composeFile ?? definition.target,
      truncated: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  private run(definition: ServiceDefinition, args: string[]) {
    const composeFile = definition.composeFile ?? definition.target;
    const commandArgs = ["compose", "-f", resolve(composeFile)];
    if (definition.projectName) commandArgs.push("-p", definition.projectName);
    commandArgs.push(...args);
    return execFileAsync("docker", commandArgs, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}
