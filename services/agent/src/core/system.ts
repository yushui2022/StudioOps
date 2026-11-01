import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SystemSnapshot } from "../../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);

type HardwareInfo = NonNullable<SystemSnapshot["hardware"]>;
let hardwarePromise: Promise<HardwareInfo> | undefined;

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const hardware = await getHardwareInfo();
  const [disk, macmon, fallbackMemory] = await Promise.all([
    readDisk(),
    readMacmon(hardware),
    readMemory(),
  ]);
  const memory = macmon.memory ?? fallbackMemory;
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: os.uptime(),
    load: os.loadavg(),
    memory,
    cpuCount: hardware.totalCores || os.cpus().length,
    hardware,
    disk,
    silicon: macmon.silicon,
    updatedAt: new Date().toISOString(),
  };
}

export function getHardwareInfo(): Promise<HardwareInfo> {
  hardwarePromise ??= readHardwareInfo();
  return hardwarePromise;
}

async function readHardwareInfo(): Promise<HardwareInfo> {
  const fallback: HardwareInfo = {
    chip: os.cpus()[0]?.model?.trim() || "Mac",
    superCores: 0,
    performanceCores: os.cpus().length,
    totalCores: os.cpus().length,
  };
  try {
    const [brand, names, counts, ioreg] = await Promise.all([
      execFileAsync("sysctl", ["-n", "machdep.cpu.brand_string"], {
        timeout: 1500,
      }),
      execFileAsync(
        "sysctl",
        ["-n", "hw.perflevel0.name", "hw.perflevel1.name"],
        { timeout: 1500 },
      ),
      execFileAsync(
        "sysctl",
        ["-n", "hw.perflevel0.logicalcpu", "hw.perflevel1.logicalcpu"],
        { timeout: 1500 },
      ),
      execFileAsync("ioreg", ["-l"], {
        timeout: 4000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]);
    const levelNames = names.stdout.trim().split(/\r?\n/);
    const levelCounts = counts.stdout.trim().split(/\r?\n/).map(Number);
    let superCores = 0;
    let performanceCores = 0;
    levelNames.forEach((name, index) => {
      const count = levelCounts[index];
      if (!Number.isFinite(count)) return;
      if (/super/i.test(name)) superCores += count;
      else if (/performance/i.test(name)) performanceCores += count;
    });
    if (!superCores && !performanceCores) performanceCores = os.cpus().length;
    const gpuCores = Number(
      ioreg.stdout.match(/"gpu-core-count"\s*=\s*(\d+)/)?.[1],
    );
    return {
      chip: brand.stdout.trim() || fallback.chip,
      superCores,
      performanceCores,
      gpuCores:
        Number.isFinite(gpuCores) && gpuCores > 0 ? gpuCores : undefined,
      totalCores: superCores + performanceCores || os.cpus().length,
    };
  } catch {
    return fallback;
  }
}

/**
 * os.freemem() on macOS reports only completely free pages, which makes the
 * dashboard look almost full all the time. Use vm_stat and count active, wired
 * and compressed pages as used instead.
 */
async function readMemory(): Promise<SystemSnapshot["memory"]> {
  const totalBytes = os.totalmem();
  try {
    const result = await execFileAsync("vm_stat", [], { timeout: 1500 });
    const pageSize = Number(
      result.stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096,
    );
    const pages = (label: string): number => {
      const match = result.stdout.match(new RegExp(`${label}:\\s+(\\d+)`, "i"));
      return match ? Number(match[1]) : 0;
    };
    const usedPages =
      pages("Pages active") +
      pages("Pages wired down") +
      pages("Pages occupied by compressor");
    const usedBytes = usedPages * pageSize;
    if (usedBytes > 0 && usedBytes <= totalBytes)
      return { totalBytes, freeBytes: totalBytes - usedBytes, usedBytes };
  } catch {
    // Fall back to os.freemem() below.
  }
  const freeBytes = os.freemem();
  return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
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

async function readMacmon(hardware: HardwareInfo): Promise<{
  silicon?: SystemSnapshot["silicon"];
  memory?: SystemSnapshot["memory"];
}> {
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
    const memoryData =
      data.memory && typeof data.memory === "object"
        ? (data.memory as Record<string, unknown>)
        : {};
    const fans = Array.isArray(data.fans)
      ? (data.fans as Array<Record<string, unknown>>)
      : [];
    const fanRpm = fans
      .map((fan) => numberOrUndefined(fan.rpm))
      .filter((rpm): rpm is number => rpm !== undefined);
    const usedBytes = numberOrUndefined(memoryData.ram_usage);
    const totalBytes = numberOrUndefined(memoryData.ram_total);
    const pcpuList = Array.isArray(data.pcpu_cores)
      ? (data.pcpu_cores as Array<Record<string, unknown>>)
      : [];
    const ecpuList = Array.isArray(data.ecpu_cores)
      ? (data.ecpu_cores as Array<Record<string, unknown>>)
      : [];
    const pcpuCores = pcpuList.length;
    const ecpuCores = ecpuList.length;
    const coreCount = pcpuCores + ecpuCores;
    const pcpuRatio = numberOrUndefined(data.pcpu_scaled_ratio);
    const ecpuRatio = numberOrUndefined(data.ecpu_scaled_ratio);
    const activeSum = (cores: Array<Record<string, unknown>>): number =>
      cores.reduce(
        (sum, core) =>
          sum + Math.min(numberOrUndefined(core.active_ratio) ?? 0, 1),
        0,
      );
    const pcpuIsSuper =
      !hardware.superCores || pcpuCores === hardware.superCores;
    const pcpuPercent =
      pcpuRatio === undefined
        ? undefined
        : ratioPercent(
            coreCount ? (pcpuRatio * pcpuCores) / coreCount : pcpuRatio,
          );
    const ecpuPercent =
      ecpuRatio === undefined
        ? undefined
        : ratioPercent(
            coreCount ? (ecpuRatio * ecpuCores) / coreCount : ecpuRatio,
          );
    const superActive = pcpuIsSuper ? activeSum(pcpuList) : activeSum(ecpuList);
    const performanceActive = pcpuIsSuper
      ? activeSum(ecpuList)
      : activeSum(pcpuList);
    return {
      silicon: {
        cpuPercent: ratioPercent(data.cpu_usage_pct),
        // Cluster percentages are contributions to total CPU capacity so that
        // P-CPU + S-CPU roughly matches the overall CPU number.
        pcpuPercent,
        ecpuPercent,
        superPercent: pcpuIsSuper ? pcpuPercent : ecpuPercent,
        performancePercent: pcpuIsSuper ? ecpuPercent : pcpuPercent,
        activeCores: superActive + performanceActive,
        superActiveCores: superActive,
        performanceActiveCores: performanceActive,
        gpuPercent: ratioPercent(data.gpu_active_ratio),
        gpuFrequencyMhz: numberOrUndefined(data.gpu_freq_mhz),
        anePercent: ratioPercent(data.ane_active_ratio),
        powerWatts: numberOrUndefined(data.all_power),
        fanRpm: fanRpm.length
          ? fanRpm.reduce((sum, rpm) => sum + rpm, 0) / fanRpm.length
          : undefined,
        cpuTemperatureC: numberOrUndefined(temp.cpu_temp_avg),
        gpuTemperatureC: numberOrUndefined(temp.gpu_temp_avg),
      },
      memory:
        usedBytes !== undefined && totalBytes
          ? {
              totalBytes,
              usedBytes,
              freeBytes: Math.max(totalBytes - usedBytes, 0),
            }
          : undefined,
    };
  } catch {
    return {};
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
