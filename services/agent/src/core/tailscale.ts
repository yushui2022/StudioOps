import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download/mac";

type Runner = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TailscaleInfo {
  installed: boolean;
  binary?: string;
  running: boolean;
  online: boolean;
  backendState?: string;
  version?: string;
  hostname?: string;
  dnsName?: string;
  ips: string[];
  tailnet?: string;
  magicDnsEnabled?: boolean;
  error?: string;
}

export interface TailscaleServeProxy {
  host: string;
  path: string;
  target: string;
  tailnetUrl: string;
}

export interface TailscaleServeInfo {
  enabled: boolean;
  proxies: TailscaleServeProxy[];
  tailnetUrl?: string;
  error?: string;
}

interface RunnerOptions {
  binary?: string;
  run?: Runner;
}

/**
 * Resolve the CLI used by both the App Store and standalone macOS builds. The
 * GUI app ships the command inside the bundle; Homebrew and the standalone
 * installer put it on PATH.
 */
export async function findTailscaleBinary(
  options: RunnerOptions = {},
): Promise<string | undefined> {
  if (options.binary) return options.binary;
  const run = options.run ?? execFileAsync;
  const candidates = [
    process.env.STUDIOOPS_TAILSCALE,
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }
  try {
    const result = await run("which", ["tailscale"], { timeout: 2000 });
    const binary = result.stdout.trim();
    return binary || undefined;
  } catch {
    return undefined;
  }
}

export async function readTailscaleInfo(
  options: RunnerOptions = {},
): Promise<TailscaleInfo> {
  const run = options.run ?? execFileAsync;
  const binary = await findTailscaleBinary({ ...options, run });
  if (!binary) {
    return {
      installed: false,
      running: false,
      online: false,
      ips: [],
      error: "Tailscale 未安装",
    };
  }
  try {
    const result = await run(binary, ["status", "--json"], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { installed: true, binary, ...parseTailscaleStatus(result.stdout) };
  } catch (error) {
    return {
      installed: true,
      binary,
      running: false,
      online: false,
      ips: [],
      error: errorMessage(error),
    };
  }
}

export function parseTailscaleStatus(
  raw: string,
): Omit<TailscaleInfo, "installed" | "binary"> {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const self = asRecord(data.Self) ?? {};
  const tailnet = asRecord(data.CurrentTailnet);
  const backendState =
    typeof data.BackendState === "string" ? data.BackendState : undefined;
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
    : [];
  const dnsName =
    typeof self.DNSName === "string"
      ? self.DNSName.replace(/\.$/, "")
      : undefined;
  return {
    running: backendState === "Running",
    online: self.Online === true,
    backendState,
    version: typeof data.Version === "string" ? data.Version : undefined,
    hostname: typeof self.HostName === "string" ? self.HostName : undefined,
    dnsName,
    ips,
    tailnet: typeof tailnet?.Name === "string" ? tailnet.Name : undefined,
    magicDnsEnabled:
      typeof tailnet?.MagicDNSEnabled === "boolean"
        ? tailnet.MagicDNSEnabled
        : undefined,
  };
}

export async function readTailscaleServeInfo(
  options: RunnerOptions & { port: number },
): Promise<TailscaleServeInfo> {
  const run = options.run ?? execFileAsync;
  const binary = await findTailscaleBinary({ ...options, run });
  if (!binary) {
    return {
      enabled: false,
      proxies: [],
      tailnetUrl: undefined,
      error: "Tailscale 未安装",
    };
  }
  try {
    const result = await run(binary, ["serve", "status", "--json"], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseTailscaleServeStatus(result.stdout, options.port);
  } catch (error) {
    const message = errorMessage(error);
    if (/no serve config|not configured/i.test(message))
      return { enabled: false, proxies: [], tailnetUrl: undefined };
    return {
      enabled: false,
      proxies: [],
      tailnetUrl: undefined,
      error: message,
    };
  }
}

export function parseTailscaleServeStatus(
  raw: string,
  port: number,
): TailscaleServeInfo {
  const text = raw.trim();
  if (!text || /no serve config/i.test(text))
    return { enabled: false, proxies: [], tailnetUrl: undefined };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
      return {
        enabled: false,
        proxies: [],
        error: "无法解析 Tailscale Serve 状态",
      };
    data = JSON.parse(text.slice(start, end + 1));
  }

  const proxies: TailscaleServeProxy[] = [];
  collectProxies(data, undefined, proxies);
  const matching = proxies.filter((proxy) => targetPort(proxy.target) === port);
  return {
    enabled: matching.length > 0,
    proxies,
    tailnetUrl: matching[0]?.tailnetUrl,
  };
}

export function tailscaleServeArgs(enabled: boolean, port: number): string[] {
  return enabled
    ? ["serve", "--bg", String(port)]
    : ["serve", "--https=443", "off"];
}

export async function setTailscaleServe(options: {
  enabled: boolean;
  port: number;
  binary?: string;
  run?: Runner;
}): Promise<TailscaleServeInfo> {
  const run = options.run ?? execFileAsync;
  const binary = await findTailscaleBinary({ ...options, run });
  if (!binary)
    throw new Error(
      `Tailscale 未安装。请先安装并登录 Tailscale：${TAILSCALE_DOWNLOAD_URL}`,
    );
  const before = await readTailscaleServeInfo({
    binary,
    port: options.port,
    run,
  });
  if (options.enabled && before.enabled) return before;
  if (!options.enabled && !before.enabled) return before;
  if (options.enabled && before.proxies.length > 0)
    throw new Error(
      "Tailscale Serve 已有其他入口。请先在 Tailscale 中清理，避免覆盖现有服务。",
    );

  try {
    await run(binary, tailscaleServeArgs(options.enabled, options.port), {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Tailscale Serve 操作失败：${errorMessage(error)}`);
  }

  const after = await readTailscaleServeInfo({
    binary,
    port: options.port,
    run,
  });
  if (options.enabled && !after.enabled)
    throw new Error(
      after.error ??
        "Tailscale Serve 未生效。请确认 Tailnet 已启用 HTTPS 证书和 MagicDNS。",
    );
  return after;
}

function collectProxies(
  node: unknown,
  host: string | undefined,
  output: TailscaleServeProxy[],
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const valueRecord = asRecord(value);
    if (!valueRecord) continue;
    if (key === "Handlers" && host) {
      for (const [path, handler] of Object.entries(valueRecord)) {
        const handlerRecord = asRecord(handler);
        const target =
          typeof handlerRecord?.Proxy === "string"
            ? handlerRecord.Proxy
            : undefined;
        if (!target) continue;
        output.push({
          host,
          path,
          target,
          tailnetUrl: `https://${host.replace(/:443$/, "")}${path}`,
        });
      }
      continue;
    }
    const nextHost = key.includes(":") && !key.startsWith("/") ? key : host;
    collectProxies(value, nextHost, output);
  }
}

function targetPort(target: string): number | undefined {
  try {
    const url = new URL(target.includes("://") ? target : `http://${target}`);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    const match = target.match(/:(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
