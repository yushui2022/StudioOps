import net from "node:net";
import type {
  HealthState,
  ServiceDefinition,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";

export async function withHealth(
  definition: ServiceDefinition,
  snapshot: ServiceSnapshot,
): Promise<ServiceSnapshot> {
  if (snapshot.state !== "running")
    return {
      ...snapshot,
      healthState: "unknown",
      healthMessage: "not running",
    };
  if (!definition.health || definition.health.type === "none")
    return { ...snapshot, healthState: "unknown" };
  if (definition.health.type === "process")
    return {
      ...snapshot,
      healthState: snapshot.state === "running" ? "healthy" : "unhealthy",
      healthMessage: snapshot.state,
    };
  if (!definition.health.endpoint)
    return {
      ...snapshot,
      healthState: "unknown",
      healthMessage: "No health endpoint configured",
    };
  try {
    if (definition.health.type === "http") {
      const response = await fetch(definition.health.endpoint, {
        signal: AbortSignal.timeout(1500),
      });
      const payload = response.headers.get("content-type")?.includes("json")
        ? await response.json().catch(() => undefined)
        : undefined;
      return {
        ...snapshot,
        healthState: response.ok ? "healthy" : "unhealthy",
        healthMessage: `${response.status} ${response.statusText}`,
        details: summarizeDetails(definition, payload),
      };
    }
    await checkTcp(definition.health.endpoint);
    return {
      ...snapshot,
      healthState: "healthy",
      healthMessage: "TCP connection accepted",
    };
  } catch (error) {
    return {
      ...snapshot,
      healthState: "unhealthy",
      healthMessage:
        error instanceof Error ? error.message : "Health check failed",
    };
  }
}

function summarizeDetails(
  definition: ServiceDefinition,
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (definition.kind === "ollama" && Array.isArray(record.models)) {
    return {
      modelCount: record.models.length,
      models: record.models
        .map((model) =>
          model && typeof model === "object"
            ? (model as Record<string, unknown>).name
            : undefined,
        )
        .filter(Boolean),
    };
  }
  if (definition.kind === "comfyui") {
    const devices = Array.isArray(record.devices)
      ? record.devices
          .map((device) =>
            device && typeof device === "object"
              ? (device as Record<string, unknown>).name
              : undefined,
          )
          .filter(Boolean)
      : [];
    return { version: record.comfyui_version, devices };
  }
  return undefined;
}

function checkTcp(endpoint: string): Promise<void> {
  const url = new URL(
    endpoint.includes("://") ? endpoint : `tcp://${endpoint}`,
  );
  const port = Number(url.port || 80);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP health check timed out"));
    }, 1500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
