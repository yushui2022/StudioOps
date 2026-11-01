import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SystemSnapshot } from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const [disk, silicon] = await Promise.all([readDisk(), readSilicon()]);
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: os.uptime(),
    load: os.loadavg(),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    disk,
    silicon,
    updatedAt: new Date().toISOString(),
  };
}

async function readDisk(): Promise<SystemSnapshot["disk"]> {
  try {
    const result = await execFileAsync("df", ["-Pk", "/"], {
      timeout: 1500,
    });
    const line =
      result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
    const totalBytes = Number(line[1]) * 1024;
    const freeBytes = Number(line[3]) * 1024;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes))
      return undefined;
    return { totalBytes, freeBytes };
  } catch {
    return undefined;
  }
}

async function readSilicon(): Promise<SystemSnapshot["silicon"]> {
  try {
    const result = await execFileAsync(
      "macmon",
      ["pipe", "--samples", "1", "--interval", "100"],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    const temp =
      data.temp && typeof data.temp === "object"
        ? (data.temp as Record<string, unknown>)
        : {};
    return {
      cpuPercent: numberOrUndefined(data.cpu_usage_pct),
      gpuPercent: ratioPercent(data.gpu_active_ratio),
      anePercent: ratioPercent(data.ane_active_ratio),
      powerWatts: numberOrUndefined(data.all_power),
      cpuTemperatureC: numberOrUndefined(temp.cpu_temp_avg),
      gpuTemperatureC: numberOrUndefined(temp.gpu_temp_avg),
    };
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function ratioPercent(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  return number === undefined ? undefined : number * 100;
}
