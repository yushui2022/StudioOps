import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";

export type ComfyTaskState =
  "running" | "pending" | "success" | "error" | "unknown";

export interface ComfyTask {
  promptId: string;
  number?: number;
  state: ComfyTaskState;
  classTypes: string[];
  preview: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  images: number;
}

export interface ComfyDevice {
  name: string;
  type: string;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
  vramUsedBytes?: number;
}

export interface ComfySnapshot {
  baseUrl: string;
  running: ComfyTask[];
  pending: ComfyTask[];
  history: ComfyTask[];
  device?: ComfyDevice;
  version?: string;
  ramTotalBytes?: number;
  ramFreeBytes?: number;
  capturedAt: string;
}

export function comfyBaseUrl(definition: ServiceDefinition): string {
  if (definition.health?.endpoint) {
    const endpoint = new URL(definition.health.endpoint);
    endpoint.pathname = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  }
  if (definition.port) return `http://127.0.0.1:${definition.port}`;
  if (definition.target.startsWith("http"))
    return definition.target.replace(/\/$/, "");
  throw new Error(
    "ComfyUI service needs a health endpoint, port or HTTP target",
  );
}

export async function getComfySnapshot(
  definition: ServiceDefinition,
): Promise<ComfySnapshot> {
  const baseUrl = comfyBaseUrl(definition);
  const [queue, history, system] = await Promise.all([
    fetchJson(`${baseUrl}/queue`),
    fetchJson(`${baseUrl}/history?max_items=20`),
    fetchJson(`${baseUrl}/system_stats`).catch(() => undefined),
  ]);
  return summarizeComfyState(baseUrl, queue, history, system);
}

export function summarizeComfyState(
  baseUrl: string,
  queue: unknown,
  history: unknown,
  system: unknown,
): ComfySnapshot {
  const queueRecord = asRecord(queue);
  const running = parseQueue(queueRecord?.queue_running, "running").sort(
    (left, right) => (left.number ?? 0) - (right.number ?? 0),
  );
  const pending = parseQueue(queueRecord?.queue_pending, "pending").sort(
    (left, right) => (left.number ?? 0) - (right.number ?? 0),
  );
  const historyRecord = asRecord(history);
  const historyTasks = historyRecord
    ? Object.entries(historyRecord)
        .map(([promptId, value]) => parseHistoryTask(promptId, value))
        .filter((task): task is ComfyTask => Boolean(task))
        .sort((left, right) =>
          (right.finishedAt ?? right.startedAt ?? "").localeCompare(
            left.finishedAt ?? left.startedAt ?? "",
          ),
        )
        .slice(0, 20)
    : [];
  const systemRecord = asRecord(system);
  const devices = Array.isArray(systemRecord?.devices)
    ? systemRecord.devices
        .map((value) => asRecord(value))
        .filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const deviceRecord =
    devices.find(
      (value) =>
        String(value.type).toLowerCase() === "mps" ||
        String(value.name).toLowerCase() === "mps",
    ) ?? devices[0];
  const vramTotal = numberOrUndefined(deviceRecord?.vram_total);
  const vramFree = numberOrUndefined(deviceRecord?.vram_free);
  const device = deviceRecord
    ? {
        name: String(deviceRecord.name ?? "mps"),
        type: String(deviceRecord.type ?? "mps"),
        vramTotalBytes: vramTotal,
        vramFreeBytes: vramFree,
        vramUsedBytes:
          vramTotal !== undefined && vramFree !== undefined
            ? vramTotal - vramFree
            : undefined,
      }
    : undefined;
  return {
    baseUrl,
    running,
    pending,
    history: historyTasks,
    device,
    version:
      typeof systemRecord?.system === "object" &&
      systemRecord.system &&
      typeof (systemRecord.system as Record<string, unknown>)
        .comfyui_version === "string"
        ? String(
            (systemRecord.system as Record<string, unknown>).comfyui_version,
          )
        : undefined,
    ramTotalBytes: numberOrUndefined(asRecord(systemRecord?.system)?.ram_total),
    ramFreeBytes: numberOrUndefined(asRecord(systemRecord?.system)?.ram_free),
    capturedAt: new Date().toISOString(),
  };
}

export async function cancelComfyTask(
  definition: ServiceDefinition,
  promptId: string,
): Promise<"interrupt" | "delete"> {
  const baseUrl = comfyBaseUrl(definition);
  const queue = asRecord(await fetchJson(`${baseUrl}/queue`));
  const running = parseQueue(queue?.queue_running, "running").some(
    (task) => task.promptId === promptId,
  );
  const pending = parseQueue(queue?.queue_pending, "pending").some(
    (task) => task.promptId === promptId,
  );
  if (running) {
    const response = await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`ComfyUI interrupt failed: ${response.status}`);
    return "interrupt";
  }
  if (pending) {
    const response = await fetch(`${baseUrl}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`ComfyUI queue delete failed: ${response.status}`);
    return "delete";
  }
  const history = asRecord(await fetchJson(`${baseUrl}/history?max_items=20`));
  if (history?.[promptId]) throw new Error("该任务已经结束");
  throw new Error("队列中找不到该任务");
}

function parseQueue(value: unknown, state: "running" | "pending"): ComfyTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseQueueEntry(entry, state))
    .filter((task): task is ComfyTask => Boolean(task));
}

function parseQueueEntry(
  value: unknown,
  state: "running" | "pending",
): ComfyTask | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const promptId = String(value[1] ?? "");
  if (!promptId) return undefined;
  const graph = asRecord(value[2]);
  const meta = asRecord(value[3]);
  const createTime = numberOrUndefined(meta?.create_time);
  return {
    promptId,
    number: numberOrUndefined(value[0]),
    state,
    classTypes: classTypes(graph),
    preview: previewOf(graph),
    startedAt:
      state === "running" && createTime
        ? new Date(createTime).toISOString()
        : undefined,
    images: 0,
  };
}

function parseHistoryTask(
  promptId: string,
  value: unknown,
): ComfyTask | undefined {
  const record = asRecord(value);
  const prompt = Array.isArray(record?.prompt) ? record.prompt : [];
  const graph = asRecord(prompt[2]);
  const meta = asRecord(prompt[3]);
  const status = asRecord(record?.status);
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  const statusText = String(status?.status_str ?? "");
  const executionStart = messageTimestamp(messages, [
    "execution_start",
    "execution_cached",
  ]);
  const executionEnd = messageTimestamp(messages, [
    "execution_success",
    "execution_error",
    "execution_interrupted",
  ]);
  const createTime = numberOrUndefined(meta?.create_time);
  const startMs = executionStart ?? createTime;
  const startedAt = startMs ? new Date(startMs).toISOString() : undefined;
  const finishedAt = executionEnd
    ? new Date(executionEnd).toISOString()
    : undefined;
  return {
    promptId,
    number: numberOrUndefined(prompt[0]),
    state:
      statusText === "success"
        ? "success"
        : statusText === "error" || statusText === "interrupted"
          ? "error"
          : "unknown",
    classTypes: classTypes(graph),
    preview: previewOf(graph),
    startedAt,
    finishedAt,
    durationMs:
      executionStart && executionEnd
        ? executionEnd - executionStart
        : undefined,
    images: outputImageCount(record?.outputs),
  };
}

function previewOf(graph: Record<string, unknown> | undefined): string {
  if (!graph) return "";
  for (const value of Object.values(graph)) {
    const node = asRecord(value);
    const inputs = asRecord(node?.inputs);
    if (!inputs) continue;
    for (const key of ["prompt", "text", "positive", "negative"]) {
      const text = inputs[key];
      if (typeof text === "string" && text.trim() && text !== "undefined")
        return text.replace(/\s+/g, " ").trim().slice(0, 240);
    }
  }
  return "";
}

function classTypes(graph: Record<string, unknown> | undefined): string[] {
  if (!graph) return [];
  const types = Object.values(graph)
    .map((value) => asRecord(value)?.class_type)
    .filter((value): value is string => typeof value === "string");
  return [...new Set(types)];
}

function outputImageCount(outputs: unknown): number {
  const record = asRecord(outputs);
  if (!record) return 0;
  let count = 0;
  for (const value of Object.values(record)) {
    const output = asRecord(value);
    if (!output) continue;
    for (const key of ["images", "gifs", "videos"]) {
      if (Array.isArray(output[key])) count += output[key].length;
    }
  }
  return count;
}

function messageTimestamp(
  messages: unknown[],
  types: string[],
): number | undefined {
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue;
    if (!types.includes(String(message[0]))) continue;
    const data = asRecord(message[1]);
    const timestamp = numberOrUndefined(data?.timestamp);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok)
    throw new Error(`ComfyUI API ${response.status} ${response.statusText}`);
  return response.json();
}
