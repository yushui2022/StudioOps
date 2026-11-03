import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WarpgateSettings {
  host?: string;
  sshPort?: number;
  adminPort?: number;
  container?: string;
  target?: string;
  user?: string;
}

export interface WarpgateConfig {
  mode: "vps" | "local";
  host?: string;
  sshPort: number;
  adminPort: number;
  container: string;
  target: string;
  user: string;
}

export function readWarpgateSettings(): WarpgateSettings {
  const dataDir = process.env.STUDIOOPS_DATA_DIR;
  if (!dataDir) return {};
  try {
    return JSON.parse(
      readFileSync(join(dataDir, "warpgate.json"), "utf8"),
    ) as WarpgateSettings;
  } catch {
    return {};
  }
}

export function resolveWarpgateConfig(): WarpgateConfig {
  const settings = readWarpgateSettings();
  const host =
    process.env.WARPGATE_HOST?.trim() || settings.host?.trim() || undefined;
  return {
    mode: host ? "vps" : "local",
    host,
    sshPort: Number(process.env.WARPGATE_SSH_PORT ?? settings.sshPort ?? 2222),
    adminPort: Number(
      process.env.WARPGATE_ADMIN_PORT ?? settings.adminPort ?? 18888,
    ),
    container:
      process.env.WARPGATE_CONTAINER ??
      settings.container ??
      "studioops-warpgate",
    target: process.env.WARPGATE_TARGET ?? settings.target ?? "mac-compute",
    user: process.env.WARPGATE_USER ?? settings.user ?? "compute-guest",
  };
}

export function warpgateDataFile(name: string): string | undefined {
  const dataDir = process.env.STUDIOOPS_DATA_DIR;
  return dataDir ? join(dataDir, name) : undefined;
}
