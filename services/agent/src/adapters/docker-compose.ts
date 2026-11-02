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

export interface ComposeContainer {
  id: string;
  name: string;
  service: string;
  state: string;
  status: string;
  image: string;
  health?: string;
  ports?: string;
}

export function parseComposeContainers(stdout: string): ComposeContainer[] {
  const values: unknown[] = [];
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) values.push(...parsed);
    else values.push(parsed);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        // Ignore non-JSON compose warnings; the caller will treat them as empty.
      }
    }
  }
  return values
    .filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    )
    .map((row) => ({
      id: String(row.ID ?? row.Id ?? row.Name ?? ""),
      name: String(row.Name ?? row.Names ?? ""),
      service: String(row.Service ?? ""),
      state: String(row.State ?? "unknown"),
      status: String(row.Status ?? ""),
      image: String(row.Image ?? ""),
      health: row.Health ? String(row.Health) : undefined,
      ports: row.Ports ? String(row.Ports) : undefined,
    }))
    .filter((container) => container.name || container.id);
}

export class DockerComposeAdapter implements ServiceAdapter {
  readonly id = "docker-compose";

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    try {
      const [ps, services] = await Promise.all([
        this.run(definition, ["ps", "-a", "--format", "json"]),
        this.run(definition, ["config", "--services"]),
      ]);
      const containers = parseComposeContainers(ps.stdout);
      const expectedServices = services.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const running = containers.filter(
        (container) => container.state === "running",
      ).length;
      return {
        ...definition,
        state: running > 0 ? "running" : "stopped",
        details: {
          compose: {
            projectName: definition.projectName ?? definition.id,
            serviceCount: expectedServices.length || containers.length,
            runningCount: running,
            containers,
          },
        },
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...definition,
        state: "error",
        lastError:
          error instanceof Error ? error.message : "Docker unavailable",
        details: {
          compose: {
            projectName: definition.projectName ?? definition.id,
            serviceCount: 0,
            runningCount: 0,
            containers: [],
          },
        },
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

  private async run(definition: ServiceDefinition, args: string[]) {
    const composeFile = definition.composeFile ?? definition.target;
    const commandArgs = ["compose", "-f", resolve(composeFile)];
    if (definition.projectName) commandArgs.push("-p", definition.projectName);
    commandArgs.push(...args);
    try {
      return await execFileAsync("docker", commandArgs, {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(composeErrorMessage(error));
    }
  }
}

function composeErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stderr?: unknown; message?: unknown };
    if (typeof record.stderr === "string" && record.stderr.trim()) {
      const lines = record.stderr
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.slice(-4).join(" ").slice(0, 500);
    }
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}
