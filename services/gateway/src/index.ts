import {
  InferenceGateway,
  type BackendConfig,
  type BackendName,
} from "./gateway.js";
import { MemoryGuard } from "./memory.js";
import { join } from "node:path";

const GATEWAY_VERSION = "0.1.2";
const recordsFile =
  process.env.STUDIOOPS_GATEWAY_RECORDS_FILE ??
  join(process.cwd(), "data", "gateway", "model-calls.jsonl");

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return Math.floor(value);
}

function urlFromEnv(name: string, fallback: string): URL {
  const raw = process.env[name]?.trim() || fallback;
  return new URL(raw.includes("://") ? raw : `http://${raw}`);
}

interface BackendOptions {
  name: BackendName;
  portEnv: string;
  defaultPort: number;
  upstreamEnv: string;
  defaultUpstream: string;
  concurrencyEnv: string;
  defaultConcurrency: number;
  queueEnv: string;
  defaultQueue: number;
  queueTimeoutEnv: string;
  defaultQueueTimeoutMs: number;
  requestTimeoutEnv: string;
  defaultRequestTimeoutMs: number;
  maxBodyEnv: string;
  defaultMaxBodyBytes: number;
}

function backend(options: BackendOptions): BackendConfig {
  const legacyQueueTimeout = numberFromEnv(
    "STUDIOOPS_GATEWAY_QUEUE_TIMEOUT_MS",
    options.defaultQueueTimeoutMs,
  );
  const legacyRequestTimeout = numberFromEnv(
    "STUDIOOPS_GATEWAY_REQUEST_TIMEOUT_MS",
    options.defaultRequestTimeoutMs,
  );
  const legacyMaxBody = numberFromEnv(
    "STUDIOOPS_GATEWAY_MAX_BODY_BYTES",
    options.defaultMaxBodyBytes,
  );
  return {
    name: options.name,
    listenPort: numberFromEnv(options.portEnv, options.defaultPort),
    upstream: urlFromEnv(options.upstreamEnv, options.defaultUpstream),
    concurrency: Math.max(
      1,
      numberFromEnv(options.concurrencyEnv, options.defaultConcurrency),
    ),
    maxQueue: numberFromEnv(options.queueEnv, options.defaultQueue),
    queueTimeoutMs: numberFromEnv(options.queueTimeoutEnv, legacyQueueTimeout),
    requestTimeoutMs: numberFromEnv(
      options.requestTimeoutEnv,
      legacyRequestTimeout,
    ),
    maxBodyBytes: numberFromEnv(options.maxBodyEnv, legacyMaxBody),
  };
}

const backends: BackendConfig[] = [
  backend({
    name: "ollama",
    portEnv: "STUDIOOPS_GATEWAY_OLLAMA_PORT",
    defaultPort: 11435,
    upstreamEnv: "STUDIOOPS_GATEWAY_OLLAMA_UPSTREAM",
    defaultUpstream: "http://127.0.0.1:11434",
    concurrencyEnv: "STUDIOOPS_GATEWAY_OLLAMA_CONCURRENCY",
    defaultConcurrency: 2,
    queueEnv: "STUDIOOPS_GATEWAY_OLLAMA_QUEUE",
    defaultQueue: 8,
    queueTimeoutEnv: "STUDIOOPS_GATEWAY_OLLAMA_QUEUE_TIMEOUT_MS",
    defaultQueueTimeoutMs: 60_000,
    requestTimeoutEnv: "STUDIOOPS_GATEWAY_OLLAMA_REQUEST_TIMEOUT_MS",
    defaultRequestTimeoutMs: 10 * 60_000,
    maxBodyEnv: "STUDIOOPS_GATEWAY_OLLAMA_MAX_BODY_BYTES",
    defaultMaxBodyBytes: 4 * 1024 * 1024,
  }),
  backend({
    name: "comfyui",
    portEnv: "STUDIOOPS_GATEWAY_COMFY_PORT",
    defaultPort: 8191,
    upstreamEnv: "STUDIOOPS_GATEWAY_COMFY_UPSTREAM",
    defaultUpstream: "http://127.0.0.1:8190",
    concurrencyEnv: "STUDIOOPS_GATEWAY_COMFY_CONCURRENCY",
    defaultConcurrency: 1,
    queueEnv: "STUDIOOPS_GATEWAY_COMFY_QUEUE",
    defaultQueue: 8,
    queueTimeoutEnv: "STUDIOOPS_GATEWAY_COMFY_QUEUE_TIMEOUT_MS",
    // A 2048px ComfyUI job can take more than 10 minutes.
    defaultQueueTimeoutMs: 30 * 60_000,
    requestTimeoutEnv: "STUDIOOPS_GATEWAY_COMFY_REQUEST_TIMEOUT_MS",
    defaultRequestTimeoutMs: 30 * 60_000,
    // Image edits send multipart reference images; 4MB is too small.
    maxBodyEnv: "STUDIOOPS_GATEWAY_COMFY_MAX_BODY_BYTES",
    defaultMaxBodyBytes: 32 * 1024 * 1024,
  }),
];

const memoryGuard = new MemoryGuard({
  ollamaUpstream:
    backends.find((backend) => backend.name === "ollama")?.upstream ??
    new URL("http://127.0.0.1:11434"),
});

const gateway = new InferenceGateway(
  {
    backends,
    adminPort: numberFromEnv("STUDIOOPS_GATEWAY_ADMIN_PORT", 11436),
    host: "127.0.0.1",
    version: GATEWAY_VERSION,
    admission: memoryGuard,
    recordsFile,
  },
  (message) => console.log(message),
);

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[gateway] ${signal} received, shutting down`);
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  memoryGuard.stop();
  await gateway.close();
  clearTimeout(timeout);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  await memoryGuard.start();
  await gateway.start();
  console.log(`[gateway] model calls ${recordsFile}`);
}

main().catch((error) => {
  console.error("[gateway] start failed", error);
  process.exit(1);
});
