import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DockerContainer,
  DockerSnapshot,
} from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);
const containerIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export async function getDockerSnapshot(): Promise<DockerSnapshot> {
  const capturedAt = new Date().toISOString();
  let serverVersion: string;
  try {
    const result = await execFileAsync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 2500, maxBuffer: 256 * 1024 },
    );
    serverVersion = result.stdout.trim();
  } catch (error) {
    const message = errorMessage(error);
    const cliInstalled = !/command not found|ENOENT|not found/i.test(message);
    return {
      cliInstalled,
      available: false,
      error: cliInstalled
        ? cleanDockerError(message)
        : "未找到 docker 命令，请先安装 Docker Desktop 或 colima",
      containers: [],
      capturedAt,
    };
  }

  try {
    const result = await execFileAsync(
      "docker",
      ["ps", "-a", "--format", "{{json .}}"],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
    );
    const containers = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseContainer)
      .filter((container): container is DockerContainer => container !== null);
    return {
      cliInstalled: true,
      available: true,
      serverVersion,
      containers,
      capturedAt,
    };
  } catch (error) {
    return {
      cliInstalled: true,
      available: true,
      serverVersion,
      error: cleanDockerError(errorMessage(error)),
      containers: [],
      capturedAt,
    };
  }
}

export async function runContainerAction(
  id: string,
  action: string,
): Promise<{ id: string; action: string; output: string }> {
  if (!containerIdPattern.test(id))
    throw new Error("Invalid container id or name");
  if (!["start", "stop", "restart"].includes(action))
    throw new Error(`Unsupported container action ${action}`);
  const result = await execFileAsync("docker", [action, id], {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return { id, action, output: result.stdout.trim() };
}

function parseContainer(line: string): DockerContainer | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const id = String(raw.ID ?? "");
    if (!id) return null;
    return {
      id: id.slice(0, 12),
      name: String(raw.Names ?? ""),
      image: String(raw.Image ?? ""),
      state: String(raw.State ?? ""),
      status: String(raw.Status ?? ""),
      ports: String(raw.Ports ?? ""),
    };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stderr?: unknown; message?: unknown };
    if (typeof record.stderr === "string" && record.stderr.trim())
      return record.stderr.trim();
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}

function cleanDockerError(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}
