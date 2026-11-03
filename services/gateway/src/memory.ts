import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { BackendName } from "./gateway.js";
import { sameResidentModel } from "./usage.js";

const execFileAsync = promisify(execFile);

export interface SystemMemory {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface MemorySnapshot extends SystemMemory {
  percent: number;
  budgetBytes: number;
  reserveBytes: number;
  pressure: "normal" | "elevated" | "high";
  updatedAt?: string;
  error?: string;
  ollama: {
    loadedModels: string[];
    maxLoadedModels: number;
  };
}

export interface AdmissionRequest {
  backend: BackendName;
  method: string;
  path: string;
  model?: string;
  activeModels?: string[];
}

export interface AdmissionDecision {
  allowed: boolean;
  code?: "memory" | "model-slot";
  reason?: string;
  snapshot?: MemorySnapshot;
}

export interface MemoryAdmission {
  status(): MemorySnapshot;
  /** Cheap fail-fast check used when a request enters the queue. */
  precheck?(request: AdmissionRequest): AdmissionDecision;
  /** Full check used right before a request starts executing. */
  admit(
    request: AdmissionRequest,
  ): AdmissionDecision | Promise<AdmissionDecision>;
}

export interface MemoryGuardOptions {
  ollamaUpstream: URL;
  maxLoadedModels?: number;
  reserveBytes?: number;
  budgetBytes?: number;
  sampleIntervalMs?: number;
  loadedModelIntervalMs?: number;
  readMemory?: () => Promise<SystemMemory>;
  fetchImpl?: typeof fetch;
}

/**
 * Admission control for the inference gateway. macOS has no per-process hard
 * memory cap, so the gateway refuses new model work before the machine swaps
 * or the kernel kills a process. Decisions use a short-lived cached sample so
 * the queue path stays synchronous.
 */
export class MemoryGuard implements MemoryAdmission {
  private snapshot: MemorySnapshot;
  private sampleTimer?: NodeJS.Timeout;
  private modelTimer?: NodeJS.Timeout;
  private sampling = false;
  private refreshingModels = false;
  private unloadQueue: Promise<unknown> = Promise.resolve();
  private readonly readMemory: () => Promise<SystemMemory>;
  private readonly fetchImpl: typeof fetch;
  private readonly reserveBytes: number;
  private readonly budgetBytes: number;
  private readonly maxLoadedModels: number;
  private readonly sampleIntervalMs: number;
  private readonly loadedModelIntervalMs: number;
  private loadedModels: string[] = [];

  constructor(private readonly options: MemoryGuardOptions) {
    const totalBytes = os.totalmem();
    const configuredReserve = Number(
      process.env.STUDIOOPS_GATEWAY_MEMORY_RESERVE_BYTES ?? 0,
    );
    this.reserveBytes =
      options.reserveBytes ??
      (configuredReserve > 0 ? configuredReserve : 12 * 1024 ** 3);
    const configuredBudget = Number(
      process.env.STUDIOOPS_GATEWAY_MEMORY_BUDGET_BYTES ?? 0,
    );
    this.budgetBytes =
      options.budgetBytes ??
      (configuredBudget > 0
        ? configuredBudget
        : Math.max(8 * 1024 ** 3, totalBytes - this.reserveBytes));
    this.maxLoadedModels =
      options.maxLoadedModels ??
      (Number(process.env.STUDIOOPS_GATEWAY_MAX_LOADED_MODELS ?? 0) > 0
        ? Number(process.env.STUDIOOPS_GATEWAY_MAX_LOADED_MODELS)
        : 1);
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2000;
    this.loadedModelIntervalMs = options.loadedModelIntervalMs ?? 5000;
    this.readMemory = options.readMemory ?? readSystemMemory;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.snapshot = {
      totalBytes,
      usedBytes: 0,
      freeBytes: totalBytes,
      percent: 0,
      budgetBytes: this.budgetBytes,
      reserveBytes: this.reserveBytes,
      pressure: "normal",
      ollama: {
        loadedModels: [],
        maxLoadedModels: this.maxLoadedModels,
      },
    };
  }

  async start(): Promise<void> {
    await Promise.all([this.sample(), this.refreshLoadedModels()]);
    this.sampleTimer = setInterval(
      () => void this.sample(),
      this.sampleIntervalMs,
    );
    this.sampleTimer.unref?.();
    this.modelTimer = setInterval(
      () => void this.refreshLoadedModels(),
      this.loadedModelIntervalMs,
    );
    this.modelTimer.unref?.();
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.modelTimer) clearInterval(this.modelTimer);
  }

  status(): MemorySnapshot {
    return {
      ...this.snapshot,
      ollama: {
        loadedModels: [...this.loadedModels],
        maxLoadedModels: this.maxLoadedModels,
      },
    };
  }

  precheck(request: AdmissionRequest): AdmissionDecision {
    if (!isMemoryInfluencing(request)) return { allowed: true };
    return (
      this.memoryDecision(request) ?? { allowed: true, snapshot: this.status() }
    );
  }

  async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
    if (!isMemoryInfluencing(request)) return { allowed: true };
    if (request.backend === "ollama" && request.model) {
      await this.releaseIdleModels(request);
    } else if (
      (request.backend === "comfyui" || request.backend === "video") &&
      this.memoryDecision(request)
    ) {
      await this.releaseIdleModels(request);
    }

    const memoryDenied = this.memoryDecision(request);
    if (memoryDenied) return memoryDenied;
    if (request.backend !== "ollama" || !request.model)
      return { allowed: true, snapshot: this.status() };

    const slot = this.slotDecision(request);
    if (!slot) return { allowed: true, snapshot: this.status() };
    const blocking = [
      ...this.loadedModels,
      ...(request.activeModels ?? []),
    ].filter((name) => !sameResidentModel(request.model ?? "", name));
    return {
      ...slot,
      reason: blocking.length
        ? `内存准入：${blocking.join("、")} 正在占用唯一模型槽，请等它结束后再调用 ${request.model}`
        : slot.reason,
    };
  }

  /**
   * One resident Ollama model. A request for a different model unloads the
   * idle one first. A model that still has a request in flight stays loaded.
   */
  private async releaseIdleModels(request: AdmissionRequest): Promise<void> {
    const active = request.activeModels ?? [];
    const targets = this.loadedModels.filter((loaded) => {
      if (active.some((name) => sameResidentModel(name, loaded))) return false;
      if (
        request.backend === "ollama" &&
        request.model &&
        sameResidentModel(request.model, loaded)
      )
        return false;
      return true;
    });
    for (const model of targets) await this.enqueueUnload(model);
    if (targets.length > 0) await this.sample();
  }

  /**
   * The model slot counts both loaded models and models with a request in
   * flight, so two concurrent requests cannot load two models after one unload.
   */
  private slotDecision(
    request: AdmissionRequest,
  ): AdmissionDecision | undefined {
    if (request.backend !== "ollama" || !request.model) return undefined;
    const names = [...this.loadedModels, ...(request.activeModels ?? [])];
    const distinct: string[] = [];
    for (const name of names) {
      if (!distinct.some((item) => sameResidentModel(item, name)))
        distinct.push(name);
    }
    const requestedResident = distinct.some((name) =>
      sameResidentModel(request.model ?? "", name),
    );
    if (distinct.length < this.maxLoadedModels || requestedResident)
      return undefined;
    const effective = new Set(distinct);
    return {
      allowed: false,
      code: "model-slot",
      reason: `内存准入：Ollama 已加载或正在加载 ${effective.size} 个模型（上限 ${this.maxLoadedModels}），请求的 ${request.model} 需要额外加载`,
      snapshot: this.status(),
    };
  }

  private memoryDecision(
    request?: AdmissionRequest,
  ): AdmissionDecision | undefined {
    const snapshot = this.status();
    if (snapshot.totalBytes <= 0) return undefined;
    // A request to an already-loaded Ollama model does not allocate another
    // model, so it stays available while the machine is within the hard floor.
    const warm =
      request?.backend === "ollama" &&
      Boolean(
        request.model &&
          this.loadedModels.some((model) =>
            sameResidentModel(request.model ?? "", model),
          ),
      );
    const minimumFreeBytes = Number(
      process.env.STUDIOOPS_GATEWAY_MEMORY_MIN_FREE_BYTES ?? 2 * 1024 ** 3,
    );
    const comfyMinimumFreeBytes = Number(
      process.env.STUDIOOPS_GATEWAY_COMFY_MIN_FREE_BYTES ?? 24 * 1024 ** 3,
    );
    if (
      request?.backend === "comfyui" &&
      snapshot.freeBytes < comfyMinimumFreeBytes
    ) {
      return {
        allowed: false,
        code: "memory",
        reason: `内存准入：ComfyUI 需要至少 ${formatBytes(comfyMinimumFreeBytes)} 可用内存，当前仅 ${formatBytes(snapshot.freeBytes)}；请先卸载空闲 Ollama 模型或等待其他任务结束`,
        snapshot,
      };
    }
    const videoMinimumFreeBytes = Number(
      process.env.STUDIOOPS_GATEWAY_VIDEO_MIN_FREE_BYTES ?? 30 * 1024 ** 3,
    );
    if (
      request?.backend === "video" &&
      snapshot.freeBytes < videoMinimumFreeBytes
    ) {
      return {
        allowed: false,
        code: "memory",
        reason: `内存准入：H3 视频需要至少 ${formatBytes(videoMinimumFreeBytes)} 可用内存，当前仅 ${formatBytes(snapshot.freeBytes)}；请先卸载空闲 Ollama 模型`,
        snapshot,
      };
    }
    const critical =
      snapshot.percent >= 96 || snapshot.freeBytes < minimumFreeBytes;
    if (!critical && (warm || snapshot.usedBytes < snapshot.budgetBytes))
      return undefined;
    return {
      allowed: false,
      code: "memory",
      reason: critical
        ? `内存准入：系统可用内存仅 ${formatBytes(snapshot.freeBytes)}（已用 ${snapshot.percent.toFixed(1)}%），低于硬性安全线 ${formatBytes(minimumFreeBytes)}`
        : `内存准入：已用 ${formatBytes(snapshot.usedBytes)}（${snapshot.percent.toFixed(1)}%），超过推理预算 ${formatBytes(snapshot.budgetBytes)}；为系统保留 ${formatBytes(snapshot.reserveBytes)}`,
      snapshot,
    };
  }

  private enqueueUnload(model: string): Promise<boolean> {
    const task = this.unloadQueue.then(() => this.unloadModel(model));
    this.unloadQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async unloadModel(model: string): Promise<boolean> {
    const attempts: Array<{ path: string; body: Record<string, unknown> }> = [
      {
        path: "/api/generate",
        body: { model, prompt: "", stream: false, keep_alive: 0 },
      },
      {
        path: "/api/embed",
        body: { model, input: [], keep_alive: 0 },
      },
    ];
    for (const attempt of attempts) {
      try {
        const response = await this.fetchImpl(
          new URL(attempt.path, this.options.ollamaUpstream),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(attempt.body),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) continue;
        if (await this.waitForUnload(model)) return true;
      } catch {
        // Try the next endpoint.
      }
    }
    return false;
  }

  private async waitForUnload(model: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.refreshLoadedModels();
      if (!this.loadedModels.includes(model)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const memory = await this.readMemory();
      if (memory.totalBytes <= 0) return;
      const usedBytes = Math.min(memory.usedBytes, memory.totalBytes);
      const percent = (usedBytes / memory.totalBytes) * 100;
      const pressure =
        usedBytes >= this.budgetBytes || percent >= 92
          ? "high"
          : percent >= 85 || memory.freeBytes <= this.reserveBytes * 1.3
            ? "elevated"
            : "normal";
      this.snapshot = {
        ...memory,
        totalBytes: memory.totalBytes,
        usedBytes,
        freeBytes: memory.totalBytes - usedBytes,
        percent,
        budgetBytes: this.budgetBytes,
        reserveBytes: this.reserveBytes,
        pressure,
        updatedAt: new Date().toISOString(),
        ollama: {
          loadedModels: [...this.loadedModels],
          maxLoadedModels: this.maxLoadedModels,
        },
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
    } finally {
      this.sampling = false;
    }
  }

  private async refreshLoadedModels(): Promise<void> {
    if (this.refreshingModels) return;
    this.refreshingModels = true;
    try {
      const response = await this.fetchImpl(
        new URL("/api/ps", this.options.ollamaUpstream),
        { signal: AbortSignal.timeout(1500) },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      this.loadedModels = (payload.models ?? [])
        .map((model) => model.name ?? model.model ?? "")
        .filter(Boolean);
      this.snapshot = {
        ...this.snapshot,
        ollama: {
          loadedModels: [...this.loadedModels],
          maxLoadedModels: this.maxLoadedModels,
        },
      };
    } catch {
      // Ollama may be stopped; keep the last known loaded models.
    } finally {
      this.refreshingModels = false;
    }
  }
}

const OLLAMA_MEMORY_PATHS = new Set([
  "/api/generate",
  "/api/chat",
  "/api/embed",
  "/api/embeddings",
  "/api/pull",
  "/api/create",
  "/api/copy",
  // Ollama also exposes OpenAI-compatible endpoints; external Sub2API traffic
  // uses these paths, so they must go through admission too.
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

const COMFY_MEMORY_PATHS = new Set([
  "/prompt",
  "/api/prompt",
  "/queue",
  "/v1/images/generations",
]);

const VIDEO_MEMORY_PATHS = new Set([
  "/v1/videos/generations",
  "/videos/generations",
]);

function isMemoryInfluencing(request: AdmissionRequest): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  let pathname: string;
  try {
    pathname = new URL(request.path, "http://127.0.0.1").pathname;
  } catch {
    pathname = request.path.split("?")[0] ?? request.path;
  }
  if (request.backend === "ollama") return OLLAMA_MEMORY_PATHS.has(pathname);
  if (request.backend === "video") return VIDEO_MEMORY_PATHS.has(pathname);
  return COMFY_MEMORY_PATHS.has(pathname);
}

/** Parse the model name from a JSON request body without retaining the body. */
export function extractModel(body: Buffer): string | undefined {
  if (!body.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * os.freemem() on macOS only counts completely free pages. vm_stat gives a
 * usable view by treating active, wired and compressed pages as used.
 */
export async function readSystemMemory(): Promise<SystemMemory> {
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
    if (usedBytes > 0 && usedBytes <= totalBytes) {
      return {
        totalBytes,
        usedBytes,
        freeBytes: totalBytes - usedBytes,
      };
    }
  } catch {
    // Fall back to os.freemem() below.
  }
  const freeBytes = os.freemem();
  return { totalBytes, usedBytes: totalBytes - freeBytes, freeBytes };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}
