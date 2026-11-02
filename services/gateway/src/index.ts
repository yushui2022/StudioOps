import {
  InferenceGateway,
  type BackendConfig,
  type BackendName,
} from "./gateway.js";
import { MemoryGuard } from "./memory.js";

const GATEWAY_VERSION = "0.1.0";

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

function backend(
  name: BackendName,
  portEnv: string,
  defaultPort: number,
  upstreamEnv: string,
  defaultUpstream: string,
  concurrencyEnv: string,
  defaultConcurrency: number,
  queueEnv: string,
  defaultQueue: number,
): BackendConfig {
  return {
    name,
    listenPort: numberFromEnv(portEnv, defaultPort),
    upstream: urlFromEnv(upstreamEnv, defaultUpstream),
    concurrency: Math.max(1, numberFromEnv(concurrencyEnv, defaultConcurrency)),
    maxQueue: numberFromEnv(queueEnv, defaultQueue),
    queueTimeoutMs: numberFromEnv("STUDIOOPS_GATEWAY_QUEUE_TIMEOUT_MS", 60_000),
    requestTimeoutMs: numberFromEnv(
      "STUDIOOPS_GATEWAY_REQUEST_TIMEOUT_MS",
      10 * 60_000,
    ),
    maxBodyBytes: numberFromEnv(
      "STUDIOOPS_GATEWAY_MAX_BODY_BYTES",
      4 * 1024 * 1024,
    ),
  };
}

const backends: BackendConfig[] = [
  backend(
    "ollama",
    "STUDIOOPS_GATEWAY_OLLAMA_PORT",
    11435,
    "STUDIOOPS_GATEWAY_OLLAMA_UPSTREAM",
    "http://127.0.0.1:11434",
    "STUDIOOPS_GATEWAY_OLLAMA_CONCURRENCY",
    2,
    "STUDIOOPS_GATEWAY_OLLAMA_QUEUE",
    8,
  ),
  backend(
    "comfyui",
    "STUDIOOPS_GATEWAY_COMFY_PORT",
    8191,
    "STUDIOOPS_GATEWAY_COMFY_UPSTREAM",
    "http://127.0.0.1:8190",
    "STUDIOOPS_GATEWAY_COMFY_CONCURRENCY",
    1,
    "STUDIOOPS_GATEWAY_COMFY_QUEUE",
    8,
  ),
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
}

main().catch((error) => {
  console.error("[gateway] start failed", error);
  process.exit(1);
});
