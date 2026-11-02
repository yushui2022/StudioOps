import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ServiceAction,
  ServiceDefinition,
  ServiceLog,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "./adapter.js";
import { ProcessAdapter } from "./process.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TOKEN_ENV = "TUNNEL_TOKEN";

export type CloudflaredMode = "quick" | "config" | "token";

export interface CloudflaredLogInfo {
  publicUrl?: string;
  lastError?: string;
}

export function tunnelModeOf(definition: ServiceDefinition): CloudflaredMode {
  if (definition.tunnelMode) return definition.tunnelMode;
  if (definition.tunnelConfig) return "config";
  if (definition.tokenEnv) return "token";
  return "quick";
}

/**
 * Build cloudflared arguments without ever putting a tunnel token on the
 * command line. The token mode relies on the TUNNEL_TOKEN environment variable.
 */
export function cloudflaredArgs(definition: ServiceDefinition): string[] {
  const mode = tunnelModeOf(definition);
  if (mode === "quick") {
    const target =
      definition.port !== undefined
        ? `http://127.0.0.1:${definition.port}`
        : definition.target;
    if (!/^https?:\/\//.test(target))
      throw new Error(
        "cloudflared quick 模式需要本地 port，或 target 使用 http(s) URL",
      );
    return ["tunnel", "--no-autoupdate", "--url", target];
  }
  if (mode === "config") {
    if (!definition.tunnelConfig)
      throw new Error("cloudflared config 模式需要 tunnelConfig");
    const configPath = resolve(definition.tunnelConfig);
    if (!existsSync(configPath))
      throw new Error(`cloudflared 配置文件不存在: ${configPath}`);
    return [
      "tunnel",
      "--no-autoupdate",
      "--config",
      configPath,
      "run",
      ...(definition.tunnelName ? [definition.tunnelName] : []),
    ];
  }
  return ["tunnel", "--no-autoupdate", "run"];
}

export function parseCloudflaredLog(
  lines: string[],
  fallbackUrl?: string,
): CloudflaredLogInfo {
  let publicUrl = fallbackUrl;
  let lastError: string | undefined;
  for (const raw of lines) {
    const line = raw
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    const quickUrl = line.match(
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    )?.[0];
    if (quickUrl) publicUrl = quickUrl;
    if (
      /(^|\s)(ERR|ERRO|FATAL|error|failed to)(\s|:)/i.test(line) &&
      !/no error/i.test(line)
    )
      lastError = line.slice(0, 320);
  }
  return { publicUrl, lastError };
}

export async function findCloudflaredBinary(
  configured = process.env.STUDIOOPS_CLOUDFLARED,
): Promise<string | undefined> {
  const candidates = [
    configured,
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    join(homedir(), ".local/bin/cloudflared"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }
  try {
    const result = await execFileAsync("which", ["cloudflared"], {
      timeout: 2000,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Proxy the cloudflared process through the existing process adapter so PID
 * identity, logs and start/stop semantics stay consistent. The normalized
 * definition deliberately removes `port`, otherwise process inspection would
 * mistake the local project listener for cloudflared itself.
 */
export class CloudflaredAdapter implements ServiceAdapter {
  readonly id = "cloudflared";
  private readonly process: ProcessAdapter;

  constructor(dataDir?: string) {
    this.process = new ProcessAdapter(dataDir);
  }

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const binary = await findCloudflaredBinary();
    if (!binary)
      return {
        ...definition,
        state: "error",
        lastError:
          "cloudflared 未安装。可运行 brew install cloudflared，或从 Cloudflare 下载后放入 PATH。",
        publicUrl: definition.publicUrl,
        updatedAt: new Date().toISOString(),
      };
    let processDefinition: ServiceDefinition;
    try {
      processDefinition = this.processDefinition(definition, binary);
    } catch (error) {
      return {
        ...definition,
        state: "error",
        lastError:
          error instanceof Error ? error.message : "Invalid tunnel config",
        publicUrl: definition.publicUrl,
        updatedAt: new Date().toISOString(),
      };
    }
    const snapshot = await this.process.inspect(processDefinition);
    const log = await this.process.logs(definition, 120).catch(() => undefined);
    const parsed = parseCloudflaredLog(log?.lines ?? [], definition.publicUrl);
    return {
      ...snapshot,
      adapter: definition.adapter,
      command: definition.command,
      args: definition.args,
      env: definition.env,
      cwd: definition.cwd,
      port: definition.port,
      publicUrl: parsed.publicUrl,
      lastError: parsed.lastError ?? snapshot.lastError,
      details: {
        ...snapshot.details,
        tunnelMode: tunnelModeOf(definition),
        publicUrl: parsed.publicUrl,
      },
    };
  }

  async execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot> {
    const binary = await findCloudflaredBinary();
    if (!binary)
      throw new Error(
        "cloudflared 未安装。可运行 brew install cloudflared，或从 Cloudflare 下载后放入 PATH。",
      );
    const processDefinition = this.processDefinition(definition, binary);
    await this.process.execute(processDefinition, action);
    return this.inspect(definition);
  }

  async logs(definition: ServiceDefinition, tail: number): Promise<ServiceLog> {
    return this.process.logs(definition, tail);
  }

  private processDefinition(
    definition: ServiceDefinition,
    binary: string,
  ): ServiceDefinition {
    const mode = tunnelModeOf(definition);
    const env = { ...(definition.env ?? {}) };
    if (mode === "token") {
      const tokenEnv = definition.tokenEnv ?? DEFAULT_TOKEN_ENV;
      const token = process.env[tokenEnv];
      if (!token)
        throw new Error(
          `环境变量 ${tokenEnv} 未设置，无法启动 cloudflared token 隧道`,
        );
      env.TUNNEL_TOKEN = token;
    }
    return {
      ...definition,
      command: binary,
      args: cloudflaredArgs(definition),
      env,
      port: undefined,
      health: { type: "none" },
    };
  }
}
