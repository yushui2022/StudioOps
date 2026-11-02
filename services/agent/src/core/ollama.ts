import type {
  OllamaModel,
  OllamaModelsSnapshot,
  ServiceDefinition,
} from "../../../../packages/contracts/src/index.js";

export function ollamaBaseUrl(definition: ServiceDefinition): string {
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
    "Ollama service needs a health endpoint, port or HTTP target",
  );
}

export async function getOllamaModels(
  definition: ServiceDefinition,
): Promise<OllamaModelsSnapshot> {
  const baseUrl = ollamaBaseUrl(definition);
  const [tags, running] = await Promise.all([
    fetchJson(`${baseUrl}/api/tags`),
    fetchJson(`${baseUrl}/api/ps`).catch(() => undefined),
  ]);
  return summarizeOllamaModels(baseUrl, tags, running);
}

/**
 * Merge /api/tags (installed) and /api/ps (loaded) into the model list shown in
 * the drawer. Kept pure so the merge logic is testable without Ollama running.
 */
export function summarizeOllamaModels(
  baseUrl: string,
  tags: unknown,
  running: unknown,
): OllamaModelsSnapshot {
  const installed = Array.isArray((tags as { models?: unknown })?.models)
    ? ((tags as { models: unknown[] }).models as Array<Record<string, unknown>>)
    : [];
  const loadedList = Array.isArray(
    (running as { models?: unknown } | undefined)?.models,
  )
    ? ((running as { models: unknown[] }).models as Array<
        Record<string, unknown>
      >)
    : [];
  const loaded = new Map(
    loadedList.map((model) => [String(model.name ?? model.model ?? ""), model]),
  );

  const models: OllamaModel[] = installed
    .map((model) => {
      const name = String(model.name ?? model.model ?? "");
      const details =
        model.details && typeof model.details === "object"
          ? (model.details as Record<string, unknown>)
          : {};
      const runningModel = loaded.get(name);
      return {
        name,
        sizeBytes: Number(model.size ?? runningModel?.size ?? 0),
        modifiedAt:
          typeof model.modified_at === "string" ? model.modified_at : undefined,
        family: typeof details.family === "string" ? details.family : undefined,
        parameterSize:
          typeof details.parameter_size === "string"
            ? details.parameter_size
            : undefined,
        quantization:
          typeof details.quantization_level === "string"
            ? details.quantization_level
            : undefined,
        loaded: Boolean(runningModel),
        expiresAt:
          typeof runningModel?.expires_at === "string"
            ? runningModel.expires_at
            : undefined,
        vramBytes: numberOrUndefined(runningModel?.size_vram),
        loadedBytes: numberOrUndefined(runningModel?.size),
        capabilities: Array.isArray(model.capabilities)
          ? model.capabilities.filter(
              (value): value is string => typeof value === "string",
            )
          : Array.isArray(runningModel?.capabilities)
            ? runningModel.capabilities.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined,
      };
    })
    .filter((model) => model.name)
    .sort((left, right) => {
      if (left.loaded !== right.loaded) return left.loaded ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return {
    baseUrl,
    models,
    loadedCount: models.filter((model) => model.loaded).length,
    capturedAt: new Date().toISOString(),
  };
}

export type OllamaModelAction = "load" | "unload";

export interface OllamaModelActionRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Ollama has no dedicated load endpoint. Completion models are loaded through
 * /api/generate with an empty prompt; embedding-only models use /api/embed.
 * Unloading uses the same endpoint with keep_alive: 0.
 */
export function ollamaModelActionRequest(
  baseUrl: string,
  model: OllamaModel,
  action: OllamaModelAction,
): OllamaModelActionRequest {
  const embedding = model.capabilities?.includes("embedding") === true;
  const keepAlive = action === "unload" ? 0 : "5m";
  return embedding
    ? {
        url: `${baseUrl}/api/embed`,
        body: { model: model.name, input: [], keep_alive: keepAlive },
      }
    : {
        url: `${baseUrl}/api/generate`,
        body: {
          model: model.name,
          prompt: "",
          stream: false,
          keep_alive: keepAlive,
        },
      };
}

export async function runOllamaModelAction(
  definition: ServiceDefinition,
  model: OllamaModel,
  action: OllamaModelAction,
): Promise<void> {
  const request = ollamaModelActionRequest(
    ollamaBaseUrl(definition),
    model,
    action,
  );
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama ${action} ${model.name} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok)
    throw new Error(`Ollama API ${response.status} ${response.statusText}`);
  return response.json();
}
