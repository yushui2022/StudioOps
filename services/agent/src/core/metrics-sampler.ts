import type {
  ServiceSnapshot,
  SystemSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { MetricSample, MetricsStore } from "./metrics-store.js";

export interface MetricsSource {
  system(): Promise<SystemSnapshot>;
  services(): Promise<ServiceSnapshot[]>;
}

export function buildMetricSamples(
  system: SystemSnapshot,
  services: ServiceSnapshot[],
  ts = Date.now(),
): MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (
    scope: "system" | "service",
    scopeId: string,
    metric: string,
    value: number | undefined,
    unit?: string,
  ) => {
    if (value === undefined || !Number.isFinite(value)) return;
    samples.push({ ts, scope, scopeId, metric, value, unit });
  };

  const silicon = system.silicon;
  add("system", "local", "cpu.percent", silicon?.cpuPercent, "%");
  add("system", "local", "cpu.p.percent", silicon?.pcpuPercent, "%");
  add("system", "local", "cpu.e.percent", silicon?.ecpuPercent, "%");
  add("system", "local", "gpu.percent", silicon?.gpuPercent, "%");
  add("system", "local", "ane.percent", silicon?.anePercent, "%");
  add("system", "local", "power.watts", silicon?.powerWatts, "W");
  add("system", "local", "fan.rpm", silicon?.fanRpm, "rpm");
  add("system", "local", "temp.cpu.c", silicon?.cpuTemperatureC, "°C");
  add("system", "local", "temp.gpu.c", silicon?.gpuTemperatureC, "°C");
  add("system", "local", "load.1", system.load[0], "");

  const memoryTotal = system.memory.totalBytes;
  const memoryUsed = system.memory.usedBytes;
  add("system", "local", "memory.total.bytes", memoryTotal, "bytes");
  add("system", "local", "memory.used.bytes", memoryUsed, "bytes");
  if (memoryUsed !== undefined && memoryTotal > 0)
    add(
      "system",
      "local",
      "memory.percent",
      (memoryUsed / memoryTotal) * 100,
      "%",
    );

  add("system", "local", "disk.total.bytes", system.disk?.totalBytes, "bytes");
  add("system", "local", "disk.free.bytes", system.disk?.freeBytes, "bytes");
  if (system.disk && system.disk.totalBytes > 0)
    add(
      "system",
      "local",
      "disk.free.percent",
      (system.disk.freeBytes / system.disk.totalBytes) * 100,
      "%",
    );

  for (const service of services) {
    add(
      "service",
      service.id,
      "up",
      ["running", "paused"].includes(service.state) ? 1 : 0,
      "",
    );
    if (service.healthState === "healthy")
      add("service", service.id, "health.up", 1, "");
    else if (service.healthState === "unhealthy")
      add("service", service.id, "health.up", 0, "");
    add("service", service.id, "cpu.percent", service.cpuPercent, "%");
    add("service", service.id, "memory.bytes", service.memoryBytes, "bytes");
  }

  return samples;
}

export class MetricsSampler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private busy = false;

  constructor(
    private readonly store: MetricsStore,
    private readonly source: MetricsSource,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly onSample:
      | ((
          system: SystemSnapshot,
          services: ServiceSnapshot[],
          ts: number,
        ) => void)
      | undefined = undefined,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async sampleNow(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const [system, services] = await Promise.all([
        this.source.system(),
        this.source.services(),
      ]);
      this.store.insert(buildMetricSamples(system, services, now));
      this.onSample?.(system, services, now);
    } catch (error) {
      this.onError(error);
    } finally {
      this.busy = false;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sampleNow().finally(() => {
        if (!this.stopped) this.schedule(this.store.getSettings().intervalMs);
      });
    }, delay);
  }
}
